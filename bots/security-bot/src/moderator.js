/**
 * Moderations-Pipeline des Sicherheitsbots.
 *
 * Ablauf:
 *   Buffer voll (Token-Limit) oder 2-Stunden-Flush
 *     → Batch mit IDs ab 1 → Gemini (System-Prompt + Admin-Prompt + Verlauf)
 *     → Antwort parsen → Maßnahmen anwenden → Log-Kanal informieren
 *
 * Zuverlässigkeit ("Nicht einfach aufgeben"):
 * - Bei API-Fehlern/Rate-Limits bleibt der Batch VOLLSTÄNDIG erhalten und wird
 *   mit wachsendem Abstand erneut versucht (2m → 5m → 15m → … → max. 6h).
 * - Neue Nachrichten sammeln sich derweil ganz normal im Buffer.
 * - Wurde niemand moderiert, passiert GAR NICHTS: Der Bot schreibt in diesem
 *   Fall keine einzige Nachricht in den Chat (kein Small-Talk, keine
 *   Entwarnung, kein Gruß). Nur echte Moderationen erzeugen einen Post.
 * - Administratoren sind im Batch nur Kontext (keine ID) und werden bei der
 *   Anwendung zusätzlich noch einmal live geprüft und notfalls übersprungen.
 */

const { PermissionFlagsBits } = require('discord.js');
const {
  callGemini,
  extractResponseText,
  parseModerationJson,
  estimateTokens,
} = require('./gemini');
const {
  buildSystemPrompt,
  buildUserPrompt,
  buildChatLog,
  buildTargetedDirectives,
  buildOrderDirectives,
  DURATION_SECONDS,
} = require('./prompts');
const {
  smallContainer,
  clip,
  buildModerationLogContainer,
  buildApiErrorContainer,
  buildNoKeyContainer,
} = require('./embed-builder');
const { sendLogNotice } = require('./notices');
const { t, tzFor } = require('./languages');
const { reserveGeminiSlot, noteGemini429 } = require('./rate-limit');

const MAX_MODERATIONS_PER_BATCH = 10;
const NO_KEY_RETRY_MS = 6 * 60 * 60 * 1000;
// Backoff für fehlgeschlagene Batches (Index = retryCount - 1)
const BACKOFF_SCHEDULE_MS = [
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
];

// Ein-Flug-Steuerung pro Gilde (mehrere parallele Gemini-Aufrufe pro Server vermeiden)
const runningByGuild = new Set();
const rerunRequested = new Set();

// /security_check_now wartet höchstens 10s (40 × 250ms) darauf, dass ein
// bereits laufender Dispatch (z. B. vom Scheduler) fertig wird, bevor der
// Befehl selbst verarbeitet bzw. sein Ergebnis meldet.
const CHECK_NOW_POLL_MS = 250;
const CHECK_NOW_MAX_WAIT_TICKS = 40;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextRetryDelay(retryCount) {
  const index = Math.max(0, Number(retryCount) - 1);
  return BACKOFF_SCHEDULE_MS[Math.min(index, BACKOFF_SCHEDULE_MS.length - 1)];
}

