/**
 * Google Gemini API Anbindung für den Sicherheitsbot.
 *
 * - Nutzt standardmäßig den von Google gepflegten Alias `gemini-flash-lite-latest`
 *   (immer die aktuell günstigste Flash-Lite-Generation) – überschreibbar per
 *   SECURITY_GEMINI_MODEL, falls ein Server ein festes Modell pinnen will.
 * - Lehnt Google ein Modell mit 404 ("no longer available"/nicht gefunden)
 *   ab, probiert callGemini automatisch die nächsten Modelle aus
 *   MODEL_FALLBACK_CHAIN durch – innerhalb DESSELBEN Aufrufs, ohne auf den
 *   nächsten Batch-Retry warten zu müssen.
 * - Erzwingt JSON-Output via responseSchema (Structured Output).
 * - Deaktiviert Gemini-eigene Safety-Filter: Ein Moderationsbot MUSS den
 *   toxischen Chat ja lesen können, um ihn bewerten zu dürfen.
 * - Ein kurzer interner Sofort-Retry (429/5xx/Netzwerk), die langen Batch-
 *   Retries mit Backoff übernimmt der Moderator (siehe moderator.js).
 */

// `gemini-flash-lite-latest` ist ein von Google selbst gepflegter Alias, der
// immer auf die aktuell günstigste, verfügbare Flash-Lite-Generation zeigt.
// Anders als eine fest gepinnte Versionsnummer (z. B. gemini-2.5-flash-lite,
// das Google zwischenzeitlich für neue Nutzer/Keys deaktiviert hat) migriert
// Google diesen Alias selbst weiter, sobald eine Generation abgeschaltet
// wird – ein Code-Deploy ist dafür nicht mehr nötig.
const DEFAULT_GEMINI_MODEL = 'gemini-flash-lite-latest';
// Zusätzliches Sicherheitsnetz: Lehnt Google ein Modell mit 404
// ("no longer available"/nicht gefunden) ab, probiert callGemini
// automatisch die nächsten Modelle dieser Kette durch, BEVOR der Batch als
// fehlgeschlagen gilt. So blockiert ein einzelnes abgeschaltetes Modell nie
// wieder tagelang die komplette Moderation.
const MODEL_FALLBACK_CHAIN = [
  'gemini-flash-lite-latest',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-flash',
];
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT_MS = 90_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const FATAL_STATUS = new Set([400, 401, 403]); // Bad Request / Key ungültig / Key ohne Zugang
const MODEL_NOT_FOUND_STATUS = 404; // Modell existiert nicht (mehr) / für diesen Key nicht verfügbar

// Entfernte Struktur der erzwungenen Gemini-Antwort. Die Felder sind im
// System-Prompt (prompts.js) ausführlich erklärt – das Schema erzwingt nur
// noch die Form (JSON, Typen, Enums).
//
// WICHTIG: Das Schema kennt AUSSCHLIESSLICH "moderations". Ein früher
// vorhandenes Feld "chat_reply" verleitete das Modell dazu, auch ohne jeden
// Verstoß Small-Talk in den Chat zu posten ("Hey zusammen! Hier ist alles
// entspannt ... 👋"). Ein Sicherheitsbot moderiert – er plaudert nicht.
// Ohne das Feld im Schema kann das Modell gar nichts anderes zurückgeben.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    moderations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          message_id: { type: 'INTEGER', description: 'ID der Nachricht aus dem Chat-Verlauf' },
          action: { type: 'STRING', enum: ['warn', 'timeout'] },
          duration: { type: 'STRING', enum: ['1m', '5m', '10m', '1h', '1d', '1w'], description: 'Nur bei action=timeout' },
          primary: { type: 'BOOLEAN', description: 'true für GENAU EINE Moderation: der schwerwiegendste Verstoß' },
          reason: { type: 'STRING', description: 'Kurze Begründung, gegen welche Regel verstoßen wurde' },
          personal_message: { type: 'STRING', description: 'Ausführlich begründete persönliche Nachricht an den Nutzer (4-8 Sätze: konkreter Inhalt, betroffene Regel, Kontext, Maßnahmen-Begründung, Verhaltenshinweis), {USER} als Platzhalter für die Erwähnung' },
        },
        required: ['message_id', 'action', 'primary', 'reason', 'personal_message'],
      },
    },
  },
  required: ['moderations'],
};

