/**
 * Kleine Helfer für den sicheren Umgang mit API-Keys.
 */

/** Maskiert einen API-Key für Antworten/Logs: "AIzaSyA...abcd". */
function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '—';
  const trimmed = key.trim();
  if (trimmed.length <= 10) return '****';
  return `${trimmed.slice(0, 7)}...${trimmed.slice(-4)}`;
}

module.exports = { maskApiKey };
