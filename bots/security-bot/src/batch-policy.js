/**
 * Adaptive Batch-Policy für den Sicherheitsbot.
 *
 * Ziel: Nicht mehr stundenlang warten, bis das große Token-Limit voll ist,
 * aber Gemini auch nicht mit jeder harmlosen Chatzeile belasten. Diese Policy
 * entscheidet nur, WANN ein offener Buffer zur Analyse geschickt wird – sie
 * moderiert selbst niemanden.
 */

const DEFAULT_SOFT_TOKEN_LIMIT = 2500;
const DEFAULT_SOFT_MESSAGE_LIMIT = 18;
const DEFAULT_MAX_BUFFER_AGE_MS = 5 * 60 * 1000;
const DEFAULT_QUIET_WINDOW_MS = 90 * 1000;
const DEFAULT_QUIET_MIN_MESSAGES = 5;
const DEFAULT_MENTION_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MENTION_REPEAT_LIMIT = 3;
const DEFAULT_MULTI_AUTHOR_MENTION_LIMIT = 2;

function intEnv(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = Number.parseInt(String(env?.(key, '') || ''), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function batchPolicyConfig(env) {
  return {
    softTokenLimit: intEnv(env, 'SECURITY_GEMINI_SOFT_INPUT_TOKENS', DEFAULT_SOFT_TOKEN_LIMIT, { min: 500 }),
    softMessageLimit: intEnv(env, 'SECURITY_GEMINI_SOFT_MAX_MESSAGES', DEFAULT_SOFT_MESSAGE_LIMIT, { min: 3 }),
    maxBufferAgeMs: intEnv(env, 'SECURITY_GEMINI_MAX_BUFFER_AGE_MS', DEFAULT_MAX_BUFFER_AGE_MS, { min: 30_000 }),
    quietWindowMs: intEnv(env, 'SECURITY_GEMINI_QUIET_FLUSH_MS', DEFAULT_QUIET_WINDOW_MS, { min: 15_000 }),
    quietMinMessages: intEnv(env, 'SECURITY_GEMINI_QUIET_MIN_MESSAGES', DEFAULT_QUIET_MIN_MESSAGES, { min: 2 }),
    mentionWindowMs: intEnv(env, 'SECURITY_GEMINI_MENTION_WINDOW_MS', DEFAULT_MENTION_WINDOW_MS, { min: 60_000 }),
    mentionRepeatLimit: intEnv(env, 'SECURITY_GEMINI_MENTION_REPEAT_LIMIT', DEFAULT_MENTION_REPEAT_LIMIT, { min: 2 }),
    multiAuthorMentionLimit: intEnv(env, 'SECURITY_GEMINI_MULTI_AUTHOR_MENTION_LIMIT', DEFAULT_MULTI_AUTHOR_MENTION_LIMIT, { min: 2 }),
  };
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[!1|]/g, 'i')
    .replace(/[@4]/g, 'a')
    .replace(/[0]/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/[3]/g, 'e');
}

/**
 * Nur als Flush-Auslöser, nicht als Moderationsentscheidung. Lieber einmal zu
 * viel Gemini fragen, als eine eskalierende Situation 2 Stunden liegen lassen.
 */
function riskSignalsForMessage(rec) {
  const text = normalizeText(rec?.content || '');
  const signals = [];

  if (/\b(fick\s*dich|fuck\s*you|halt\s+die\s+fresse|hurensohn|huso|bastard|opfer)\b/i.test(text)) {
    signals.push('direct_insult');
  }
  if (/\b(r\.?\s*i\.?\s*p\.?|ruhe\s+in\s+frieden|stirb|tot|verreck|kill\s*yourself|kys)\b/i.test(text)) {
    signals.push('death_or_rip_language');
  }
  if (/\b(auslaender|ausländer|kanake|nazi|juden|schwuchtel|nigger)\b/i.test(text)) {
    signals.push('hate_or_slur_language');
  }
  if (/\b(anzeige|polizei|privat|prvt|private\s+streit|beef)\b/i.test(text)) {
    signals.push('public_conflict_signal');
  }

  return [...new Set(signals)];
}

function mentionedIds(rec) {
  const list = Array.isArray(rec?.mentionsMeta) ? rec.mentionsMeta : [];
  return list
    .map((m) => (m?.id ? String(m.id) : null))
    .filter(Boolean)
    .filter((id) => id !== String(rec?.authorId || ''));
}

function mentionPressureSignal(buffer, now = Date.now(), cfg = batchPolicyConfig()) {
  const cutoff = now - cfg.mentionWindowMs;
  const byTarget = new Map();

  for (const rec of buffer || []) {
    const sentAt = Number(rec?.sentAt) || now;
    if (sentAt < cutoff) continue;
    for (const targetId of mentionedIds(rec)) {
      const entry = byTarget.get(targetId) || { count: 0, authors: new Set(), targetId };
      entry.count += 1;
      if (rec?.authorId) entry.authors.add(String(rec.authorId));
      byTarget.set(targetId, entry);
    }
  }

  for (const entry of byTarget.values()) {
    if (entry.count >= cfg.mentionRepeatLimit) {
      return { targetId: entry.targetId, count: entry.count, authors: entry.authors.size, reason: 'repeated_mentions' };
    }
    if (entry.authors.size >= cfg.multiAuthorMentionLimit && entry.count >= cfg.multiAuthorMentionLimit) {
      return { targetId: entry.targetId, count: entry.count, authors: entry.authors.size, reason: 'multi_author_mentions' };
    }
  }
  return null;
}

function oldestBufferedAt(buffer) {
  let oldest = null;
  for (const rec of buffer || []) {
    const at = Number(rec?.sentAt);
    if (!Number.isFinite(at)) continue;
    if (oldest == null || at < oldest) oldest = at;
  }
  return oldest;
}

function newestBufferedAt(buffer) {
  let newest = null;
  for (const rec of buffer || []) {
    const at = Number(rec?.sentAt);
    if (!Number.isFinite(at)) continue;
    if (newest == null || at > newest) newest = at;
  }
  return newest;
}

function tokenEstimateForBuffer(buffer, estimateTokensFn) {
  const estimate = typeof estimateTokensFn === 'function'
    ? estimateTokensFn
    : (text) => Math.ceil(String(text || '').length / 3);
  return (buffer || []).reduce((sum, rec) => {
    const metaText = [
      rec?.content || '',
      rec?.authorName || '',
      rec?.authorMeta ? JSON.stringify(rec.authorMeta) : '',
      rec?.replyMeta ? JSON.stringify(rec.replyMeta) : '',
      Array.isArray(rec?.mentionsMeta) && rec.mentionsMeta.length ? JSON.stringify(rec.mentionsMeta) : '',
    ].filter(Boolean).join('\n');
    return sum + estimate(metaText);
  }, 0);
}

function shouldFlushBuffer({ buffer, env, now = Date.now(), estimateTokensFn, newestMessage = null } = {}) {
  const list = Array.isArray(buffer) ? buffer : [];
  if (list.length === 0) return { flush: false, reason: null, urgent: false };

  const cfg = batchPolicyConfig(env);
  const newest = newestMessage || list[list.length - 1];
  const risk = riskSignalsForMessage(newest);
  if (risk.length > 0) {
    return { flush: true, reason: `risk:${risk.join(',')}`, urgent: true };
  }

  const pressure = mentionPressureSignal(list, now, cfg);
  if (pressure) {
    return {
      flush: true,
      reason: `mention_pressure:${pressure.reason}:${pressure.targetId}:${pressure.count}/${pressure.authors}`,
      urgent: true,
    };
  }

  if (list.length >= cfg.softMessageLimit) {
    return { flush: true, reason: `soft_message_limit:${list.length}`, urgent: false };
  }

  const tokens = tokenEstimateForBuffer(list, estimateTokensFn);
  if (tokens >= cfg.softTokenLimit) {
    return { flush: true, reason: `soft_token_limit:${tokens}`, urgent: false };
  }

  const oldest = oldestBufferedAt(list);
  if (oldest != null && now - oldest >= cfg.maxBufferAgeMs) {
    return { flush: true, reason: `max_buffer_age:${Math.round((now - oldest) / 1000)}s`, urgent: false };
  }

  const newestAt = newestBufferedAt(list);
  if (
    newestAt != null &&
    list.length >= cfg.quietMinMessages &&
    now - newestAt >= cfg.quietWindowMs
  ) {
    return { flush: true, reason: `quiet_window:${Math.round((now - newestAt) / 1000)}s/${list.length}`, urgent: false };
  }

  return { flush: false, reason: null, urgent: false };
}

module.exports = {
  batchPolicyConfig,
  shouldFlushBuffer,
  riskSignalsForMessage,
  mentionPressureSignal,
  oldestBufferedAt,
  newestBufferedAt,
  tokenEstimateForBuffer,
  DEFAULT_SOFT_TOKEN_LIMIT,
  DEFAULT_SOFT_MESSAGE_LIMIT,
  DEFAULT_MAX_BUFFER_AGE_MS,
  DEFAULT_QUIET_WINDOW_MS,
};