// ---------------------------------------------------------------------------
// Safety-Filter: Ein Moderationsbot MUSS toxische Inhalte lesen dürfen.
//
// Google blockiert sonst schon die Eingabe (promptFeedback.blockReason) oder
// die Generierung (candidates[0].finishReason = "SAFETY") – genau bei den
// schweren Verstößen, für die man den Bot eigentlich braucht. Das äußerte sich
// bisher als `invalid_model_response (empty_response)`.
//
// Deshalb: ALLE Kategorien (inkl. CIVIC_INTEGRITY) explizit abschalten.
// `OFF` ist die härteste Stufe der aktuellen Gemini-Generationen; ältere
// Modelle kennen nur `BLOCK_NONE`. Beides wird nacheinander probiert.
// ---------------------------------------------------------------------------
const SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
];
// Nur neuere Modelle kennen diese Kategorie – sie steht deshalb separat und
// wird nur in den ersten Varianten mitgeschickt (400 => nächste Variante).
const SAFETY_CATEGORY_CIVIC = 'HARM_CATEGORY_CIVIC_INTEGRITY';

function safetySettings(threshold, { withCivic = false } = {}) {
  const categories = withCivic ? [...SAFETY_CATEGORIES, SAFETY_CATEGORY_CIVIC] : SAFETY_CATEGORIES;
  return categories.map((category) => ({ category, threshold }));
}

const SAFETY_OFF = safetySettings('OFF', { withCivic: true });
const SAFETY_BLOCK_NONE = safetySettings('BLOCK_NONE');

/**
 * Varianten-Leiter für EINEN Modellaufruf. Jede Variante wird der Reihe nach
 * probiert, sobald die vorherige mit HTTP 400 (Feld nicht unterstützt) oder
 * mit einer LEEREN Antwort (Safety-Block, MAX_TOKENS, RECITATION) endet.
 *
 * Die Reihenfolge geht von „maximal abgesichert“ zu „maximal kompatibel“:
 *   1. Structured Output + thinking aus + Safety komplett OFF (inkl. Civic)
 *   2. dasselbe mit dem klassischen BLOCK_NONE (ältere Modelle)
 *   3. ohne responseSchema (nur JSON-MIME) – manche Modelle liefern mit
 *      Schema + toxischem Input gar nichts zurück
 *   4. blanker Aufruf ohne JSON-Zwang: Text wird nachträglich geparst
 */
const REQUEST_VARIANTS = [
  { id: 'schema_safety_off', schema: true, thinking: false, jsonMime: true, safety: SAFETY_OFF, maxOutputTokens: 8192 },
  { id: 'schema_block_none', schema: true, thinking: false, jsonMime: true, safety: SAFETY_BLOCK_NONE, maxOutputTokens: 8192 },
  { id: 'no_schema_block_none', schema: false, thinking: false, jsonMime: true, safety: SAFETY_BLOCK_NONE, maxOutputTokens: 8192 },
  { id: 'plain_text_block_none', schema: false, thinking: null, jsonMime: false, safety: SAFETY_BLOCK_NONE, maxOutputTokens: 4096 },
  { id: 'bare', schema: false, thinking: null, jsonMime: false, safety: null, maxOutputTokens: 4096 },
];

/** finishReason-Werte, die bedeuten: „Das Modell hat die Arbeit verweigert“. */
const BLOCKED_FINISH_REASONS = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modelFromEnv(env) {
  const raw = String(env?.('SECURITY_GEMINI_MODEL', '') || '').trim();
  return raw || DEFAULT_GEMINI_MODEL;
}

/**
 * Grobe Token-Schätzung ohne Tokenizer: Gemini liegt bei europäischen Sprachen
 * bei ~3-4 Zeichen/Token. Wir rechnen konservativ mit 3 Zeichen/Token, damit
 * das Limit eher früher als später erreicht wird (nie blinde API-Fehler).
 */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3);
}

