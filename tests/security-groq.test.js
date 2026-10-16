/**
 * Groq-Client: Erfolg, Key-Fehler, Rate-Limit, Schema-Fallback, Modell-Kette.
 * Alles über einen gefälschten fetch – keine echte API-Verbindung.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  callGroq,
  callGroqWithFallback,
  validateGroqKey,
  parseJsonLoose,
  parseHeaderDuration,
  nextBackoffMs,
  modelFromEnv,
  DEFAULT_FAST_MODEL,
  DEFAULT_SMART_MODEL,
} = require('../bots/security-bot/src/groq');

function fakeResponse({ status = 200, body = {}, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function okBody(content, { usage = { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 }, model = 'openai/gpt-oss-120b' } = {}) {
  return { model, choices: [{ message: { content }, finish_reason: 'stop' }], usage };
}

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

test('Erfolgreicher Aufruf liefert JSON, Modell und Tokenverbrauch', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return fakeResponse({ body: okBody('{"ok":true}') });
  };

  const result = await callGroq({
    apiKey: 'gsk_test',
    model: DEFAULT_SMART_MODEL,
    system: 'System',
    user: 'Verlauf',
    schema: SCHEMA,
    fetchFn,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.json, { ok: true });
  assert.equal(result.usage.totalTokens, 1020);
  assert.match(calls[0].url, /api\.groq\.com\/openai\/v1\/chat\/completions$/);
  assert.equal(calls[0].body.response_format.type, 'json_schema');
  assert.equal(calls[0].body.response_format.json_schema.strict, true);
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.equal(calls[0].body.messages[1].content, 'Verlauf');
});

test('Fehlender Key und leere Prompts werden abgefangen', async () => {
  assert.equal((await callGroq({ apiKey: '', system: 'a', user: 'b' })).error, 'missing_api_key');
  assert.equal((await callGroq({ apiKey: 'k', system: '', user: 'b' })).error, 'empty_prompt');
});

test('Ungültiger Key wird klar klassifiziert', async () => {
  const fetchFn = async () => fakeResponse({ status: 401, body: { error: { message: 'Invalid API Key' } } });
  const result = await callGroq({ apiKey: 'gsk_x', model: DEFAULT_SMART_MODEL, system: 's', user: 'u', fetchFn });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_api_key');
  assert.equal(result.status, 401);
});

test('Rate-Limit liefert Wartezeit aus Retry-After und Reset-Headern', async () => {
  const fetchFn = async () =>
    fakeResponse({
      status: 429,
      body: { error: { message: 'Rate limit reached' } },
      headers: { 'retry-after': '12', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '35.4s' },
    });

  const result = await callGroq({ apiKey: 'gsk_x', model: DEFAULT_SMART_MODEL, system: 's', user: 'u', fetchFn });
  assert.equal(result.error, 'rate_limited');
  assert.equal(result.retryAfterMs, 12_000);
  assert.equal(result.limits.remainingTokens, '0');
  assert.equal(result.limits.resetTokensMs, 35_400);
});

test('Models ohne strict-Schema fallen automatisch auf JSON-Modus zurück', async () => {
  const variants = [];
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    variants.push(body.response_format?.type);
    if (body.response_format?.type === 'json_schema') {
      return fakeResponse({ status: 400, body: { error: { message: 'response_format json_schema is not supported for this model' } } });
    }
    return fakeResponse({ body: okBody('{"ok":true}') });
  };

  const result = await callGroq({ apiKey: 'gsk_x', model: DEFAULT_SMART_MODEL, system: 's', user: 'u', schema: SCHEMA, fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.variant, 'json_object');
  assert.deepEqual(variants, ['json_schema', 'json_object']);
});

test('Nicht verfügbares Modell → nächstes Modell der Kette', async () => {
  const models = [];
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    models.push(body.model);
    if (body.model === 'openai/gpt-oss-9999') {
      return fakeResponse({ status: 404, body: { error: { message: 'model not found' } } });
    }
    return fakeResponse({ body: okBody('{"ok":true}', { model: body.model }) });
  };

  const result = await callGroqWithFallback({
    apiKey: 'gsk_x',
    model: 'openai/gpt-oss-9999',
    system: 's',
    user: 'u',
    schema: SCHEMA,
    fetchFn,
  });

  assert.equal(result.ok, true);
  assert.equal(result.fallbackFrom, 'openai/gpt-oss-9999');
  assert.deepEqual(models, ['openai/gpt-oss-9999', DEFAULT_SMART_MODEL]);
});

test('Netzwerkfehler und Timeout werden nicht als Schema-Problem interpretiert', async () => {
  const network = await callGroq({
    apiKey: 'k',
    model: DEFAULT_SMART_MODEL,
    system: 's',
    user: 'u',
    fetchFn: async () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.equal(network.error, 'network_error');

  const timeout = await callGroq({
    apiKey: 'k',
    model: DEFAULT_SMART_MODEL,
    system: 's',
    user: 'u',
    fetchFn: async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  });
  assert.equal(timeout.error, 'timeout');
});

test('JSON wird auch aus Fließtext gerettet', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Klar! Hier ist das JSON: {"a":[1,2]} — fertig.'), { a: [1, 2] });
  assert.equal(parseJsonLoose('kein json'), null);
});

test('Live-Key-Test prüft Authentifizierung über /models statt einer leeren Modell-Antwort', async () => {
  const calls = [];
  const good = await validateGroqKey({
    apiKey: 'gsk_ok',
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return fakeResponse({ body: { object: 'list', data: [{ id: DEFAULT_FAST_MODEL }] } });
    },
  });
  assert.equal(good.ok, true);
  assert.equal(typeof good.ms, 'number');
  assert.match(calls[0].url, /api\.groq\.com\/openai\/v1\/models$/);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.match(calls[0].options.headers.Authorization, /^Bearer gsk_ok$/);

  const bad = await validateGroqKey({
    apiKey: 'gsk_bad',
    fetchFn: async () => fakeResponse({ status: 401, body: { error: { message: 'Invalid API Key' } } }),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_api_key');
});

test('Header-Dauern, Backoff und Modellnamen aus der Umgebung', () => {
  assert.equal(parseHeaderDuration('250ms'), 250);
  assert.equal(parseHeaderDuration('3.5s'), 3500);
  assert.equal(parseHeaderDuration('2m'), 120_000);
  assert.equal(parseHeaderDuration(null), null);

  assert.equal(nextBackoffMs(0), 20_000);
  assert.ok(nextBackoffMs(3) > nextBackoffMs(1));
  assert.ok(nextBackoffMs(99) <= 15 * 60_000);

  assert.equal(modelFromEnv((k, d) => d), DEFAULT_SMART_MODEL);
  assert.equal(modelFromEnv((k, d) => (k === 'SECURITY_GROQ_MODEL_FAST' ? 'llama-3.1-8b-instant' : d), 'fast'), 'llama-3.1-8b-instant');
});
