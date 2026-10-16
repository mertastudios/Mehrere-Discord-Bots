/**
 * ============================================================================
 *  Sammler + lokaler Vor-Filter
 *
 *  Es werden nur Textnachrichten echter Nutzer gesammelt (keine Bots, keine
 *  Webhooks, keine Systemnachrichten). Team-Nachrichten (Owner/Admin/immune
 *  Rollen) kommen als Kontext mit, werden aber nie moderiert.
 *
 *  Der lokale Filter kostet KEINE Tokens und läuft bei jeder Nachricht:
 *  Er erkennt grobe Signale (Beleidigungen, Drohungen, Invite-Links, Spam,
 *  Mention-Druck). Schlägt er an, geht der Puffer sofort zur Prüfung –
 *  ansonsten wird gesammelt und in Ruhe gebündelt geprüft.
 * ============================================================================
 */

const SLUR_AND_INSULT = [
  // Beleidigungen (de/en) – bewusst grob, die KI urteilt danach genau
  /\b(hurensohn|hurensöhne|wichser|arschloch|fotze|missgeburt|spast|spasti|behinderter|idiot|vollidiot|depp|trottel)\b/i,
  /\b(fick|fickt|ficke|verpiss|halt die fresse|halt deine fresse|fresse halten)\b/i,
  /\b(idiot|moron|retard|bastard|asshole|bitch|whore|slut|cunt|faggot|nigg(er|a))\b/i,
  /\b(kys|kill yourself|you should die|drop dead|darfst dich umbringen)\b/i,
];
const THREATS = [
  /\b(ich bring dich um|ich ficke dich|ich mach dich fertig|ich finde dich|pass auf dich auf|du bist tot|bist du tot|hoffe du stirbst|verrecke|stirb)\b/i,
  /\b(i will kill you|i will find you|you are dead|i hope you die|watch your back)\b/i,
  /\b(nudes?|nacktbilder|schick nackt|sex(t)?ing)\b/i,
  /\b(adresse|handynummer|wohnort)\b.*\b(raus|sag|post)\b/i,
];
const SCAM = [
  /(discord(?:app)?\.(?:com|gg)\/gift|steamcommunity\.com\/gift|free-?nitro|nitro-?gift|csgo-?skins?\.)/i,
  /(bit\.ly|tinyurl|shorturl|linktr\.ee)\/[\w-]*(nitro|gift)/i,
  /\b(crypto|investment|verdopple|gewinnspiel)\b.*\b(link|klick|sende|dm)\b/i,
];
const SPAM = [
  /(?:discord\.gg|discord\.com\/invite)\/[\w-]+/i,
  /@everyone|@here/i,
];

/** Ist die Nachricht inhaltlich überhaupt prüfbar? */
function isCollectable(message, { botId } = {}) {
  if (!message?.author) return false;
  if (message.author.bot) return false;
  if (message.webhookId) return false;
  if (message.system) return false;
  if (botId && message.author.id === botId) return false;
  const content = String(message.content || '').trim();
  if (!content && !(message.attachments?.size > 0)) return false;
  if (content.length > 2000) return false;
  return true;
}

/** Soll dieser Kanal überwacht werden? Leere Liste = alle Kanäle. */
function isMonitored(channelId, cfg) {
  const list = cfg?.channels || [];
  if (!list.length) return true;
  return list.includes(String(channelId));
}

/** Kompakte Datensatz-Form (wird gepuffert und gespeichert). */
function toRecord(message, { immune = false, botId = null } = {}) {
  const member = message.member;
  const author = message.author;
  const guildId = message.guildId || message.guild?.id || '';
  const channelId = message.channelId || message.channel?.id || '';
  return {
    key: `${guildId}:${channelId}:${message.id}`,
    guildId: String(guildId),
    channelId: String(channelId),
    channelName: message.channel?.name || 'kanal',
    messageId: String(message.id),
    authorId: String(author?.id || message.authorId || ''),
    authorName: member?.displayName || author?.globalName || author?.username || message.authorName || 'Unbekannt',
    content: String(message.content || '').slice(0, 1500),
    createdAt: Number(message.createdTimestamp || message.createdAt) || Date.now(),
    immune: Boolean(immune),
    botId: botId || null,
    hasAttachment: Boolean(message.attachments?.size),
    mentions: [...(message.mentions?.users?.values?.() || [])].map((u) => ({
      id: String(u.id),
      name: message.guild?.members?.cache?.get(u.id)?.displayName || u.globalName || u.username || u.id,
    })),
    reply: message.reference?.messageId
      ? { messageId: String(message.reference.messageId), channelId: String(message.reference.channelId || message.channelId) }
      : null,
  };
}