function extractErrorText(payload, res) {
  if (payload) {
    const msg = payload?.error?.message || payload?.message;
    if (msg) return String(msg).slice(0, 500);
  }
  return `HTTP ${res?.status || '?'}`;
}

function retryAfterMsFromResponse(res, payload) {
  const header = res?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  const details = payload?.error?.details || payload?.details || [];
  for (const detail of Array.isArray(details) ? details : []) {
    const retryDelay = detail?.retryDelay || detail?.['retryDelay'];
    if (typeof retryDelay === 'string') {
      const seconds = Number.parseFloat(retryDelay.replace(/s$/i, ''));
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    }
  }
  return undefined;
}

function buildRequestBody({ systemPrompt, userPrompt, variant, responseSchema = RESPONSE_SCHEMA }) {
  const v = variant || REQUEST_VARIANTS[0];
  const generationConfig = {
    temperature: 0.35,
    topP: 0.9,
    // Aktuelle Flash-Lite-Generationen erlauben laut Modelldokumentation
    // deutlich mehr Output-Tokens. 8.192 deckt den Worst Case ab: 10 Moderationen
    // mit jeweils ausführlich begründeter personal_message (mehrere hundert Zeichen
    // pro Nachricht), ohne dass die JSON-Antwort mittendrin abgeschnitten wird.
    maxOutputTokens: v.maxOutputTokens || 8192,
  };
  if (v.jsonMime !== false) generationConfig.responseMimeType = 'application/json';
  if (v.schema && responseSchema) generationConfig.responseSchema = responseSchema;
  // Thinking komplett aus – kostet sonst Zeit und Output-Tokens, ohne
  // Mehrwert für dieses einfache Klassifikations-/JSON-Format. In den späten
  // Kompatibilitätsvarianten (thinking === null) wird das Feld weggelassen.
  if (v.thinking === false) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig,
  };
  // Safety-Filter deaktivieren: Der Bot IST die Moderation, er muss toxische
  // Sprache bewerten dürfen, statt von Google vorab blockiert zu werden.
  if (v.safety) body.safetySettings = v.safety;
  return body;
}

/**
 * Zerlegt eine erfolgreiche (HTTP 200) Antwort in Text + Diagnose.
 * Genau hier entstand bisher `empty_response`: HTTP 200, aber kein Text, weil
 * Google die Eingabe (promptFeedback.blockReason) oder die Ausgabe
 * (finishReason = SAFETY) blockiert hat.
 */
function inspectResponse(data) {
  const candidate = data?.candidates?.[0] || null;
  const parts = candidate?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim()
    : '';
  const finishReason = String(candidate?.finishReason || '').toUpperCase() || null;
  const blockReason = String(data?.promptFeedback?.blockReason || '').toUpperCase() || null;
  const blocked =
    Boolean(blockReason) || (finishReason ? BLOCKED_FINISH_REASONS.has(finishReason) : false);
  return { text, finishReason, blockReason, blocked, truncated: finishReason === 'MAX_TOKENS' };
}

/**
 * Führt Anfragen gegen GENAU EIN Modell durch (plus ein kurzer Sofort-Retry
 * bei Rate-Limit/Serverfehlern). Gibt niemals werfende Fehler zurück.
 */
