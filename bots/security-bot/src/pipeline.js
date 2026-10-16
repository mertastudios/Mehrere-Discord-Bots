/**
 * ============================================================================
 *  Pipeline: sammeln → vorprüfen → urteilen → moderieren
 *
 *  Kosten- und limitbewusst:
 *   1. LOKALER FILTER (0 Tokens): Grobsignale wie Beleidigung, Drohung, Scam,
 *      Spam, Mention-Druck. Schlägt er an, geht der Puffer sofort raus.
 *   2. VORPRÜFUNG mit dem schnellen Modell – nur bei größeren Batches. Sie
 *      kostet ~1.000 Token und entscheidet, ob sich das Urteil lohnt.
 *      Harmlos und unter der Schwelle → Puffer verwerfen, keine weiteren Kosten.
 *   3. URTEIL mit dem schlauen Modell: strukturiertes JSON (Maßnahme, Regel,
 *      Begründung, Nutzer-Nachricht). Nur hierfür wird das Tages-Budget genutzt.
 *
 *  Bei Groq-Limits bleibt der Puffer vollständig erhalten, es wird mit dem vom
 *  Limit genannten Abstand erneut versucht und im Log-Kanal informiert.
 * ============================================================================
 */

const { PermissionFlagsBits } = require('discord.js');

const { buildTranscript, estimateTokens } = require('./transcript');
const { bufferRisk, shouldAnalyse, isMonitored, isCollectable, toRecord, localSignals } = require('./collector');
const { buildSystemPrompt, buildUserPrompt, buildScreenPrompt, screenSchema, verdictSchema } = require('./prompts');
const { callGroqWithFallback, modelFromEnv, nextBackoffMs } = require('./groq');
const { applyModerations } = require('./moderator');
const { logError, logRateLimit, ensureLogChannel } = require('./logging');
const { botHasAdmin } = require('./guard');
const { t } = require('./languages');

const TICK_MS = 15_000; // 15s statt 10s Ticks → weniger Overhead
const MAX_BATCH_MESSAGES = 25; // Kleinere Batches = weniger Token pro Anfrage
const MAX_TRANSCRIPT_TOKENS = 2200; // pro Anfrage – hält uns im Free-Plan
const SCREEN_MIN_MESSAGES = 15; // Vorprüfung NUR bei >= 15 Nachrichten, sonst direkt urteilen oder warten
const SCREEN_THRESHOLD = 45; // Höhere Schwelle für Vorprüfung
const KEY_WARN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LIMIT_WARN_INTERVAL_MS = 5 * 60 * 1000;

function intEnv(env, key, fallback) {
  const raw = Number.parseInt(String(env?.(key, '') || ''), 10);
  return Number.isFinite(raw) ? raw : fallback;
}

/** Nimmt so viele Nachrichten, wie ins Token-Budget passen (die neuesten). */
function pickBatch(records, { maxTokens = MAX_TRANSCRIPT_TOKENS, maxMessages = MAX_BATCH_MESSAGES } = {}) {
  const selected = [];
  let tokens = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    const cost = estimateTokens(record.content) + 25;
    if (selected.length >= maxMessages) break;
    if (selected.length >= 4 && tokens + cost > maxTokens) break;
    tokens += cost;
    selected.unshift(record);
  }
  return selected;
}

function createPipelineState() {
  return {
    running: false,
    retryAt: 0,
    retryAttempt: 0,
    lastRunAt: 0,
    lastKeyWarnAt: 0,
    lastLimitWarnAt: 0,
    lastQuietSkipLogAt: 0,
  };
}

// ------------------------------ Sammeln ------------------------------

