/**
 * ============================================================================
 *  Unsichtbarer Speicher in der Nachricht (statt Datenbank)
 *
 *  Die Feedback-Zähler (👍/👎) und die Liste der Strafregister-Einträge einer
 *  Log-Nachricht werden als Zero-Width-Blob DIREKT in die Log-Nachricht
 *  geschrieben – also ein unsichtbarer Platzhalter, keine Datenbanktabelle.
 *  Damit überlebt der Zähler auch Bot-Neustarts und jede Menge Spam.
 *
 *  Kodierung: Nutzlast (`sec1:{...json...}`) → UTF-8 → Hex → jedes Hex-Zeichen
 *  wird auf eines von 16 unsichtbaren Unicode-Zeichen abgebildet. Davor eine
 *  Signatur, damit fremde Zero-Width-Zeichen ignoriert werden.
 *
 *  Falls Discord einen Blob doch einmal entfernt, dekodiert er einfach nicht:
 *  Der Bot fällt dann auf Zähler 0 zurück – es geht nichts kaputt.
 * ============================================================================
 */

const ZW_ALPHABET =
  '\u200B' + // Zero Width Space
  '\u200C' + // Zero Width Non-Joiner
  '\u200D' + // Zero Width Joiner
  '\uFEFF' + // Zero Width No-Break Space
  '\u2060' + // Word Joiner
  '\u2061' +
  '\u2062' +
  '\u2063' +
  '\u2064' +
  '\u200E' + // Left-to-Right Mark
  '\u206A' +
  '\u206B' +
  '\u206C' +
  '\u206D' +
  '\u206E' +
  '\u206F';

const ZW_RUN_RE = new RegExp(`[${ZW_ALPHABET}]+`, 'g');
const SIGNATURE_HEX = '5c'; // „\“ – kommt in unseren Nutzlasten nie zuerst
const PREFIX = 'sec1:';

/**
 * Aufbau eines Blobs:  Signatur (2 Hex) + Länge (4 Hex, Bytes) + Nutzlast-Hex.
 * Die Längenangabe macht den Blob selbstbegrenzend: Hängt Discord (oder ein
 * anderes Tool) Zero-Width-Zeichen direkt davor oder dahinter, lässt sich
 * unser Blob trotzdem fehlerfrei lesen.
 */
function encodeHidden(value) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  if (!payload) return '';
  const bytes = Buffer.from(payload, 'utf8');
  const hex = bytes.toString('hex');
  const length = Math.min(0xffff, bytes.length).toString(16).padStart(4, '0');
  return (SIGNATURE_HEX + length + hex)
    .split('')
    .map((d) => ZW_ALPHABET[parseInt(d, 16)])
    .join('');
}

function decodeHidden(text) {
  const out = [];
  if (!text) return out;
  const runs = String(text).match(ZW_RUN_RE) || [];
  for (const run of runs) {
    // ALLE Blobs im Lauf finden (es können mehrere direkt aneinander liegen)
    let i = 0;
    while (i + 6 <= run.length) {
      const signature = [0, 1].map((k) => ZW_ALPHABET.indexOf(run[i + k]));
      const isOurs = signature[0] === parseInt(SIGNATURE_HEX[0], 16) && signature[1] === parseInt(SIGNATURE_HEX[1], 16);
      if (!isOurs) {
        i += 1;
        continue;
      }
      let length = '';
      let valid = true;
      for (let k = 2; k < 6; k++) {
        const idx = ZW_ALPHABET.indexOf(run[i + k]);
        if (idx === -1) {
          valid = false;
          break;
        }
        length += idx.toString(16);
      }
      if (!valid) {
        i += 1;
        continue;
      }
      const byteLength = parseInt(length, 16);
      const start = i + 6;
      const end = start + byteLength * 2;
      if (byteLength <= 0 || end > run.length) {
        i += 1;
        continue;
      }
      let hex = '';
      for (let k = start; k < end; k++) {
        const idx = ZW_ALPHABET.indexOf(run[k]);
        if (idx === -1) {
          valid = false;
          break;
        }
        hex += idx.toString(16);
      }
      if (valid) {
        try {
          const payload = Buffer.from(hex, 'hex').toString('utf8');
          if (payload) out.push(payload);
        } catch {
          /* ungültiger Blob → ignorieren */
        }
      }
      i = end;
    }
  }
  return out;
}

/** Baut den Blob für eine Log-Nachricht (Zähler + Bewerter + Strafregister-IDs). */
function encodeLogState(state) {
  return encodeHidden(`${PREFIX}${JSON.stringify(state)}`);
}

/**
 * Liest den Zustand aus einer bestehenden Log-Nachricht.
 * Rückfall: leerer Zustand (Zähler 0), wenn nichts gefunden wurde.
 */
function decodeLogState(text, { penalties = [] } = {}) {
  for (const raw of decodeHidden(text)) {
    if (!raw.startsWith(PREFIX)) continue;
    try {
      const parsed = JSON.parse(raw.slice(PREFIX.length));
      return {
        up: Number(parsed.up) || 0,
        down: Number(parsed.down) || 0,
        voters: parsed.voters && typeof parsed.voters === 'object' ? parsed.voters : {},
        penalties: Array.isArray(parsed.penalties) ? parsed.penalties.map(String) : penalties.map(String),
      };
    } catch {
      /* kaputter Blob → nächster */
    }
  }
  return { up: 0, down: 0, voters: {}, penalties: penalties.map(String) };
}

/** Entfernt alle Zero-Width-Blobs aus einem Text (vor dem Neuschreiben). */
function stripHidden(text) {
  return String(text ?? '').replace(ZW_RUN_RE, '');
}

module.exports = { encodeHidden, decodeHidden, encodeLogState, decodeLogState, stripHidden, PREFIX, ZW_ALPHABET };
