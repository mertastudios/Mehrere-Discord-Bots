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
          personal_message: { type: 'STRING', description: 'Persönliche Nachricht an den Nutzer, {USER} als Platzhalter für die Erwähnung' },
        },
        required: ['message_id', 'action', 'primary', 'reason', 'personal_message'],
      },
    },
    chat_reply: { type: 'STRING', description: 'Optional: lockere Antwort an den Chat, wenn NIEMAND moderiert wurde' },
  },
  required: ['moderations'],
};

const SAFETY_OFF = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_NONE' }));

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

function buildRequestBody({ systemPrompt, userPrompt, withExtras = true }) {
  const generationConfig = {
    temperature: 0.35,
    topP: 0.9,
    // Aktuelle Flash-Lite-Generationen erlauben laut Modelldokumentation
    // deutlich mehr Output-Tokens. Für unser festes Moderations-JSON reichen
    // 4.096 völlig aus und lassen unnötig große Antworten/Tokenverbrauch nicht zu.
    maxOutputTokens: 4096,
    responseMimeType: 'application/json',
  };
  if (withExtras) {
    generationConfig.responseSchema = RESPONSE_SCHEMA;
    // Thinking komplett aus – kostet sonst Zeit und Output-Tokens, ohne
    // Mehrwert für dieses einfache Klassifikations-/JSON-Format.
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig,
  };
  if (withExtras) body.safetySettings = SAFETY_OFF;
  return body;
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
  fetchFn,
  sleepFn,
  maxQuickRetries,
  timeoutMs,
}) {
  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(chosenModel)}:generateContent`;
  const attempts = Math.max(1, maxQuickRetries + 1);
  let lastFailure = { ok: false, error: 'retry_exhausted' };

  for (let attempt = 0; attempt < attempts; attempt++) {
    // Fallback-Kaskade: Manuelle Gemini-Versionen akzeptieren teils weder
    // thinkingConfig noch responseSchema/BLOCK_NONE. Wir probieren es erst
    // mit voller Ausstattung und degradieren bei 400 auf das nötige Minimum.
    for (const withExtras of [true, false]) {
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
            buildRequestBody({ systemPrompt, userPrompt, withExtras })
          ),
          signal: controller.signal,
        });
      } catch (err) {
        const error = err?.name === 'AbortError' ? 'timeout' : 'network_error';
        lastFailure = { ok: false, error, message: err?.message };
        break; // Netzwerkfehler -> kein Schema-Fallback nötig, äußerer Retry greift
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        let data;
        try {
          data = await res.json();
        } catch {
          lastFailure = { ok: false, error: 'bad_json_response' };
          break;
        }
        return { ok: true, data, model: chosenModel };
      }

      const errText = await res.text().catch(() => '');
      let detail = errText;
      try {
        detail = extractErrorText(JSON.parse(errText), res);
      } catch {}
      lastFailure = { ok: false, status: res.status, error: `api_error_${res.status}`, message: String(detail).slice(0, 500) };

      // 400 = vermutlich ein optionales Feld abgelehnt -> einmal ohne Extras versuchen.
      if (res.status === 400 && withExtras) continue;
      break;
    }

    if (lastFailure?.ok) break;
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
    chat_reply: String(data?.chat_reply || '').slice(0, 1500) || null,
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