/** Verarbeitet eine eingehende Nachricht (Sammeln + evtl. Sofort-Prüfung). */
async function handleIncoming({ ctx, message }) {
  const guild = message.guild;
  if (!guild) return;
  // Ohne Administrator-Rechte ist der Bot komplett inaktiv.
  if (!botHasAdmin(guild)) return;
  const cfg = ctx.store.getGuild(guild.id);

  if (!isCollectable(message, { botId: ctx.client.user?.id })) return;
  if (!isMonitored(message.channelId, cfg)) return;
  if (cfg.logChannelId && String(cfg.logChannelId) === String(message.channelId)) return;

  const botHighest = ctx.botHighestPosition(guild);
  const immune =
    (guild.ownerId && message.author.id === guild.ownerId) ||
    message.member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    (cfg.immuneRoles || []).some((id) => message.member?.roles?.cache?.has?.(id)) ||
    (message.member?.roles?.highest?.position ?? 0) >= botHighest;

  const record = toRecord(message, { immune, botId: ctx.client.user?.id });
  ctx.store.addBuffered(guild.id, record);

  // Sofort-Prüfung bei klarem Signal (spart Wartezeit bei Gewalt/Drohungen)
  const signals = localSignals(record);
  if (signals.some((s) => s.weight >= 45)) {
    const state = ctx.pipeline.get(guild.id) || createPipelineState();
    ctx.pipeline.set(guild.id, state);
    state.retryAt = 0;
    void tickGuild(ctx, guild.id, { now: Date.now(), force: true });
  }
}

// ------------------------------ Analyse ------------------------------

/** Ein Urteil bauen: Vorprüfung (optional) + Urteil. */
async function analyse({ ctx, guild, cfg, records }) {
  const apiKey = cfg.groqKey || String(ctx.env('SECURITY_GROQ_API_KEY', '') || '').trim();
  if (!apiKey) return { ok: false, error: 'missing_api_key' };

  const risk = bufferRisk(records, {
    mentionRepeatLimit: intEnv(ctx.env, 'SECURITY_AI_MENTION_REPEAT', 3),
  });
  const selected = pickBatch(records);
  if (!selected.length) return { ok: false, error: 'empty_batch' };

  // Strafregister der beteiligten Personen (30 Tage) – die KI eskaliert danach.
  const participantIds = [...new Set(selected.filter((r) => !r.immune).map((r) => r.authorId).filter(Boolean))];
  const register = ctx.store.registerForPrompt(guild.id, {
    userIds: participantIds,
    sinceMs: Date.now() - 30 * 24 * 3600 * 1000,
  });

  const system = buildSystemPrompt({
    botName: ctx.client.user?.username || 'Sentinel',
    guildName: guild.name,
    lang: cfg.lang || 'de',
    rules: cfg.rules,
    instructions: cfg.instructions,
    allow: cfg.allow,
    register,
    mode: 'normal',
  });

  const transcript = buildTranscript(selected.map((r) => ({ ...r, displayName: r.authorName })), {
    header: `Server: ${guild.name} · Sprache: ${cfg.lang || 'de'}`,
  });

  const baseTokens = estimateTokens(system) + transcript.tokens + 1200;
  const fastModel = modelFromEnv(ctx.env, 'fast');
  const smartModel = modelFromEnv(ctx.env, 'smart');

  let screened = { ran: false };
  // Vorprüfung nur, wenn wir WIRKLICH genug Budget haben – sonst lieber direkt
  // mit dem Urteil anfangen, oder warten.
  const screenCost = estimateTokens(system) + transcript.tokens + 400;
  const wantScreen = selected.length >= SCREEN_MIN_MESSAGES && risk.score < 60;
  if (wantScreen) {
    const check = ctx.budget.fast.canSpend(screenCost, { priority: risk.score >= 40 });
    if (check.ok && !check.waitMs) {
      const result = await callGroqWithFallback({
        apiKey,
        model: fastModel,
        system: buildSystemPrompt({
          guildName: guild.name,
          rules: cfg.rules,
          instructions: cfg.instructions,
          lang: cfg.lang || 'de',
          mode: 'screen',
        }),
        user: buildScreenPrompt({ transcript: transcript.text }),
        schema: screenSchema(),
        schemaName: 'vorpruefung',
        maxTokens: 300,
        temperature: 0.2,
        reasoningEffort: 'low',
        fetchFn: ctx.fetchFn,
      });
      if (result.ok) {
        const usedScreenTokens = result.usage.totalTokens || 400;
        ctx.budget.fast.spend(usedScreenTokens);
        screened = {
          ran: true,
          risiko: Number(result.json?.risiko) || 0,
          ids: Array.isArray(result.json?.ids) ? result.json.ids : [],
          hinweis: result.json?.hinweis || '',
        };
        if (screened.risiko < SCREEN_THRESHOLD && risk.score < 40) {
          // Harmlos: nur die geprüften Nachrichten verlassen den Puffer.
          return {
            ok: true,
            verdict: { verstoesse: [] },
            screened,
            usage: result.usage,
            model: result.model,
            selected,
            idMap: transcript.idMap,
          };
        }
        // Wir haben schon Tokens fürs Screening ausgegeben – ziehe die von den
        // geschätzten Urteils-Tokens ab, damit wir das Global-Limit nicht doppelt belasten.
        baseTokens = Math.max(800, baseTokens - Math.floor(usedScreenTokens * 0.7));
      } else if (result.error === 'invalid_api_key') {
        return { ok: false, error: 'invalid_api_key' };
      } else if (result.error === 'rate_limited') {
        return { ok: false, error: 'rate_limited', resetInMs: result.retryAfterMs };
      }
      // andere Fehler → trotzdem urteilen (Vorprüfung ist nur eine Abkürzung)
    }
  }

  const verdictCheck = ctx.budget.smart.canSpend(baseTokens, { priority: risk.score >= 40 });
  if (!verdictCheck.ok) {
    return { ok: false, error: 'rate_limited', resetInMs: verdictCheck.resetInMs, reason: verdictCheck.reason };
  }
  if (verdictCheck.waitMs) {
    return { ok: false, error: 'pacing', waitMs: verdictCheck.waitMs };
  }

  const result = await callGroqWithFallback({
    apiKey,
    model: smartModel,
    system,
    user: buildUserPrompt({
      transcript: transcript.text,
      channelInfo: screened.ids?.length ? `Mögliche Auffälligkeiten bei ID ${screened.ids.join(', ')} (${screened.hinweis || 'Vorprüfung'})` : '',
    }),
    schema: verdictSchema({ allow: cfg.allow }),
    schemaName: 'moderation',
    maxTokens: 1400,
    temperature: 0.35,
    reasoningEffort: 'medium',
    fetchFn: ctx.fetchFn,
  });

  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message, status: result.status, resetInMs: result.retryAfterMs, limits: result.limits };
  }

  ctx.budget.smart.spend(result.usage.totalTokens || baseTokens);
  return {
    ok: true,
    model: result.model,
    usage: result.usage,
    screened,
    verdict: { verstoesse: Array.isArray(result.json?.verstoesse) ? result.json.verstoesse : [] },
    selected,
    idMap: transcript.idMap,
    tokens: baseTokens,
  };
}

