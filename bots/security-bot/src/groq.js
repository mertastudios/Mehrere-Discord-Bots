/**
 * ============================================================================
 *  Groq-Client (OpenAI-kompatibel)
 *
 *  Ein Codepfad, keine Sonderwege:
 *    POST https://api.groq.com/openai/v1/chat/completions
 *    Antwort als JSON über `response_format: json_schema` (strict) – dadurch
 *    kann das Modell gar nichts anderes liefern als unsere Struktur.
 *
 *  Modelle (per Env überschreibbar):
 *    schnell / günstig  → openai/gpt-oss-20b   (Vorprüfung: ist da was?)
 *    schlau   / Urteil  → openai/gpt-oss-120b  (Moderation + Begründung)
 *  Weitere Modelle der Kette werden bei 404/400 automatisch probiert.
 *
 *  Fehler werden klar klassifiziert (Key ungültig, Limit, Timeout, Modell
 *  fehlt), damit der Bot im Log-Kanal präzise melden kann – inklusive der
 *  Angabe, wann sich das Limit erneuert (Retry-After bzw. Reset-Header).
 * ============================================================================
 */

const BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_FAST_MODEL = 'openai/gpt-oss-20b';
const DEFAULT_SMART_MODEL = 'openai/gpt-oss-120b';

// Fallback-Kette: wird nur genutzt, wenn Groq ein Modell ablehnt (404/400).
const MODEL_CHAIN = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openai/gpt-oss-safeguard-20b'];

const REQUEST_TIMEOUT_MS = 60_000;

