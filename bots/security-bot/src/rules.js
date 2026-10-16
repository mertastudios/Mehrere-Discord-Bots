/**
 * ============================================================================
 *  Regelwerk
 *
 *  Aufbau:
 *   1. SYSTEMREGELN  – die normalen Discord-Regeln (Hass, Drohungen, NSFW,
 *      Spam, Doxxing …). Sie sind IMMER aktiv und können nicht entfernt werden.
 *   2. SERVERREGELN  – die eigenen Regeln des Servers (manuell eingegeben oder
 *      aus einer Kanal-Nachricht importiert). Jede Zeile wird zu einer Regel
 *      mit eigener ID (C1, C2, …), damit die KI sie im Log exakt benennen kann.
 *
 *  Limits: maximal MAX_RULES_CHARS Zeichen Serverregeln (Import wird darauf
 *  gekürzt) und MAX_INSTRUCTIONS_CHARS für die zusätzlichen KI-Anweisungen.
 * ============================================================================
 */

const MAX_RULES_CHARS = 4000;
const MAX_INSTRUCTIONS_CHARS = 2000;

/** Regeln, die Discord selbst vorgibt bzw. die immer gelten. Nicht änderbar. */
const SYSTEM_RULES = [
  {
    id: 'S1',
    label: 'Beleidigung & Belästigung',
    text: 'Beleidigungen, Beschimpfungen, sexuelle Anzüglichkeiten gegen Personen sowie gezieltes Belästigen sind verboten.',
  },
  {
    id: 'S2',
    label: 'Hass & Diskriminierung',
    text: 'Hassrede, Diskriminierung oder Abwertung wegen Herkunft, Religion, Geschlecht, Sexualität, Behinderung oder Hautfarbe sind verboten.',
  },
  {
    id: 'S3',
    label: 'Drohungen & Gewalt',
    text: 'Drohungen, Gewaltaufrufe, Wünsche von Tod oder schwerer Krankheit ("kys", "RIP", "ich ficke dich") sowie Gewaltverherrlichung sind verboten.',
  },
  {
    id: 'S4',
    label: 'Sexuelle Inhalte & Schutz Minderjähriger',
    text: 'Pornografie, sexuelle Darstellungen, sexuelle Avancen und jede sexualisierte Ansprache Minderjähriger sind verboten.',
  },
  {
    id: 'S5',
    label: 'Illegales & Gefährliches',
    text: 'Anleitungen oder Handel zu Drogen, Waffen, Raub, Hacking oder Schadsoftware sowie Inhalte zu Selbstverletzung/Suizid sind verboten (bei Suizid-Hinweisen: Hilfe anbieten, nicht bestrafen).',
  },
  {
    id: 'S6',
    label: 'Spam & Werbung',
    text: 'Nachrichtenflut, Wiederholungen, Großtext-Wände, fremde Server-Einladungen, Werbung und unnötiges Markieren (@everyone/@here, Massen-Pings) sind verboten.',
  },
  {
    id: 'S7',
    label: 'Doxxing & Privatsphäre',
    text: 'Das Teilen privater Daten anderer (echter Name, Adresse, Nummer, Bilder, Arbeitgeber, Schule, Wohnort) ist verboten.',
  },
  {
    id: 'S8',
    label: 'Scam & Phishing',
    text: 'Betrugs-, Phishing-, Token-Grabber- oder Malware-Links sowie der Versuch, an Konten oder Daten zu kommen, sind verboten.',
  },
  {
    id: 'S9',
    label: 'Mobbing & Nachtreten',
    text: 'Mobbing, Ausgrenzung, Dogpiling (mehrere auf eine Person) und ständiges Nachtreten gegen eine Person sind verboten.',
  },
  {
    id: 'S10',
    label: 'Umgehung & Alt-Accounts',
    text: 'Das Umgehen von Strafen mit Zweit-/Alt-Accounts, das Ignorieren von Moderationsanweisungen und das Ausnutzen von Regel-Lücken zum Schaden anderer sind verboten.',
  },
  {
    id: 'S11',
    label: 'Discord-Regeln',
    text: 'Die Discord-Community-Richtlinien und Nutzungsbedingungen gelten immer – auch für Dinge, die hier nicht ausdrücklich stehen.',
  },
];

/** Zerlegt die Serverregeln in nummerierte Einzelregeln (eine Zeile = eine Regel). */
function parseCustomRules(text) {
  const raw = String(text ?? '').replace(/\r/g, '');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line, index) => {
    // Aufzählungszeichen und Nummerierung am Anfang entfernen
    const clean = line.replace(/^\s*(?:[-*•·>]+|\d+[.)])\s*/, '').trim() || line;
    return {
      id: `C${index + 1}`,
      label: clean.length > 80 ? `${clean.slice(0, 77)}…` : clean,
      text: clean,
    };
  });
}

/** Kürzt Serverregeln auf das Zeichenlimit (mit Hinweis für den Admin). */
function clampRules(text) {
  const value = String(text ?? '');
  if (value.length <= MAX_RULES_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_RULES_CHARS), truncated: true };
}

function clampInstructions(text) {
  const value = String(text ?? '');
  if (value.length <= MAX_INSTRUCTIONS_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_INSTRUCTIONS_CHARS), truncated: true };
}

/** Alle Regeln (System + Server) als Liste – IDs bleiben stabil. */
function allRules(customText) {
  return [...SYSTEM_RULES, ...parseCustomRules(customText)];
}

/** Regel-Label zu einer ID (für Logs und Prompt). */
function ruleLabel(id, customText) {
  const found = allRules(customText).find((r) => r.id === String(id || '').trim().toUpperCase());
  return found ? `${found.id} ${found.label}` : null;
}

/**
 * Der Regelblock für den Prompt. Systemregeln zuerst (klar als unveränderlich
 * markiert), dann die Serverregeln – oder ein Hinweis, dass es keine gibt.
 */
function buildRulesBlock(customText) {
  const custom = parseCustomRules(customText);
  const lines = [
    '=== SYSTEMREGELN (Discord + Basisschutz, IMMER aktiv, nicht änderbar) ===',
    ...SYSTEM_RULES.map((r) => `${r.id} [${r.label}] ${r.text}`),
  ];
  if (custom.length) {
    lines.push('', '=== SERVERREGELN (von den Admins dieses Servers) ===');
    lines.push(...custom.map((r) => `${r.id} [${r.label}] ${r.text}`));
  } else {
    lines.push('', '=== SERVERREGELN ===', '(keine eigenen Regeln hinterlegt – es gelten nur die Systemregeln)');
  }
  return lines.join('\n');
}

module.exports = {
  SYSTEM_RULES,
  MAX_RULES_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  parseCustomRules,
  clampRules,
  clampInstructions,
  allRules,
  ruleLabel,
  buildRulesBlock,
};