// ------------------------------ Ticks ------------------------------

async function runGuildAnalysis(ctx, guild, { priority = false } = {}) {
  const state = ctx.pipeline.get(guild.id) || createPipelineState();
  ctx.pipeline.set(guild.id, state);
  if (state.running) return { ok: false, error: 'busy' };
  state.running = true;
  state.lastRunAt = Date.now();

  try {
    const cfg = ctx.store.getGuild(guild.id);
    const records = ctx.store.getBuffer(guild.id).slice();
    if (!records.length) return { ok: true, skipped: 'leer' };

    const result = await analyse({ ctx, guild, cfg, records });

    if (!result.ok) {
      if (result.error === 'rate_limited' || result.error === 'pacing') {
        const wait = result.resetInMs || result.waitMs || 60_000;
        state.retryAt = Date.now() + wait;
        if (Date.now() - state.lastLimitWarnAt > LIMIT_WARN_INTERVAL_MS) {
          state.lastLimitWarnAt = Date.now();
          await logRateLimit(ctx, guild, {
            lang: cfg.lang,
            detail: result.reason ? `Grund: ${result.reason}` : null,
            resetText: ctx.budget.resetText({ resetInMs: wait }),
            pending: ctx.store.pendingCount(guild.id),
          });
        }
        return { ok: false, error: 'rate_limited' };
      }
      if (result.error === 'invalid_api_key' || result.error === 'missing_api_key') {
        if (Date.now() - state.lastKeyWarnAt > KEY_WARN_INTERVAL_MS) {
          state.lastKeyWarnAt = Date.now();
          await logError(ctx, guild, {
            lang: cfg.lang,
            detail: result.error === 'missing_api_key' ? '🔑 Es ist kein Groq-Key hinterlegt – `/setup` Schritt 7.' : t(cfg.lang || 'de', 'keyInvalidLog'),
          });
        }
        state.retryAt = Date.now() + KEY_WARN_INTERVAL_MS;
        return { ok: false, error: result.error };
      }
      // Netzwerk/Server → Backoff, Puffer bleibt erhalten
      state.retryAttempt = Math.min(6, state.retryAttempt + 1);
      state.retryAt = Date.now() + nextBackoffMs(state.retryAttempt - 1);
      await logError(ctx, guild, {
        lang: cfg.lang,
        detail: `Groq-Antwort fehlgeschlagen (${result.error}${result.status ? ` ${result.status}` : ''}).`,
        hint: result.message ? `` : null,
      });
      return { ok: false, error: result.error };
    }

    state.retryAttempt = 0;
    state.retryAt = 0;

    const decisions = result.verdict?.verstoesse || [];
    let appliedInfo = { applied: [], skipped: [] };
    if (decisions.length) {
      appliedInfo = await applyModerations({
        ctx,
        guild,
        idMap: result.idMap,
        decisions,
        source: 'ai',
      });
    }

    // Geprüfte Nachrichten aus dem Puffer nehmen (neue bleiben drin)
    const checkedKeys = (result.selected || []).map((r) => r.key);
    if (checkedKeys.length) ctx.store.dropBuffered(guild.id, checkedKeys);
    else if (!decisions.length) ctx.store.clearBuffer(guild.id);
    else ctx.store.commit();

    return { ok: true, decided: decisions.length, applied: appliedInfo.applied.length, priority };
  } finally {
    state.running = false;
  }
}