function modelFromEnv(env, kind) {
  const key = kind === 'fast' ? 'SECURITY_GROQ_MODEL_FAST' : 'SECURITY_GROQ_MODEL_SMART';
  const value = String(env?.(key, '') || '').trim();
  return value || (kind === 'fast' ? DEFAULT_FAST_MODEL : DEFAULT_SMART_MODEL);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Zahl aus einem Header (z. B. "3.5s", "120ms", "12"). */
function parseHeaderDuration(value) {
  if (!value) return null;
  const s = String(value).trim();
  const num = Number.parseFloat(s);
  if (!Number.isFinite(num)) return null;
  if (/ms$/i.test(s)) return Math.round(num);
  if (/s$/i.test(s)) return Math.round(num * 1000);
  if (/m$/i.test(s)) return Math.round(num * 60_000);
  if (/h$/i.test(s)) return Math.round(num * 3_600_000);
  return Math.round(num * 1000);
}

function readLimitInfo(res) {
  const get = (name) => (typeof res?.headers?.get === 'function' ? res.headers.get(name) : null);
  return {
    remainingRequests: get('x-ratelimit-remaining-requests'),
    remainingTokens: get('x-ratelimit-remaining-tokens'),
    resetRequestsMs: parseHeaderDuration(get('x-ratelimit-reset-requests')),
    resetTokensMs: parseHeaderDuration(get('x-ratelimit-reset-tokens')),
    retryAfterMs: parseHeaderDuration(get('retry-after')),
  };
}

/** Robuster JSON-Parser: erst direkt, dann der erste {…}-Block im Text. */
function parseJsonLoose(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* weiter unten weiterversuchen */
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Ein Groq-Aufruf.
 *
 * @param {object} params
 * @param {string} params.apiKey
 * @param {string} params.model
 * @param {string} params.system
 * @param {string} params.user
 * @param {object} [params.schema]          JSON-Schema (strict) – empfohlen
 * @param {string} [params.schemaName]
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @param {string} [params.reasoningEffort] 'low' | 'medium' | 'high'
 * @param {Function} [params.fetchFn]
 * @param {number} [params.timeoutMs]
 */
async function callGroq({
  apiKey,
  model,
  system,
  user,
  schema = null,
  schemaName = 'antwort',
  maxTokens = 1500,
  temperature = 0.4,
  reasoningEffort = null,
  fetchFn = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (!apiKey || !String(apiKey).trim()) return { ok: false, error: 'missing_api_key' };
  if (typeof fetchFn !== 'function') return { ok: false, error: 'fetch_unavailable' };
  if (!String(system || '').trim() || !String(user || '').trim()) return { ok: false, error: 'empty_prompt' };

  const messages = [
    { role: 'system', content: String(system) },
    { role: 'user', content: String(user) },
  ];

  // Versuche: 1) strict json_schema  2) json_object  3) freier Text (JSON im Text)
  const variants = [];
  if (schema) variants.push({ id: 'schema', response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } } });
  if (schema) variants.push({ id: 'json_object', response_format: { type: 'json_object' } });
  variants.push({ id: 'plain' });

  let last = { ok: false, error: 'unknown' };

  for (const variant of variants) {
    const body = {
      model,
      messages,
      temperature,
      max_completion_tokens: maxTokens,
    };
    if (variant.response_format) body.response_format = variant.response_format;
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    let res;
    try {
      res = await fetchFn(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${String(apiKey).trim()}`,
          'User-Agent': 'discord-security-bot/2.0',
        },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      const timeout = err?.name === 'AbortError';
      last = { ok: false, error: timeout ? 'timeout' : 'network_error', message: err?.message, model, variant: variant.id };
      break; // Netzwerkfehler → äußerer Retry (kein Variantenwechsel nötig)
    } finally {
      if (timer) clearTimeout(timer);
    }

    const limits = readLimitInfo(res);

    if (res.ok) {
      let data;
      try {
        data = await res.json();
      } catch {
        last = { ok: false, error: 'bad_json_response', model, variant: variant.id, limits };
        break;
      }
      const text = data?.choices?.[0]?.message?.content ?? '';
      const parsed = parseJsonLoose(text);
      const usage = data?.usage || {};
      if (!String(text).trim()) {
        // 200, aber leer (z. B. Reasoning hat alles aufgebraucht) → nächste Variante
        last = {
          ok: false,
          error: 'empty_response',
          message: `finish_reason=${data?.choices?.[0]?.finish_reason || 'unbekannt'}`,
          model,
          variant: variant.id,
          usage,
          limits,
        };
        continue;
      }
      return {
        ok: true,
        model: data?.model || model,
        variant: variant.id,
        text,
        json: parsed,
        usage: {
          promptTokens: Number(usage.prompt_tokens) || 0,
          completionTokens: Number(usage.completion_tokens) || 0,
          totalTokens: Number(usage.total_tokens) || 0,
        },
        limits,
      };
    }

    // Fehlerfall
    const errText = await res.text().catch(() => '');
    let detail = errText;
    let payload = null;
    try {
      payload = JSON.parse(errText);
      detail = payload?.error?.message || errText;
    } catch {
      /* Text bleibt */
    }
    const status = res.status;
    const info = {
      ok: false,
      status,
      model,
      variant: variant.id,
      message: String(detail || '').slice(0, 300),
      limits,
      retryAfterMs: limits.retryAfterMs,
    };

    if (status === 401 || status === 403) {
      return { ...info, error: 'invalid_api_key' };
    }
    if (status === 429) {
      const wait = info.retryAfterMs || 20_000;
      return { ...info, error: 'rate_limited', retryAfterMs: wait };
    }
    if (status === 404) {
      last = { ...info, error: 'model_not_found' };
      break; // anderes Modell (äußere Kette)
    }
    if (status === 400) {
      // Häufigster Grund: dieses Modell kann kein strict json_schema → Variante wechseln
      const schemaProblem = /response_format|json_schema|schema/i.test(String(detail || ''));
      if (schemaProblem && variant.id !== 'plain') {
        last = { ...info, error: 'schema_unsupported' };
        continue;
      }
      return { ...info, error: 'bad_request' };
    }
    if (status >= 500) {
      last = { ...info, error: 'server_error' };
      break; // äußerer Retry
    }
    return { ...info, error: `api_error_${status}` };
  }

  return last;
}

/**
 * Führt einen Aufruf über die Modell-Kette aus: Wunschmodell zuerst, danach die
 * anderen bekannten Groq-Modelle (nur bei Modell-Fehlern, nicht bei Limits).
 */
async function callGroqWithFallback({ model, fetchFn, ...rest }) {
  const tried = [];
  for (const candidate of [model, ...MODEL_CHAIN].filter((m, i, arr) => m && arr.indexOf(m) === i)) {
    tried.push(candidate);
    const result = await callGroq({ ...rest, model: candidate, fetchFn });
    if (result.ok) {
      if (tried.length > 1) result.fallbackFrom = model;
      return result;
    }
    if (!['model_not_found', 'schema_unsupported', 'bad_request'].includes(result.error)) {
      return result; // Limit/Netz/Key → kein Modellwechsel sinnvoll
    }
  }
  return { ok: false, error: 'all_models_failed', tried };
}

/** Kurzer Live-Test des Keys (für Setup-Schritt 7). */
async function validateGroqKey({ apiKey, model, fetchFn = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const started = Date.now();
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, ms: Date.now() - started, error: 'missing_api_key' };
  if (typeof fetchFn !== 'function') return { ok: false, ms: Date.now() - started, error: 'fetch_unavailable' };

  // Do not spend tokens or rely on generated text to validate credentials.
  // Reasoning models can legitimately return an empty `content` field when the
  // completion budget is small, even though the API key itself is valid.
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchFn(`${BASE_URL}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'User-Agent': 'discord-security-bot/2.0',
      },
      signal: controller?.signal,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    const timeout = err?.name === 'AbortError';
    return {
      ok: false,
      ms: Date.now() - started,
      error: timeout ? 'timeout' : 'network_error',
      message: err?.message,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }

  const ms = Date.now() - started;
  const limits = readLimitInfo(response);
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* a malformed response is reported below without exposing the key */
  }

  if (response.ok) {
    if (!Array.isArray(body?.data)) {
      return { ok: false, ms, error: 'bad_json_response', status: response.status, limits };
    }
    return { ok: true, ms, model: model || DEFAULT_FAST_MODEL, modelCount: body.data.length };
  }

  const detail = String(body?.error?.message || body?.message || '').slice(0, 300);
  const status = Number(response.status) || 0;
  const common = { ok: false, ms, status, message: detail, limits };
  if (status === 401 || status === 403) return { ...common, error: 'invalid_api_key' };
  if (status === 429) return { ...common, error: 'rate_limited', retryAfterMs: limits.retryAfterMs || 20_000 };
  if (status >= 500) return { ...common, error: 'server_error' };
  return { ...common, error: `api_error_${status || 'unknown'}` };
}

/** Limiter fürs äußere Retry-Verhalten (429/5xx/Netz). */
function nextBackoffMs(attempt, { base = 20_000, max = 15 * 60_000 } = {}) {
  return Math.min(max, base * Math.pow(3, Math.max(0, attempt)));
}

module.exports = {
  BASE_URL,
  DEFAULT_FAST_MODEL,
  DEFAULT_SMART_MODEL,
  MODEL_CHAIN,
  callGroq,
  callGroqWithFallback,
  validateGroqKey,
  parseJsonLoose,
  parseHeaderDuration,
  nextBackoffMs,
  modelFromEnv,
  sleep,
};
