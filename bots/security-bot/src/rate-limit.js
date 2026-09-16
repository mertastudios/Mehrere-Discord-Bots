/**
 * Lokaler Gemini-Rate-Limiter.
 *
 * Gemini-Limits hängen laut Google am Projekt und nicht am einzelnen API-Key.
 * Der Bot kann die echten aktiven Limits nicht zuverlässig aus der API auslesen,
 * deshalb drosseln wir lokal, aggressiv und konfigurierbar: standardmäßig wird
 * das Minuten-/Token-/Tagesbudget ausgeschöpft, ohne künstlich zwischen Requests zu
 * schlafen; wer will, kann zusätzlich Tages-Pacing aktivieren. Die Drossel ist absichtlich
 * ctx-lokal. Standardmäßig wird der API-Key als Projekt-Proxy genutzt; bei mehreren
 * Keys aus demselben Google-Projekt kann SECURITY_GEMINI_LIMIT_SCOPE gesetzt werden.
 */

const crypto = require('crypto');

const DEFAULT_RPM_LIMIT = 12;
const DEFAULT_TPM_LIMIT = 250000;
const DEFAULT_RPD_LIMIT = 1000;
const DEFAULT_RPD_RESERVE = 50;
const DEFAULT_EXTRA_429_COOLDOWN_MS = 0;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function intEnv(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = Number.parseInt(String(env?.(key, '') || ''), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function rateLimitConfig(env) {
  const rpmLimit = intEnv(env, 'SECURITY_GEMINI_RPM_LIMIT', DEFAULT_RPM_LIMIT, { min: 1, max: 120 });
  const tpmLimit = intEnv(env, 'SECURITY_GEMINI_TPM_LIMIT', DEFAULT_TPM_LIMIT, { min: 1000, max: 10_000_000_000 });
  const rpdLimit = intEnv(env, 'SECURITY_GEMINI_RPD_LIMIT', DEFAULT_RPD_LIMIT, { min: 1, max: 200000 });
  const rpdReserve = intEnv(env, 'SECURITY_GEMINI_RPD_RESERVE', DEFAULT_RPD_RESERVE, { min: 0, max: Math.max(0, rpdLimit - 1) });
  const dailyAllowance = Math.max(1, rpdLimit - rpdReserve);
  const rpmFloorMs = Math.ceil(MINUTE_MS / rpmLimit);
  const rpdFloorMs = Math.ceil(DAY_MS / dailyAllowance);
  const configuredMinInterval = Number.parseInt(String(env?.('SECURITY_GEMINI_MIN_REQUEST_INTERVAL_MS', '') || ''), 10);
  const paceDaily = String(env?.('SECURITY_GEMINI_PACE_DAILY', '') || '').toLowerCase() === 'true';
  const minIntervalMs = Number.isFinite(configuredMinInterval) && configuredMinInterval >= 0
    ? configuredMinInterval
    : (paceDaily ? Math.max(rpmFloorMs, rpdFloorMs) : 0);

  return {
    rpmLimit,
    tpmLimit,
    rpdLimit,
    rpdReserve,
    dailyAllowance,
    rpmFloorMs,
    rpdFloorMs,
    paceDaily,
    minIntervalMs,
    extra429CooldownMs: intEnv(env, 'SECURITY_GEMINI_429_COOLDOWN_MS', DEFAULT_EXTRA_429_COOLDOWN_MS, { min: 0 }),
  };
}

function projectScopeFromApiKey(apiKey) {
  const value = String(apiKey || '').trim();
  if (!value) return 'missing';
  try {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
  } catch {
    return value.slice(0, 12);
  }
}

function dayKeyPacific(now = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

function msUntilNextPacificMidnight(now = Date.now()) {
  // Robust genug ohne Zeitzonen-Arithmetik: tageweise vorwärts suchen, bis der
  // LA-Datumsschlüssel wechselt. Dieser Pfad wird nur bei ausgeschöpftem RPD
  // genutzt, nicht pro Nachricht.
  const startKey = dayKeyPacific(now);
  let t = now + 60 * 1000;
  const end = now + 36 * 60 * 60 * 1000;
  while (t < end && dayKeyPacific(t) === startKey) t += 15 * 60 * 1000;
  while (t > now && dayKeyPacific(t - 60 * 1000) !== startKey) t -= 60 * 1000;
  return Math.max(60 * 1000, t - now);
}

function stateMapFor(ctx) {
  if (!ctx.geminiRateLimiterState) ctx.geminiRateLimiterState = new Map();
  return ctx.geminiRateLimiterState;
}

function stateFor(ctx, apiKey, now, env) {
  const configuredScope = String(env?.('SECURITY_GEMINI_LIMIT_SCOPE', '') || '').trim();
  const scope = configuredScope || projectScopeFromApiKey(apiKey);
  const map = stateMapFor(ctx);
  let state = map.get(scope);
  const dayKey = dayKeyPacific(now);
  if (!state || state.dayKey !== dayKey) {
    state = { dayKey, dayCount: 0, minute: [], tokenMinute: [], lastAt: 0, cooldownUntil: 0 };
    map.set(scope, state);
  }
  return state;
}

function reserveGeminiSlot({ ctx, apiKey, now = Date.now(), env, estimatedTokens = 1 } = {}) {
  const cfg = rateLimitConfig(env || ctx?.env);
  const state = stateFor(ctx || {}, apiKey, now, env || ctx?.env);
  const requestedTokens = Math.max(1, Math.ceil(Number(estimatedTokens) || 1));

  state.minute = state.minute.filter((t) => now - t < MINUTE_MS);
  state.tokenMinute = (state.tokenMinute || []).filter((entry) => now - entry.t < MINUTE_MS);
  const tokenMinuteUsed = state.tokenMinute.reduce((sum, entry) => sum + (Number(entry.tokens) || 0), 0);

  const waits = [];
  if (state.cooldownUntil && state.cooldownUntil > now) waits.push(state.cooldownUntil - now);
  if (cfg.minIntervalMs > 0 && state.lastAt && now - state.lastAt < cfg.minIntervalMs) {
    waits.push(cfg.minIntervalMs - (now - state.lastAt));
  }
  if (state.minute.length >= cfg.rpmLimit) {
    waits.push(MINUTE_MS - (now - state.minute[0]));
  }
  if (requestedTokens <= cfg.tpmLimit && tokenMinuteUsed + requestedTokens > cfg.tpmLimit) {
    let projected = tokenMinuteUsed + requestedTokens;
    const sorted = [...state.tokenMinute].sort((a, b) => a.t - b.t);
    for (const entry of sorted) {
      projected -= Number(entry.tokens) || 0;
      if (projected <= cfg.tpmLimit) {
        waits.push(Math.max(1, MINUTE_MS - (now - entry.t)));
        break;
      }
    }
  }
  if (state.dayCount >= cfg.dailyAllowance) {
    waits.push(msUntilNextPacificMidnight(now));
  }

  const waitMs = Math.max(0, ...waits.map((w) => Number.isFinite(w) ? w : 0));
  if (waitMs > 0) {
    return {
      allowed: false,
      waitMs,
      nextAt: now + waitMs,
      config: cfg,
      state: { dayCount: state.dayCount, minuteCount: state.minute.length, tokenMinuteUsed },
    };
  }

  state.lastAt = now;
  state.minute.push(now);
  state.tokenMinute.push({ t: now, tokens: requestedTokens });
  state.dayCount += 1;
  return {
    allowed: true,
    waitMs: 0,
    nextAt: now,
    config: cfg,
    state: { dayCount: state.dayCount, minuteCount: state.minute.length, tokenMinuteUsed: tokenMinuteUsed + requestedTokens },
  };
}

function noteGemini429({ ctx, apiKey, retryAfterMs, now = Date.now(), env } = {}) {
  const cfg = rateLimitConfig(env || ctx?.env);
  const state = stateFor(ctx || {}, apiKey, now, env || ctx?.env);
  const wait = Math.max(
    0,
    Number(retryAfterMs) || 0,
    cfg.extra429CooldownMs,
    cfg.minIntervalMs
  );
  if (wait > 0) state.cooldownUntil = Math.max(state.cooldownUntil || 0, now + wait);
  return { cooldownUntil: state.cooldownUntil || 0, waitMs: wait };
}

module.exports = {
  rateLimitConfig,
  reserveGeminiSlot,
  noteGemini429,
  projectScopeFromApiKey,
  dayKeyPacific,
  msUntilNextPacificMidnight,
  DEFAULT_RPM_LIMIT,
  DEFAULT_TPM_LIMIT,
  DEFAULT_RPD_LIMIT,
  DEFAULT_RPD_RESERVE,
};