/** Prüft für eine Gilde, ob jetzt analysiert werden soll. */
async function tickGuild(ctx, guildId, { now = Date.now(), force = false } = {}) {
  const guild = ctx.client.guilds.cache.get(String(guildId));
  if (!guild) return { ok: false, error: 'guild_missing' };
  if (!botHasAdmin(guild)) return { ok: false, error: 'no_admin' };

  const state = ctx.pipeline.get(guildId) || createPipelineState();
  ctx.pipeline.set(guildId, state);
  if (state.running) return { ok: false, error: 'busy' };
  if (!force && state.retryAt && now < state.retryAt) return { ok: false, error: 'warten' };

  const cfg = ctx.store.getGuild(guildId);
  const records = ctx.store.getBuffer(guildId);
  if (!records.length) return { ok: true, skipped: 'leer' };

  const risk = bufferRisk(records);
  const decision = shouldAnalyse(records, {
    score: risk.score,
    now,
    limits: {
      maxBatch: MAX_BATCH_MESSAGES,
      minBatch: intEnv(ctx.env, 'SECURITY_AI_MIN_BATCH', 3),
      quietMs: intEnv(ctx.env, 'SECURITY_AI_QUIET_MS', 45_000), // Längere Ruhephase: 45s statt 30s → weniger unnötige Aufrufe
      maxAgeMs: intEnv(ctx.env, 'SECURITY_AI_MAX_AGE_MS', 240_000), // Maximal 4 Minuten warten statt 3
    },
  });
  if (force) decision.run = true;
  if (!decision.run) return { ok: true, skipped: decision.reason };

  return runGuildAnalysis(ctx, guild, { priority: Boolean(decision.priority) });
}

function startPipeline(ctx) {
  const timer = setInterval(() => {
    void (async () => {
      for (const guildId of ctx.client.guilds.cache.keys()) {
        try {
          await tickGuild(ctx, guildId, { now: Date.now() });
        } catch (err) {
          ctx.logger?.warn?.(`[security-bot] Pipeline-Fehler (${guildId}):`, err.message);
        }
      }
      // Log-Kanäle prüfen (und ggf. neu anlegen) – nur für eingerichtete Server
      for (const guild of ctx.client.guilds.cache.values()) {
        try {
          const cfg = ctx.store.getGuild(guild.id);
          if (!cfg.setup.done && !cfg.logChannelId) continue;
          if (!botHasAdmin(guild)) continue;
          await ensureLogChannel(ctx, guild);
        } catch {
          /* beim nächsten Tick erneut */
        }
      }
      try {
        await ctx.store.commit();
      } catch (err) {
        ctx.logger?.warn?.('[security-bot] Speichern fehlgeschlagen:', err.message);
      }
    })();
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = {
  TICK_MS,
  MAX_BATCH_MESSAGES,
  MAX_TRANSCRIPT_TOKENS,
  SCREEN_THRESHOLD,
  pickBatch,
  createPipelineState,
  handleIncoming,
  analyse,
  tickGuild,
  runGuildAnalysis,
  startPipeline,
};
