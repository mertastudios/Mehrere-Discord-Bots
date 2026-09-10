/**
 * Prompt-Bau für die Gemini-Analyse.
 *
 * Aufbau der Anfrage:
 *   systemInstruction  = interner System-Prompt (Rolle, Antwortformat, Platzhalter,
 *                        Strafenregister der Teilnehmer, Sprachvorgabe).
 *   contents[user]     = Admin-Anweisungen (/set_prompt) + sauber formatierter
 *                        Chat-Verlauf (gruppiert nach Channels, IDs ab 1).
 *
 * Das Antwortformat ist ein festes JSON (siehe gemini.js RESPONSE_SCHEMA):
 *   { moderations: [{ message_id, action, duration, primary, reason,
 *                     personal_message }], chat_reply }
 */

const { t, LANGS } = require('./languages');

// Erlaubte Timeout-Dauern -> Sekunden (Discord erlaubt max. 28 Tage, 1w liegt sicher drin)
const DURATION_SECONDS = {
  '1m': 60,
  '5m': 300,
  '10m': 600,
  '1h': 3600,
  '1d': 86400,
  '1w': 604800,
};

function fmtUtc(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Strafenregister: Für jeden Teilnehmer des Verlaufs sichtbar machen, wie oft
 * er in den letzten 20 Tagen moderiert wurde. Gemini soll Eskalationen dann
 * selbst in der Maßnahmenwahl berücksichtigen.
 */
function buildPenaltyRegister({ participants, penaltyByUser, now = Date.now() }) {
  const lines = [];
  for (const p of participants) {
    const entry = penaltyByUser.get(p.authorId);
    if (!entry || entry.count === 0) {
      lines.push(`- ${p.authorName} (user_id=${p.authorId}): sauber – keine Moderationen in den letzten 20 Tagen`);
    } else {
      lines.push(
        `- ${p.authorName} (user_id=${p.authorId}): ${entry.count} Moderation(en) in den letzten 20 Tagen` +
          (entry.lastAt ? `, zuletzt ${fmtUtc(entry.lastAt)}` : '')
      );
    }
  }
  return lines.join('\n');
}

/**
 * Interner System-Prompt. Er ist bewusst streng beim FORMAT (JSON, IDs,
 * {USER}-Platzhalter, genau ein primary) und offen beim INHALT – Regeln,
 * Strenge und Maßnahmen bestimmt der Server-Admin via /set_prompt.
 */
function buildSystemPrompt({ guildName, lang, adminPrompt, participants, penaltyByUser, now = Date.now() }) {
  const languageName = LANGS[lang]?.name || 'Deutsch';
  const register = buildPenaltyRegister({ participants, penaltyByUser, now });

  return [
    'Du bist "OP Moderator", die KI-Sicherheitsmoderation des Discord-Servers',
    `"${guildName}". Du bewertest diskret einen gesammelten Chat-Verlauf und entscheidest,`,
    'ob jemand gegen die Serverregeln verstoßen hat. Du bist fair, mit Kontext denkend,',
    'deeskalierend und freundlich – aber bei echten Verstößen konsequent.',

    '== ANTWORTSPRACHE ==',
    `Antworte IMMER auf ${languageName}. Auch "reason" und "personal_message" müssen auf ${languageName} sein.`,

    '== SO LIEST DU DEN CHAT-VERLAUF ==',
    'Der Verlauf ist nach Kanälen gruppiert und chronologisch sortiert. Jede Nachricht hat',
    'eine eindeutige ID ab 1 und sieht so aus:',
    '  [ID] YYYY-MM-DD HH:MM UTC · Anzeigename (user_id=...):',
    '  | Nachrichtentext (mehrzeilig = mehrere | -Zeilen)',
    'Mentions, Rollen, Kanäle und Emojis wurden bereits in lesbaren Text umgewandelt.',
    'user_id ist die eindeutige, dauerhafte Discord-Nutzer-ID.',

    '== TEILNEHMER & STRAFENREGISTER (letzte 20 Tage) ==',
    'Diese Personen tauchen im Verlauf auf. Administratoren sind IMMER immun und tauchen',
    'deshalb nie im Verlauf auf – sie dürfen NIE moderiert werden:',
    register || '- (keine Teilnehmer)',

    '== DEINE ENTSCHEIDUNG ==',
    'Wichtig: In den meisten Chats macht NIEMAND etwas Schlimmes. Fasse deep – nutze den',
    'Kontext (Witze unter Freunden, Zitate, Reaktionen auf andere). Bestrafe nur echte,',
    'klare Verstöße gegen die Regeln. Bei mehreren Verstößen darfst du MEHRERE Personen',
    'gleichzeitig moderieren (eine moderation pro betroffener Nachricht).',

    'Maßnahmen (action):',
    '- "warn": Nur eine persönliche Ermahnung, kein Timeout. Für leichte Verstöße und',
    '  erste Auffälligkeiten.',
    '- "timeout": Timeouts sind nur in diesen Stufen erlaubt (duration): 1m, 5m, 10m, 1h,',
    '  1d, 1w. Wähle die Stufe passend zur Schwere und zur Vorgeschichte (siehe Register).',
    '  Für schwere/wiederholte Verstöße.',

    'personal_message Regeln:',
    '- Sprich den Nutzer direkt und respektvoll an, erkläre KURZ gegen welche Regel er',
    '  verstößt und warum die Maßnahme gerecht ist. Maximal 2-4 Sätze. Keine Beleidigungen,',
    '  keine Emojis-Ketten, keine Widersprüche zur Begründung.',
    '- Nutze EXAKT den Platzhalter {USER} an der Stelle, an der der Nutzer erwähnt werden',
    '  soll (das System ersetzt ihn durch die echte Discord-Erwähnung). Verwende niemals',
    '  echte Discord-Mention-Syntax (<@...>) und schreibe die user_id NICHT in den Text.',

    'primary Regeln:',
    '- Setze bei GENAU EINER moderation "primary": true – auf die Nachricht mit dem',
    '  SCHWERWIEGSTEN Verstoß des gesamten Verlaufs. Alle anderen bekommen "primary": false.',
    '- Wenn du niemanden moderierst, brauchst du kein primary.',

    'Wenn NIEMAND etwas falsch gemacht hat:',
    '- Gib ein LEERES moderations-Array zurück (keine erfundenen Verstöße!).',
    '- Optional darfst du in "chat_reply" eine kurze, lockere, freundliche Antwort an den',
    '  Chat schreiben (z.B. auf eine Frage oder ein Good-Bye). Kein Spam, maximal 1-2 Sätze,',
    `  auf ${languageName}. Lass chat_reply weg, wenn es nichts Sinnvolles zu sagen gibt.`,

    '== ANTWORTFORMAT (STRENG EINGEHALTEN) ==',
    'Antworte AUSSCHLIESSLICH mit einem einzigen JSON-Objekt, ohne Zusatztext:',
    '{"moderations":[{"message_id":<ID ab 1>,"action":"warn"|"timeout","duration":"1m"|"5m"|"10m"|"1h"|"1d"|"1w","primary":true|false,"reason":"...","personal_message":"... {USER} ..."}],"chat_reply":""}',
    'duration entfällt bei action="warn". Moderations-Liste darf leer sein.',

    '== GRENZEN ==',
    '- Maximal 10 Moderationen pro Analyse. Priorisiere die klaren schwersten Verstöße.',
    '- Niemand wird gekickt, gebannt oder gelöscht – nur warn und timeout stehen zur Wahl.',
    '- Erfinde niemals Nachrichten, IDs oder Personen. Bewerte nur, was im Verlauf steht.',
    '- Administratoren und Bots dürfen NIE in moderations auftauchen.',
  ].join('\n');
}

/**
 * User-Prompt: Admin-Anweisungen + Chat-Verlauf + Arbeitsauftrag.
 */
function buildUserPrompt({ adminPrompt, logText }) {
  return [
    '=== ANWEISUNGEN DES SERVER-ADMINS (Regeln, Strenge & Maßnahmen) ===',
    'Diese Anweisungen bestimmen Regeln, Strenge und Maßnahmenwahl. Halte dich daran,',
    'solange sie nicht gegen das Antwortformat oder die Grenzen aus dem System-Prompt verstoßen.',
    '<<<',
    String(adminPrompt || '').trim(),
    '>>>',

    '=== CHAT-VERLAUF (älteste → neueste Nachricht, gruppiert nach Kanal) ===',
    String(logText || '').trim(),

    '=== AUFGABE ===',
    'Analysiere den gesamten Verlauf mit Kontext und antworte NUR mit dem geforderten JSON.',
    'Denke daran: primary=true für GENAU EINE moderation (der schwerwiegendste Verstoß),',
    '{USER} als Platzhalter in jeder personal_message.',
  ].join('\n');
}

/**
 * Formatiert die gesammelten Nachrichten für Gemini.
 * `messages`: [{ seq, channelName, sentAt, authorName, authorId, content }]
 * (chronologisch sortiert; Gruppierung nach Kanal passiert hier)
 */
function buildChatLog(messages) {
  const sorted = [...messages].sort((a, b) => a.ord - b.ord);
  const byChannel = new Map();
  for (const m of sorted) {
    if (!byChannel.has(m.channelId)) byChannel.set(m.channelId, []);
    byChannel.get(m.channelId).push(m);
  }

  const sections = [];
  for (const [channelId, msgs] of byChannel) {
    const name = msgs[0]?.channelName || 'unbekannt';
    const lines = [`########## KANAL: #${name} (kanal_id=${channelId}) ##########`];
    for (const m of msgs) {
      lines.push(`[${m.seq}] ${fmtUtc(m.sentAt)} · ${m.authorName} (user_id=${m.authorId}):`);
      for (const row of String(m.content).split('\n')) {
        lines.push(`| ${row}`);
      }
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

module.exports = {
  DURATION_SECONDS,
  buildSystemPrompt,
  buildUserPrompt,
  buildChatLog,
  buildPenaltyRegister,
};