/** Lokale Risikosignale einer Nachricht (0 Tokens, nur Kandidatenerkennung). */
function localSignals(record) {
  const text = String(record?.content || '');
  const signals = [];
  const push = (kind, weight) => signals.push({ kind, weight, messageId: record.messageId });

  if (SLUR_AND_INSULT.some((re) => re.test(text))) push('beleidigung', 45);
  if (THREATS.some((re) => re.test(text))) push('drohung', 60);
  if (SCAM.some((re) => re.test(text))) push('scam', 55);
  if (SPAM.some((re) => re.test(text))) push('spam', 25);

  // Schreien (viele Großbuchstaben)
  const letters = text.replace(/[^A-Za-zÄÖÜäöüß]/g, '');
  if (letters.length >= 12 && (text.match(/[A-ZÄÖÜ]/g)?.length || 0) / letters.length > 0.7) push('schreien', 12);
  // Wand aus Zeichen / Flood
  if (/(.)\1{9,}/.test(text)) push('flood', 15);

  return signals;
}

/**
 * Risiko des gesamten Puffers: lokale Signale + Wiederholungen + Mention-Druck
 * (mehrere Nachrichten gegen dieselbe Person).
 */
function bufferRisk(records, { windowMs = 10 * 60_000, mentionRepeatLimit = 3 } = {}) {
  const signals = [];
  for (const record of records) signals.push(...localSignals(record));

  // Doppelte Nachrichten (Spam)
  const seen = new Map();
  for (const r of records) {
    const key = `${r.authorId}:${String(r.content).toLowerCase().slice(0, 80)}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count >= 3) signals.push({ kind: 'wiederholung', weight: 20, key });
  }

  // Mention-Druck auf dieselbe Person
  const now = records.length ? records[records.length - 1].createdAt : Date.now();
  const pressure = new Map();
  for (const r of records) {
    if (now - r.createdAt > windowMs) continue;
    for (const m of r.mentions || []) {
      if (!pressure.has(m.id)) pressure.set(m.id, { count: 0, name: m.name });
      pressure.get(m.id).count += 1;
    }
  }
  for (const [id, info] of pressure) {
    if (info.count >= mentionRepeatLimit) signals.push({ kind: 'mention_druck', weight: 18, targetId: id, count: info.count });
  }

  const score = Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0));
  return { score, signals };
}

function recentCount(records, windowMs = 90_000, now = Date.now()) {
  return records.filter((r) => now - r.createdAt <= windowMs).length;
}

/**
 * Entscheidet, ob der Puffer jetzt geprüft werden soll.
 *  - Risikosignal → sofort
 *  - voller Puffer → sofort
 *  - sonst: kurze Ruhephase nach dem letzten Beitrag
 */
function shouldAnalyse(records, { score, now = Date.now(), limits = {} } = {}) {
  const maxBatch = limits.maxBatch ?? 40;
  const minBatch = limits.minBatch ?? 4;
  const quietMs = limits.quietMs ?? 30_000;
  const maxAgeMs = limits.maxAgeMs ?? 180_000;

  if (!records.length) return { run: false, reason: 'leer' };
  if (score >= 40) return { run: true, reason: 'risiko', priority: true };
  if (records.length >= maxBatch) return { run: true, reason: 'voll' };

  const last = records[records.length - 1].createdAt;
  const age = now - records[0].createdAt;
  if (records.length >= minBatch && now - last >= quietMs) return { run: true, reason: 'ruhe' };
  if (age >= maxAgeMs) return { run: true, reason: 'alter' };
  return { run: false, reason: 'sammeln' };
}

module.exports = {
  SLUR_AND_INSULT,
  THREATS,
  SCAM,
  SPAM,
  isCollectable,
  isMonitored,
  toRecord,
  localSignals,
  bufferRisk,
  recentCount,
  shouldAnalyse,
};
