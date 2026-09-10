/**
 * Moderations-Pipeline des Sicherheitsbots.
 *
 * Ablauf:
 *   Buffer voll (Token-Limit) oder Mitternachts-Flush
 *     → Batch mit IDs ab 1 → Gemini (System-Prompt + Admin-Prompt + Verlauf)
 *     → Antwort parsen → Maßnahmen anwenden → Log-Kanal informieren
 *
 * Zuverlässigkeit ("Nicht einfach aufgeben"):
 * - Bei API-Fehlern/Rate-Limits bleibt der Batch VOLLSTÄNDIG erhalten und wird
 *   mit wachsendem Abstand erneut versucht (2m → 5m → 15m → … → max. 6h).
 * - Neue Nachrichten sammeln sich derweil ganz normal im Buffer.
 * - Wurde niemand moderiert, passiert nichts (keine Spam-Nachrichten).
 * - Administratoren werden zusätzlich zur Sammel-Immunität bei der Anwendung
 *   noch einmal geprüft und notfalls übersprungen.
 */

const { PermissionFlagsBits } = require('discord.js');
const {
  callGemini,
  extractResponseText,
  parseModerationJson,
} = require('./gemini');
const {
  buildSystemPrompt,
  buildUserPrompt,
  buildChatLog,
  DURATION_SECONDS,
} = require('./prompts');
const {
  smallContainer,
  clip,
  buildModerationLogContainer,
  buildChatReplyLogContainer,
  buildApiErrorContainer,
  buildNoKeyContainer,
} = require('./embed-builder');
const { sendLogNotice } = require('./notices');
const { t, tzFor } = require('./languages');

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
const NOTIFY_EVERY_N_FAILURES = 5;

// Ein-Flug-Steuerung pro Gilde (mehrere parallele Gemini-Aufrufe pro Server vermeiden)
const runningByGuild = new Set();
const rerunRequested = new Set();

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
    participantMap.set(m.authorId, { authorId: m.authorId, authorName: m.authorName });
  }
  const participants = [...participantMap.values()];

  const systemPrompt = buildSystemPrompt({
    guildName,
    lang,
    participants,
    penaltyByUser,
  });
  const adminPrompt = ctx.store.getPrompt(gid) || t('defaultPrompt', lang);
  const userPrompt = buildUserPrompt({
    adminPrompt,
    logText: buildChatLog(messages),
  });

  ctx.logger?.info?.(
    `[security-bot] Analyse-Start für Gilde ${gid} (${guildName}): ${messages.length} Nachrichten, ` +
      `~${Math.ceil((systemPrompt.length + userPrompt.length) / 3)} Tokens geschätzt (Batch ${batch.id}, Versuch ${(batch.retryCount || 0) + 1})`
  );

  const res = await callGemini({ apiKey, systemPrompt, userPrompt, env: ctx.env });

  if (!res.ok) {
    const errorText = `${res.error || 'unbekannt'}${res.message ? `: ${clip(res.message, 200)}` : ''}`;
    batch.retryCount = (batch.retryCount || 0) + 1;
    batch.lastError = errorText;
    batch.nextRetryAt = Date.now() + nextRetryDelay(batch.retryCount);
    updateBatch(ctx, gid, batch);
    void ctx.store.flush();

    const shouldNotify = batch.retryCount === 1 || batch.retryCount % NOTIFY_EVERY_N_FAILURES === 0;
    if (shouldNotify) {
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
    }
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
    if (batch.retryCount === 1 || batch.retryCount % NOTIFY_EVERY_N_FAILURES === 0) {
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
    }
    return false;
  }

  await applyResults({ ctx, guildId: gid, messages, parsed, lang });

  // Batch ist vollständig abgearbeitet -> Nachrichten & Meta entfernen.
  ctx.store.deleteBatch(gid, batch.id);
  void ctx.store.flush();
  ctx.logger?.info?.(
    `[security-bot] Analyse ok für Gilde ${gid}: ${parsed.moderations.length} Moderation(en), ` +
      `Chat-Antwort: ${parsed.chat_reply ? 'ja' : 'nein'} (Batch ${batch.id} abgeschlossen)`
  );
  return true;
}

/** Ersetzt die Platzhalter in Geminis persönlicher Nachricht durch echte Mentions. */
function personalMessageText(mod, authorId, authorName) {
  let text = String(mod.personal_message || '').trim();
  const mention = `<@${authorId}>`;
  text = text
    .replace(/\{\s*USER\s*\}|\[\s*USER\s*\]|\(\s*USER\s*\)|@USER\b/gi, mention)
    .replace(/\{\s*USER_?NAME\s*\}|\{\s*NAME\s*\}/gi, authorName || mention);
  if (!text.includes(mention)) text = `${mention} ${text}`.trim();
  return clip(text, 1800);
}

/** Wendet die Moderationen aus der Gemini-Antwort auf Discord an. */
async function applyResults({ ctx, guildId, messages, parsed, lang }) {
  const guild =
    ctx.client?.guilds?.cache?.get?.(guildId) ||
    (await ctx.client?.guilds?.fetch?.(guildId).catch(() => null));

  const bySeq = new Map(messages.map((m) => [m.seq, m]));
  // Primary zuerst: Die wichtigste Antwort soll als erstes im Chat landen.
  const list = [...parsed.moderations]
    .sort((a, b) => (b.primary === true) - (a.primary === true))
    .slice(0, MAX_MODERATIONS_PER_BATCH);

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
      const replyText = personalMessageText(mod, authorId, rec.authorName);
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
      ctx.logger?.info?.(
        `[security-bot] Moderation angewendet: user=${authorId} action=${mod.action}` +
          `${mod.action === 'timeout' ? ` duration=${mod.duration} applied=${timeoutApplied}` : ''}` +
          ` replied=${replied} primary=${Boolean(mod.primary)} (Gilde ${guildId})`
      );
    } catch (err) {
      ctx.logger?.error?.('[security-bot] Fehler beim Anwenden einer Moderation:', err?.message || err);
    }
  }

  // Optionale lockere Chat-Antwort (wenn niemand moderiert wurde / als Zugabe)
  if (parsed.chat_reply) {
    try {
      const last = messages.reduce((a, b) => (b.ord > a.ord ? b : a), messages[0]);
      const channel = guild?.channels?.cache?.get?.(last?.channelId) || null;
      if (channel) {
        await channel.send({
          content: clip(parsed.chat_reply, 1500),
          allowedMentions: { parse: [] },
        });
      }
      await sendLogNotice(
        ctx,
        guildId,
        buildChatReplyLogContainer({
          lang,
          reply: parsed.chat_reply,
          channelMention: last?.channelId ? `<#${last.channelId}>` : null,
        })
      );
    } catch (err) {
      ctx.logger?.warn?.('[security-bot] Chat-Antwort fehlgeschlagen:', err?.message || err);
    }
  }
}

module.exports = {
  processGuild,
  flushBuffer,
  applyResults,
  personalMessageText,
  nextRetryDelay,
  fmtDateTime,
  MAX_MODERATIONS_PER_BATCH,
  BACKOFF_SCHEDULE_MS,
  NO_KEY_RETRY_MS,
};