async function callGeminiForModel({
  apiKey,
  systemPrompt,
  userPrompt,
  chosenModel,
  responseSchema,
  fetchFn,
  sleepFn,
  maxQuickRetries,
  timeoutMs,
}) {
  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(chosenModel)}:generateContent`;
  const attempts = Math.max(1, maxQuickRetries + 1);
  let lastFailure = { ok: false, error: 'retry_exhausted' };

  for (let attempt = 0; attempt < attempts; attempt++) {
    // Varianten-Kaskade: Manche Modelle akzeptieren weder thinkingConfig noch
    // responseSchema/OFF-Safety, und manche liefern bei hart toxischem Input
    // trotz HTTP 200 gar keinen Text (Safety-Block). Wir degradieren dann
    // Schritt für Schritt auf die kompatiblere Variante, statt sofort
    // aufzugeben – so bleibt gerade der schwere Verstoß moderierbar.
    let variantFailure = null;
    for (const variant of REQUEST_VARIANTS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey.trim(),
          },
          body: JSON.stringify(
            buildRequestBody({ systemPrompt, userPrompt, variant, responseSchema })
          ),
          signal: controller.signal,
        });
      } catch (err) {
        const error = err?.name === 'AbortError' ? 'timeout' : 'network_error';
        variantFailure = { ok: false, error, message: err?.message };
        break; // Netzwerkfehler -> keine Varianten-Kaskade nötig, äußerer Retry greift
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        let data;
        try {
          data = await res.json();
        } catch {
          variantFailure = { ok: false, error: 'bad_json_response' };
          break;
        }

        const info = inspectResponse(data);
        if (info.text) {
          return { ok: true, data, model: chosenModel, variant: variant.id, info };
        }

        // HTTP 200, aber kein Text: Safety-Block, MAX_TOKENS oder leeres
        // Kandidatenfeld. Nächste (weniger restriktive) Variante versuchen.
        variantFailure = {
          ok: false,
          error: 'empty_response',
          blocked: info.blocked,
          finishReason: info.finishReason,
          blockReason: info.blockReason,
          variant: variant.id,
          message:
            `Gemini lieferte keinen Text (variant=${variant.id}` +
            `${info.finishReason ? `, finish_reason=${info.finishReason}` : ''}` +
            `${info.blockReason ? `, block_reason=${info.blockReason}` : ''})`,
        };
        continue;
      }

      const errText = await res.text().catch(() => '');
      let detail = errText;
      let payload = null;
      try {
        payload = JSON.parse(errText);
        detail = extractErrorText(payload, res);
      } catch {}
      variantFailure = {
        ok: false,
        status: res.status,
        error: `api_error_${res.status}`,
        message: String(detail).slice(0, 500),
        retryAfterMs: retryAfterMsFromResponse(res, payload),
        variant: variant.id,
      };

      // 400 = ein optionales Feld wurde abgelehnt -> nächste Variante testen.
      if (res.status === 400) continue;
      break;
    }

    lastFailure = variantFailure || lastFailure;

    // Ein 404 ("Modell nicht (mehr) verfügbar") ist NICHT retry-würdig – hier
    // hilft nur ein anderes Modell (siehe callGemini-Fallback-Kette), kein
    // erneuter Versuch mit demselben Modellnamen.
    if (
      attempt + 1 < attempts &&
      lastFailure?.status &&
      RETRYABLE_STATUS.has(lastFailure.status)
    ) {
      await sleepFn(2_000);
      continue;
    }
    break;
  }

  return lastFailure;
}

/**
 * Führt einen generateContent-Aufruf durch. Nutzt zuerst das gewünschte
 * Modell (Parameter `model` > SECURITY_GEMINI_MODEL > DEFAULT_GEMINI_MODEL);
 * lehnt Google es mit 404 ("no longer available"/nicht gefunden) ab, werden
 * automatisch die restlichen Modelle aus MODEL_FALLBACK_CHAIN durchprobiert
 * – innerhalb DIESES Aufrufs, ohne auf den nächsten Batch-Retry zu warten.
 * Andere Fehler (429/5xx/400/Netzwerk) brechen die Modell-Kaskade sofort ab,
 * damit ein echter Ausfall nicht unnötig mehrfach abgefragt wird.
 */
async function callGemini({
  apiKey,
  systemPrompt,
  userPrompt,
  model,
  env,
  responseSchema = RESPONSE_SCHEMA,
  fetchFn = globalThis.fetch,
  sleepFn = sleep,
  maxQuickRetries = 1,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return { ok: false, error: 'missing_api_key' };
  }
  if (typeof fetchFn !== 'function') return { ok: false, error: 'fetch_unavailable' };
  if (!String(systemPrompt || '').trim() || !String(userPrompt || '').trim()) {
    return { ok: false, error: 'empty_prompt' };
  }

  const primaryModel = String(model || modelFromEnv(env)).trim();
  // Reihenfolge: erst das gewünschte Modell, danach die restliche Fallback-
  // Kette (dedupliziert, Reihenfolge bleibt erhalten).
  const modelsToTry = [primaryModel, ...MODEL_FALLBACK_CHAIN].filter(
    (m, index, arr) => m && arr.indexOf(m) === index
  );

  let lastFailure = { ok: false, error: 'retry_exhausted' };
  const triedModels = [];

  for (const chosenModel of modelsToTry) {
    triedModels.push(chosenModel);
    const result = await callGeminiForModel({
      apiKey,
      systemPrompt,
      userPrompt,
      chosenModel,
      responseSchema,
      fetchFn,
      sleepFn,
      maxQuickRetries,
      timeoutMs,
    });

    if (result.ok) {
      if (triedModels.length > 1) {
        result.fallbackFrom = primaryModel;
        result.triedModels = triedModels;
      }
      return result;
    }

    lastFailure = result;
    // Nur bei "Modell existiert nicht (mehr)" auf das nächste Modell
    // ausweichen – bei anderen Fehlern (Rate-Limit, Netzwerk, Server) würde
    // ein Modellwechsel das eigentliche Problem nur verschleiern.
    if (result.status !== MODEL_NOT_FOUND_STATUS) break;
  }

  if (triedModels.length > 1) lastFailure.triedModels = triedModels;
  return lastFailure;
}

/**
 * Live-Validierung eines Gemini API-Keys über den Models-Endpunkt.
 * Wird beim Speichern via /set_gemini_api_key aufgerufen, damit Tippfehler
 * sofort auffallen statt erst beim ersten Batch.
 */
async function validateApiKey({ apiKey, model, fetchFn = globalThis.fetch } = {}) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return { ok: false, error: 'missing_api_key' };
  }
  if (typeof fetchFn !== 'function') return { ok: false, error: 'fetch_unavailable' };

  const chosenModel = String(model || DEFAULT_GEMINI_MODEL).trim();
  const url = `${GEMINI_BASE_URL}/models?pageSize=1`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    let res;
    try {
      res = await fetchFn(url, {
        method: 'GET',
        headers: { 'x-goog-api-key': apiKey.trim() },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) return { ok: true };
    const errText = await res.text().catch(() => '');
    let detail = `HTTP ${res.status}`;
    try {
      detail = extractErrorText(JSON.parse(errText), res);
    } catch {}
    return { ok: false, status: res.status, error: detail, fatal: FATAL_STATUS.has(res.status) };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : 'network_error' };
  }
}

/**
 * Robustes JSON-Parsen der Modell-Antwort (falls das Modell trotz
 * responseSchema Codezäune liefert) + Grundvalidierung der Felder.
 */
function parseModerationJson(rawText) {
  let text = String(rawText || '').trim();
  if (!text) return { ok: false, error: 'empty_response' };

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'bad_json' };
  }

  // Antwort kann Objekt {moderations:[...]} oder direkt ein Array sein.
  const list = Array.isArray(data) ? data : data?.moderations;
  if (!Array.isArray(list)) return { ok: false, error: 'bad_shape' };

  const moderations = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const id = Number.parseInt(raw.message_id ?? raw.messageId ?? raw.id, 10);
    if (!Number.isFinite(id) || id < 1) continue;
    const action = String(raw.action || '').toLowerCase() === 'timeout' ? 'timeout' : 'warn';
    const duration = ['1m', '5m', '10m', '1h', '1d', '1w'].includes(String(raw.duration))
      ? String(raw.duration)
      : null;
    moderations.push({
      message_id: id,
      action,
      duration: action === 'timeout' ? (duration || '1h') : null,
      primary: raw.primary === true,
      reason: String(raw.reason || '').slice(0, 1000),
      personal_message: String(raw.personal_message || '').slice(0, 1500),
    });
  }

  return {
    ok: true,
    moderations,
    raw: data,
  };
}

/** Extrahiert den Text aus einer erfolgreichen generateContent-Antwort. */
function extractResponseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  REQUEST_VARIANTS,
  SAFETY_OFF,
  SAFETY_BLOCK_NONE,
  inspectResponse,
  MODEL_FALLBACK_CHAIN,
  GEMINI_BASE_URL,
  RESPONSE_SCHEMA,
  estimateTokens,
  callGemini,
  validateApiKey,
  parseModerationJson,
  extractResponseText,
  modelFromEnv,
};