function fmtDateTime(ms, lang) {
  try {
    return new Intl.DateTimeFormat('de-DE', {
      timeZone: tzFor(lang),
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function updateBatch(ctx, guildId, batchMeta) {
  const batches = ctx.store.getBatches(guildId);
  const index = batches.findIndex((b) => b.id === batchMeta.id);
  if (index >= 0) {
    batches[index] = batchMeta;
    ctx.store.setBatches(guildId, batches);
  }
}

/**
 * Verarbeitet fällige Batches einer Gilde (FIFO). Läuft nie doppelt parallel:
 * Während ein Lauf aktiv ist, wird ein Folgelauf über rerunRequested vorgemerkt.
 */
async function processGuild(ctx, guildId) {
  const gid = String(guildId);
  if (runningByGuild.has(gid)) {
    rerunRequested.add(gid);
    return false;
  }
  runningByGuild.add(gid);
  let queueEmpty = false;
  try {
    for (;;) {
      const now = Date.now();
      const due = ctx.store.getBatches(gid).find((b) => (b.nextRetryAt || 0) <= now);
      if (!due) {
        // "true" nur, wenn wirklich keine Batches mehr warten (auch nicht auf einen Retry)
        queueEmpty = ctx.store.getBatches(gid).length === 0;
        break;
      }
      const ok = await processSingleBatch(ctx, gid, due);
      if (!ok) break; // Fehler → Backoff läuft, späterer Versuch übernimmt
    }
  } catch (err) {
    ctx.logger?.error?.('[security-bot] Fehler im Dispatch von Gilde ' + gid + ':', err?.message || err);
  } finally {
    runningByGuild.delete(gid);
    if (rerunRequested.delete(gid)) {
      setImmediate(() => {
        void processGuild(ctx, gid);
      });
    }
  }
  return queueEmpty;
}

/** Verschiebt den offenen Buffer in einen Batch und startet die Analyse. */
function flushBuffer(ctx, guildId) {
  const batch = ctx.store.buildBatchFromBuffer(guildId);
  if (!batch) return null;
  void ctx.store.flush();
  void processGuild(ctx, guildId);
  return batch;
}

/** Steht ein Nutzer (authorId) irgendwo in Buffer oder wartenden Batches? */
function pendingHasAuthor(store, gid, authorId) {
  const id = String(authorId);
  for (const rec of store.getBuffer(gid)) {
    if (rec.authorId === id) return true;
  }
  for (const batch of store.getBatches(gid)) {
    for (const rec of store.getBatchMessages(gid, batch.id)) {
      if (rec.authorId === id) return true;
    }
  }
  return false;
}

/**
 * /security_check_now – wertet ALLE aktuell wartenden Nachrichten einer Gilde
 * SOFORT aus: Der offene Buffer wird (auch unterhalb des Token-Limits) zu
 * einem Batch gemacht, UND alle bereits wartenden Retry-Batches (Backoff
 * nach einem vorherigen API-Fehler) werden sofort fällig gestellt – Admins
 * müssen also nicht bis zum nächsten geplanten Retry (der bei anhaltenden
 * Fehlern Stunden entfernt sein kann) warten, um eine Konfigurationsänderung
 * (z. B. neuer Key oder neues Modell) zu testen.
 *
 * `forceUser` (optional): { id, name } – Nutzer, der bei dieser Prüfung
 * ZWINGEND moderiert werden soll (/security_check_now user). Die Direktive
 * wird an alle fälligen Batches geheftet und landet als verbindlicher Abschnitt
 * im System-Prompt (buildSystemPrompt). Sie überlebt bewusst auch Retries
 * desselben Batches: Der Auftrag gilt, bis die Analyse einmal durchgelaufen ist.
 *
 * Wartet (im Gegensatz zu flushBuffer/processGuild) auf den tatsächlichen
 * Abschluss des Laufs, damit der Slash-Command ein verlässliches Ergebnis
 * melden kann.
 */
async function runCheckNow(ctx, guildId, { forceUser } = {}) {
  const gid = String(guildId);
  const beforePending = ctx.store.countPendingMessages(gid);
  if (beforePending === 0) {
    return { empty: true, analyzed: 0, remaining: 0, forcedSeen: false };
  }

  // Kommt der Zwangsnutzer überhaupt in den wartenden Nachrichten vor?
  // (Ohne eine einzige Nachricht von ihm kann auch die Direktive nichts moderieren.)
  const forcedSeen = forceUser ? pendingHasAuthor(ctx.store, gid, forceUser.id) : false;

  ctx.store.buildBatchFromBuffer(gid);
  const batches = ctx.store.getBatches(gid);
  if (batches.length) {
    for (const batch of batches) {
      batch.nextRetryAt = 0;
      if (forceUser && forcedSeen) {
        batch.forceUser = {
          id: String(forceUser.id),
          name: String(forceUser.name || forceUser.id).replace(/\s+/g, ' ').slice(0, 100),
        };
      }
    }
    ctx.store.setBatches(gid, batches);
  }
  void ctx.store.flush();

  // Läuft bereits ein Dispatch (z. B. vom 30s-Scheduler angestoßen), merkt
  // processGuild() nur einen Folgelauf vor und kehrt sofort zurück. Kurz
  // abwarten, damit /security_check_now nicht mit veraltetem Ergebnis endet.
  for (let tick = 0; runningByGuild.has(gid) && tick < CHECK_NOW_MAX_WAIT_TICKS; tick++) {
    await sleep(CHECK_NOW_POLL_MS);
  }

  await processGuild(ctx, gid);

  for (let tick = 0; runningByGuild.has(gid) && tick < CHECK_NOW_MAX_WAIT_TICKS; tick++) {
    await sleep(CHECK_NOW_POLL_MS);
  }

  const remaining = ctx.store.countPendingMessages(gid);
  const analyzed = Math.max(0, beforePending - remaining);
  return { empty: false, analyzed, remaining, forcedSeen };
}

async function processSingleBatch(ctx, guildId, batch) {
  const gid = String(guildId);
  const apiKey = ctx.store.getApiKey(gid);
  const lang = ctx.store.getLanguage(gid);
  const messages = ctx.store.getBatchMessages(gid, batch.id);

  if (messages.length === 0) {
    ctx.store.deleteBatch(gid, batch.id);
    void ctx.store.flush();
    return true;
  }

  // Nur Admin-Kontext ohne eine einzige moderierbare Nachricht -> nichts zu tun,
  // keine API-Kosten verursachen.
  if (!messages.some((m) => !m.isAdmin && m.seq != null)) {
    ctx.store.deleteBatch(gid, batch.id);
    void ctx.store.flush();
    ctx.logger?.info?.(
      `[security-bot] Batch ${batch.id} für Gilde ${gid} übersprungen: nur Admin-Nachrichten (${messages.length}).`
    );
    return true;
  }

  if (!apiKey) {
    // Kein Key -> nichts analysieren, aber NICHTS verwerfen. Selten melden.
    if (!batch.keyNoticeSent) {
      batch.keyNoticeSent = true;
      updateBatch(ctx, gid, batch);
      await sendLogNotice(
        ctx,
        gid,
        buildNoKeyContainer({ lang, count: ctx.store.countPendingMessages(gid) })
      );
    }
    batch.nextRetryAt = Date.now() + NO_KEY_RETRY_MS;
    updateBatch(ctx, gid, batch);
    return false;
  }

  const guildName = ctx.client?.guilds?.cache?.get?.(gid)?.name || 'Unbekannter Server';
  const penaltyByUser = ctx.store.getPenaltySummary(gid, { days: 20 });

  // Teilnehmer (letzte Anzeigenamen gewinnen) für das Strafenregister im System-Prompt
  const participantMap = new Map();
  for (const m of [...messages].sort((a, b) => a.ord - b.ord)) {
    const prev = participantMap.get(m.authorId);
    participantMap.set(m.authorId, {
      authorId: m.authorId,
      authorName: m.authorName,
      authorMeta: m.authorMeta || prev?.authorMeta || null,
      isAdmin: Boolean(prev?.isAdmin || m.isAdmin),
    });
  }
  const participants = [...participantMap.values()];

  const systemPrompt = buildSystemPrompt({
    guildName,
    lang,
    participants,
    penaltyByUser,
    // /security_check_now kann eine Zwangsmoderation für einen Nutzer angeordnet
    // haben – die Direktive hängt am Batch und wird hier Teil des System-Prompts.
    forceUser: batch.forceUser || null,
  });
  const adminPrompt = ctx.store.getPrompt(gid) || t('defaultPrompt', lang);
  const userPrompt = buildUserPrompt({
    adminPrompt,
    logText: buildChatLog(messages),
  });

  const estimatedTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 3);
  const slot = reserveGeminiSlot({ ctx, apiKey, env: ctx.env, estimatedTokens });
  if (!slot.allowed) {
    batch.nextRetryAt = slot.nextAt;
    batch.lastError = `local_rate_limit_wait_${Math.ceil(slot.waitMs / 1000)}s`;
    updateBatch(ctx, gid, batch);
    void ctx.store.flush();
    ctx.logger?.info?.(
      `[security-bot] Gemini-Analyse für Gilde ${gid} lokal gedrosselt: ` +
        `warte ${Math.ceil(slot.waitMs / 1000)}s (Batch ${batch.id}, ` +
        `RPM=${slot.config.rpmLimit}, TPM=${slot.config.tpmLimit}, ` +
        `Tagesbudget=${slot.config.dailyAllowance}/${slot.config.rpdLimit}).`
    );
    return false;
  }

  ctx.logger?.info?.(
    `[security-bot] Analyse-Start für Gilde ${gid} (${guildName}): ${messages.length} Nachrichten, ` +
      `~${estimatedTokens} Tokens geschätzt (Batch ${batch.id}, Versuch ${(batch.retryCount || 0) + 1}, ` +
      `Rate ${slot.state.dayCount}/${slot.config.dailyAllowance} heute)`
  );

  const res = await callGemini({ apiKey, systemPrompt, userPrompt, env: ctx.env });

  if (!res.ok) {
    const errorText = `${res.error || 'unbekannt'}${res.message ? `: ${clip(res.message, 200)}` : ''}`;
    batch.retryCount = (batch.retryCount || 0) + 1;
    batch.lastError = errorText;
    let retryDelay = nextRetryDelay(batch.retryCount);
    if (res.status === 429) {
      const cooldown = noteGemini429({ ctx, apiKey, env: ctx.env, retryAfterMs: res.retryAfterMs });
      retryDelay = Math.max(retryDelay, cooldown.waitMs || 0);
    }
    batch.nextRetryAt = Date.now() + retryDelay;
    updateBatch(ctx, gid, batch);
    void ctx.store.flush();

    // Jede Wiederholung wird protokolliert. Die alte Drosselung (nur Versuch 1
    // und danach 5, 10, ...) machte den Retry-Verlauf unsichtbar und erschwerte
    // die Fehlersuche erheblich.
    await sendLogNotice(
      ctx,
      gid,
      buildApiErrorContainer({
        lang,
        count: messages.length,
        error: errorText,
        attempt: batch.retryCount,
        nextRetry: fmtDateTime(batch.nextRetryAt, lang),
      })
    );
    ctx.logger?.warn?.(
      `[security-bot] Gemini-Fehler für Gilde ${gid} (Batch ${batch.id}, Versuch ${batch.retryCount}): ${errorText} – ` +
        `Nachrichten bleiben erhalten, Retry um ${new Date(batch.nextRetryAt).toISOString()}`
    );
    return false;
  }

  const parsed = parseModerationJson(extractResponseText(res.data));
  if (!parsed.ok) {
    // Kaputte Modell-Antwort -> wie ein API-Fehler behandeln, Batch bleibt erhalten.
    batch.retryCount = (batch.retryCount || 0) + 1;
    batch.lastError = `invalid_model_response (${parsed.error})`;
    batch.nextRetryAt = Date.now() + nextRetryDelay(batch.retryCount);
    updateBatch(ctx, gid, batch);
    void ctx.store.flush();
    await sendLogNotice(
      ctx,
      gid,
      buildApiErrorContainer({
        lang,
        count: messages.length,
        error: batch.lastError,
        attempt: batch.retryCount,
        nextRetry: fmtDateTime(batch.nextRetryAt, lang),
      })
    );
    return false;
  }

  await applyResults({ ctx, guildId: gid, messages, parsed, lang });

  // Batch ist vollständig abgearbeitet -> Nachrichten & Meta entfernen.
  ctx.store.deleteBatch(gid, batch.id);
  void ctx.store.flush();
  ctx.logger?.info?.(
    `[security-bot] Analyse ok für Gilde ${gid}: ${parsed.moderations.length} Moderation(en) ` +
      `(Batch ${batch.id} abgeschlossen)` +
      (parsed.moderations.length === 0 ? ' – niemand moderiert, Bot bleibt still.' : '')
  );
  return true;
}

/** Fette Discord-Bezeichnung der Maßnahme, z. B. "**⏱️ Timeout (1h)**". */
function actionHeadline(mod, lang = 'de') {
  if (mod?.action === 'timeout') {
    const duration = mod.duration ? ` (${mod.duration})` : '';
    return `**${t('logActionTimeout', lang)}${duration}**`;
  }
  return `**${t('logActionWarn', lang)}**`;
}

/**
 * Fette Kopfzeile über der Begründung: Maßnahme + Hauptgrund.
 * Discord-Format ist hier Pflicht – Maßnahme UND Hauptgrund sind fett, damit
 * im Chat sofort erkennbar ist, was passiert ist und warum.
 */
function moderationHeadline(mod, lang = 'de') {
  const reason = clip(String(mod?.reason || '').replace(/\s+/g, ' ').trim(), 180);
  const parts = [actionHeadline(mod, lang)];
  if (reason) parts.push(`**${reason.replace(/\*+/g, '')}**`);
  return parts.join(' · ');
}

/**
 * Ersetzt die Platzhalter in Geminis persönlicher Nachricht durch echte
 * Mentions und stellt die fette Maßnahmen-/Grund-Kopfzeile voran.
 */
function personalMessageText(mod, authorId, authorName, lang = 'de') {
  let text = String(mod.personal_message || '').trim();
  const mention = `<@${authorId}>`;
  text = text
    .replace(/\{\s*USER\s*\}|\[\s*USER\s*\]|\(\s*USER\s*\)|@USER\b/gi, mention)
    .replace(/\{\s*USER_?NAME\s*\}|\{\s*NAME\s*\}/gi, authorName || mention);
  if (!text.includes(mention)) text = `${mention} ${text}`.trim();

  const headline = moderationHeadline(mod, lang);
  const body = clip(text, 1700);
  // Die Erwähnung steht bewusst in der ersten Zeile (Discord pingt sicher),
  // darunter die fette Kopfzeile, danach die ausführliche Begründung.
  if (body.startsWith(mention)) {
    const rest = body.slice(mention.length).trim();
    return clip(`${mention}\n${headline}\n${rest}`, 1900);
  }
  return clip(`${mention}\n${headline}\n${body}`, 1900);
}

/** Wendet die Moderationen aus der Gemini-Antwort auf Discord an. */
async function applyResults({ ctx, guildId, messages, parsed, lang, maxModerations = MAX_MODERATIONS_PER_BATCH }) {
  const applied = [];
  const guild =
    ctx.client?.guilds?.cache?.get?.(guildId) ||
    (await ctx.client?.guilds?.fetch?.(guildId).catch(() => null));

  // Nur moderierbare Nachrichten (Admin-Kontext hat keine seq)
  const bySeq = new Map(
    messages.filter((m) => m.seq != null && !m.isAdmin).map((m) => [m.seq, m])
  );

  // Sortierung: Primary zuerst, danach nach Timeout-Dauer absteigend. So
  // antwortet der Bot auf den schwerwiegendsten Verstoß zuerst UND jede Person
  // erhält ihren längsten Timeout als Ersten (kürzere werden herabgestuft).
  const durationRank = (m) =>
    m.action === 'timeout' ? DURATION_SECONDS[m.duration] || 0 : 0;
  const list = [...parsed.moderations]
    .sort(
      (a, b) =>
        (b.primary === true) - (a.primary === true) || durationRank(b) - durationRank(a)
    )
    .slice(0, Math.max(1, maxModerations));

  // Harte Garantie: höchstens EIN Timeout pro Person pro Analyse. Alle weiteren
  // Timeout-Wünsche derselben Person werden automatisch zu Warnungen degradiert
  // – unabhängig davon, was Gemini liefert.
  const timeoutedUsers = new Set();

  for (const mod of list) {
    try {
      const rec = bySeq.get(mod.message_id);
      if (!rec) continue; // Erfundene ID -> ignorieren
      const authorId = rec.authorId;

      let member = null;
      if (guild && typeof guild.members?.fetch === 'function') {
        member = await guild.members.fetch(authorId).catch(() => null);
      }
      if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) {
        // Doppelte Absicherung: Admins werden NIE moderiert.
        await sendLogNotice(
          ctx,
          guildId,
          smallContainer(null, t('logImmune', lang, { user: `<@${authorId}>` }))
        );
        continue;
      }

      // Max. 1 Timeout pro Person: weitere Timeouts derselben Person → warn.
      if (mod.action === 'timeout') {
        if (timeoutedUsers.has(authorId)) {
          mod.action = 'warn';
          mod.duration = null;
          ctx.logger?.info?.(
            `[security-bot] Zweiter Timeout für ${authorId} (Gilde ${guildId}) auf Warnung herabgestuft – max. 1 Timeout pro Person.`
          );
        } else {
          timeoutedUsers.add(authorId);
        }
      }

      // 1) Timeout anwenden (falls Gemini sich dafür entschied und es möglich ist)
      let timeoutApplied = false;
      let timeoutIssue = null;
      if (mod.action === 'timeout') {
        const seconds = DURATION_SECONDS[mod.duration] || 3600;
        if (!member) {
          timeoutIssue = 'Mitglied nicht mehr auf dem Server';
        } else if (!member.moderatable) {
          timeoutIssue = 'Mitglied ist nicht timeout-bar (Rang/Rechte)';
        } else {
          try {
            await member.timeout(
              seconds * 1000,
              `[KI-Moderation] ${clip(mod.reason, 400)}`.slice(0, 512)
            );
            timeoutApplied = true;
          } catch (err) {
            timeoutIssue = err?.message || 'Timeout fehlgeschlagen';
          }
        }
        if (timeoutIssue) {
          ctx.logger?.warn?.(
            `[security-bot] Timeout für ${authorId} nicht möglich: ${timeoutIssue}`
          );
        }
      }

      // 2) Persönliche Nachricht auf die (Haupt-)Verstoßnachricht antworten
      const replyText = personalMessageText(mod, authorId, rec.authorName, lang);
      const channel = guild?.channels?.cache?.get?.(rec.channelId) || null;
      let replied = false;
      if (channel && rec.discordMessageId) {
        try {
          const target = await channel.messages.fetch(rec.discordMessageId);
          await target.reply({
            content: replyText,
            allowedMentions: { users: [authorId], repliedUser: true },
          });
          replied = true;
        } catch {}
      }
      if (!replied && channel) {
        try {
          await channel.send({
            content: replyText,
            allowedMentions: { users: [authorId] },
          });
          replied = true;
        } catch {}
      }

      // 3) Strafenregister pflegen (20-Tage-Fenster für Gemini)
      ctx.store.addPenalty({
        guildId,
        userId: authorId,
        userName: rec.authorName,
        action: mod.action,
        duration: mod.duration,
        durationSeconds: mod.action === 'timeout' ? DURATION_SECONDS[mod.duration] || 0 : 0,
        reason: mod.reason,
        messageExcerpt: rec.content,
        isPrimary: mod.primary === true,
      });

      // 4) Log-Kanal informieren
      const jumpLink =
        rec.discordMessageId && guild
          ? `https://discord.com/channels/${guildId}/${rec.channelId}/${rec.discordMessageId}`
          : null;
      await sendLogNotice(
        ctx,
        guildId,
        buildModerationLogContainer({
          lang,
          moderation: {
            userId: authorId,
            userName: rec.authorName,
            action: mod.action,
            duration: mod.duration,
            reason: mod.reason,
            primary: mod.primary === true,
            excerpt: rec.content,
            jumpLink,
            batchSize: messages.length,
            issue: mod.action === 'timeout' ? timeoutIssue : null,
          },
        })
      );
      applied.push({
        userId: authorId,
        userName: rec.authorName,
        action: mod.action,
        duration: mod.duration,
        reason: mod.reason,
        primary: mod.primary === true,
        timeoutApplied,
        timeoutIssue,
        replied,
        excerpt: rec.content,
        jumpLink,
      });
      ctx.logger?.info?.(
        `[security-bot] Moderation angewendet: user=${authorId} action=${mod.action}` +
          `${mod.action === 'timeout' ? ` duration=${mod.duration} applied=${timeoutApplied}` : ''}` +
          ` replied=${replied} primary=${Boolean(mod.primary)} (Gilde ${guildId})`
      );
    } catch (err) {
      ctx.logger?.error?.('[security-bot] Fehler beim Anwenden einer Moderation:', err?.message || err);
    }
  }

  // Bewusst KEIN weiterer Kanal-Post: Der Bot schreibt ausschließlich die
  // persönlichen Moderations-Nachrichten oben. Früher konnte Gemini über ein
  // Feld "chat_reply" ohne jeden Verstoß Small-Talk in den Chat posten
  // ("Hey zusammen! Hier ist alles entspannt ... 👋"). Das ist entfernt: keine
  // Moderation = keine Nachricht.
  return applied;
}

/**
 * Kürzt eine Nachrichtenliste, bis sie sicher ins Token-Budget passt
 * (älteste Nachrichten fliegen zuerst raus).
 */
function trimToTokenBudget(messages, maxTokens = 15000) {
  const sorted = [...messages].sort((a, b) => a.ord - b.ord);
  let out = sorted;
  while (out.length > 1) {
    const tokens = estimateTokens(buildChatLog(out));
    if (tokens <= maxTokens) break;
    out = out.slice(Math.ceil(out.length * 0.15) || 1);
  }
  return out;
}

/**
 * Einmalige Ad-hoc-Analyse einer frei zusammengestellten Nachrichtenliste
 * (z. B. gezielt ausgewählte Nachrichten eines Nutzers oder der frisch
 * eingelesene Live-Verlauf) – ohne Batch-/Retry-Warteschlange.
 *
 * Wird von /security_action und /security_ai_order genutzt. Die Maßnahmen
 * werden exakt wie bei einer regulären Analyse angewendet, damit der Bot
 * nach außen wie eine eigenständige KI-Moderation wirkt.
 */
async function runAdHocAnalysis({
  ctx,
  guildId,
  messages,
  extraDirectives = [],
  maxModerations = MAX_MODERATIONS_PER_BATCH,
  adminPromptOverride = null,
}) {
  const gid = String(guildId);
  const lang = ctx.store.getLanguage(gid);
  const apiKey = ctx.store.getApiKey(gid);
  if (!apiKey) return { ok: false, error: 'missing_api_key', lang };

  const usable = trimToTokenBudget(
    messages.filter((m) => String(m.content || '').trim()),
    Number.parseInt(String(ctx.env?.('SECURITY_GEMINI_MAX_INPUT_TOKENS', '') || ''), 10) || 15000
  );
  if (!usable.some((m) => m.seq != null && !m.isAdmin)) {
    return { ok: false, error: 'no_messages', lang };
  }

  const guildName = ctx.client?.guilds?.cache?.get?.(gid)?.name || 'Unbekannter Server';
  const penaltyByUser = ctx.store.getPenaltySummary(gid, { days: 20 });
  const participantMap = new Map();
  for (const m of usable) {
    const prev = participantMap.get(m.authorId);
    participantMap.set(m.authorId, {
      authorId: m.authorId,
      authorName: m.authorName,
      authorMeta: m.authorMeta || prev?.authorMeta || null,
      isAdmin: Boolean(prev?.isAdmin || m.isAdmin),
    });
  }

  const systemPrompt = buildSystemPrompt({
    guildName,
    lang,
    participants: [...participantMap.values()],
    penaltyByUser,
    extraDirectives,
  });
  const adminPrompt = adminPromptOverride || ctx.store.getPrompt(gid) || t('defaultPrompt', lang);
  const userPrompt = buildUserPrompt({ adminPrompt, logText: buildChatLog(usable) });

  const res = await callGemini({ apiKey, systemPrompt, userPrompt, env: ctx.env });
  if (!res.ok) {
    if (res.status === 429) noteGemini429({ ctx, apiKey, env: ctx.env, retryAfterMs: res.retryAfterMs });
    ctx.logger?.warn?.(
      `[security-bot] Ad-hoc-Analyse für Gilde ${gid} fehlgeschlagen: ${res.error}` +
        `${res.message ? ` (${clip(res.message, 200)})` : ''}`
    );
    return { ok: false, error: res.error, message: res.message, lang };
  }

  const parsed = parseModerationJson(extractResponseText(res.data));
  if (!parsed.ok) {
    return { ok: false, error: `invalid_model_response (${parsed.error})`, lang };
  }

  const applied = await applyResults({
    ctx,
    guildId: gid,
    messages: usable,
    parsed,
    lang,
    maxModerations,
  });

  return { ok: true, lang, applied, moderations: parsed.moderations, analyzed: usable.length };
}

/**
 * /security_action – gezielte, verdeckte KI-Moderation ausgewählter
 * Nachrichten EINES Nutzers. Der Bot entscheidet selbst, welche der
 * ausgewählten Nachrichten die schwerwiegendste ist.
 */
async function runTargetedModeration({ ctx, guildId, target, selected, context = [], adminNote = '' }) {
  const all = [...context, ...selected];
  const seen = new Set();
  const merged = [];
  for (const rec of all.sort((a, b) => a.ord - b.ord)) {
    const key = rec.discordMessageId || `${rec.channelId}:${rec.ord}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...rec });
  }

  // Nur die AUSGEWÄHLTEN Nachrichten bekommen eine moderierbare ID – alles
  // andere ist reiner Kontext (seq = null) und kann nicht bestraft werden.
  const selectedKeys = new Set(
    selected.map((rec) => rec.discordMessageId || `${rec.channelId}:${rec.ord}`)
  );
  let seq = 0;
  const selectedIds = [];
  for (const rec of merged) {
    const key = rec.discordMessageId || `${rec.channelId}:${rec.ord}`;
    if (selectedKeys.has(key) && !rec.isAdmin) {
      rec.seq = ++seq;
      selectedIds.push(rec.seq);
    } else {
      // Kein seq => im Chat-Log als "[KONTEXT – nicht moderierbar]" markiert.
      rec.seq = null;
    }
  }

  return runAdHocAnalysis({
    ctx,
    guildId,
    messages: merged,
    maxModerations: 5,
    extraDirectives: buildTargetedDirectives({
      targetName: target?.name,
      targetId: target?.id,
      selectedIds,
      adminNote,
    }),
  });
}

/**
 * /security_ai_order – freier Auftrag an die KI auf Basis des kompletten
 * Chatverlaufs ("was soll sie tun und warum").
 */
async function runCustomOrder({ ctx, guildId, messages, order, reasoning, focus }) {
  const numbered = [];
  let seq = 0;
  for (const rec of [...messages].sort((a, b) => a.ord - b.ord)) {
    const copy = { ...rec };
    copy.seq = copy.isAdmin ? null : ++seq;
    numbered.push(copy);
  }
  return runAdHocAnalysis({
    ctx,
    guildId,
    messages: numbered,
    extraDirectives: buildOrderDirectives({ order, reasoning, focus }),
  });
}

module.exports = {
  processGuild,
  flushBuffer,
  runCheckNow,
  runAdHocAnalysis,
  runTargetedModeration,
  runCustomOrder,
  trimToTokenBudget,
  moderationHeadline,
  applyResults,
  personalMessageText,
  nextRetryDelay,
  fmtDateTime,
  MAX_MODERATIONS_PER_BATCH,
  BACKOFF_SCHEDULE_MS,
  NO_KEY_RETRY_MS,
};
