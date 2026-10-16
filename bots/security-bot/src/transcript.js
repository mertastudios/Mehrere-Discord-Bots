/**
 * ============================================================================
 *  Verlauf-Formatierung für die KI
 *
 *  Aufgabe 1: Discord-Nachrichten in ein sauberes, kompaktes Klartext-Format
 *  bringen, das die KI gut lesen kann – Mentions, Kanäle, Emojis, Replies,
 *  Anhänge und Namen aufgelöst, chronologisch, nach Kanal gruppiert.
 *
 *  Aufgabe 2: Aus fremden Regel-Nachrichten (Embed, Components V2, normaler
 *  Text) den reinen Text herausziehen – für den Import in Schritt 4 des Setups.
 *
 *  Referenz auf die ID-Nummern: Der Verlauf hat IDs ab 1 (`[1]`), die KI
 *  antwortet mit genau diesen Nummern. Die Zuordnung zur echten Discord-ID
 *  macht der Bot (`idMap`).
 * ============================================================================
 */

const MAX_MSG_CHARS = 400; // pro Nachricht – Wände werden gekürzt

function clip(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Discord-Markup → lesbarer Text (die KI soll den Inhalt sehen, nicht Markdown). */
function humanizeContent(message, content) {
  let out = String(content ?? '');
  // Markdown-Steuerzeichen entschärfen, damit nichts als Formatierung durchgeht
  out = out.replace(/[\\*_`~|]/g, (c) => `\\${c}`).replace(/^(\s*)([>#])/gm, (m, ws, ch) => `${ws}\\${ch}`);

  const guild = message?.guild;
  if (guild && typeof out === 'string') {
    // Rollen
    out = out.replace(/<@&(\d+)>/g, (m, id) => `@[Rolle: ${guild.roles?.cache?.get(id)?.name || id}]`);
    // Nutzer (mit Nickname, damit die KI Personen wiedererkennt)
    out = out.replace(/<@!?(\d+)>/g, (m, id) => {
      const member = guild.members?.cache?.get(id);
      const user = message.mentions?.users?.get?.(id);
      const name = member?.displayName || user?.globalName || user?.username || `user_id=${id}`;
      return `@[${name}]`;
    });
    // Kanäle
    out = out.replace(/<#(\d+)>/g, (m, id) => `#[${guild.channels?.cache?.get(id)?.name || id}]`);
  }
  // Custom-Emojis + Timestamps + @everyone/@here
  out = out.replace(/<a?:(\w+):\d+>/g, ':$1:');
  out = out.replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (m, ts) => new Date(Number(ts) * 1000).toISOString().slice(0, 16).replace('T', ' '));
  out = out.replace(/@everyone/g, '@[everyone]').replace(/@here/g, '@[here]');
  return out;
}

function displayNameOf(message) {
  const member = message?.member;
  const author = message?.author;
  return (
    message?.displayName ||
    message?.authorName ||
    member?.displayName ||
    author?.globalName ||
    author?.username ||
    'Unbekannt'
  );
}

/** Ist der Autor geschützt (Owner/Admin/Rolle höher als der Bot)? */
function isImmune(message, { immuneRoleIds = [], botHighestPosition = null } = {}) {
  const guild = message?.guild;
  if (!guild) return false;
  const member = message.member;
  if (!member) return false;
  if (guild.ownerId && member.id === guild.ownerId) return true;
  if (typeof member.permissions?.has === 'function' && member.permissions.has('Administrator')) return true;
  const roles = member.roles?.cache;
  if (roles && immuneRoleIds.length) {
    for (const id of immuneRoleIds) if (roles.has(id)) return true;
  }
  if (botHighestPosition != null && typeof member.roles?.highest?.position === 'number') {
    if (member.roles.highest.position >= botHighestPosition) return true;
  }
  return false;
}

function attachmentNote(message) {
  const count = message?.attachments?.size || 0;
  if (!count) return '';
  const kinds = [...(message.attachments?.values?.() || [])].map((a) =>
    a.contentType?.startsWith('image/') ? 'Bild' : a.contentType?.startsWith('video/') ? 'Video' : 'Datei'
  );
  return ` [Anhang: ${[...new Set(kinds)].join('/')}]`;
}

/** Reply-Kontext – funktioniert für rohe Nachrichten UND gepufferte Datensätze. */
function replyMetaOf(message) {
  const ref = message?.reference || message?.reply;
  if (!ref?.messageId) return null;
  return {
    messageId: ref.messageId,
    channelId: ref.channelId || message.channelId,
    content: clip(message._replyContent ?? '', 160),
    author: message._replyAuthor ? clip(message._replyAuthor, 60) : null,
  };
}

/** Mentions – rohe Nachrichten (Collection) oder Datensätze (Array). */
function mentionedList(message) {
  const raw = message?.mentions;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const users = raw.users?.values ? [...raw.users.values()] : [];
  return users.map((u) => ({ id: u.id, name: u.globalName || u.username || u.id }));
}

/**
 * Baut den Verlauf. `messages` sind rohe discord.js-Nachrichten (oder
 * gespeicherte Datensätze mit `content`/`authorName`).
 *
 * @returns {{ text: string, idMap: Map<number, object>, tokens: number }}
 */
function buildTranscript(messages, { now = Date.now(), header = null } = {}) {
  const idMap = new Map();
  const lines = [];
  let counter = 0;
  let lastChannel = null;

  if (header) lines.push(header, '');

  for (const msg of messages) {
    const channelName = msg.channelName || msg.channel?.name || 'kanal';
    if (channelName !== lastChannel) {
      if (lastChannel !== null) lines.push('');
      lines.push(`── #${channelName} ──`);
      lastChannel = channelName;
    }

    const time = new Date(msg.createdTimestamp || msg.sentAt || msg.createdAt || now).toISOString().slice(11, 16);
    const name = displayNameOf(msg) || 'Unbekannt';
    const userId = msg.author?.id || msg.authorId || '?';

    if (msg.immune) {
      lines.push(`[KONTEXT · Team] ${time} ${name}: ${clip(humanizeContent(msg, msg.content), MAX_MSG_CHARS)}`);
      continue;
    }

    counter += 1;
    const id = counter;
    idMap.set(id, msg);

    const head = `[${id}] ${time} ${name} (user_id=${userId})`;
    const parts = [head];

    const reply = replyMetaOf(msg);
    if (reply) {
      parts.push(`  ↳ Antwort auf ${reply.author ? `${reply.author}: ` : ''}${reply.content ? `"${clip(reply.content, 120)}"` : `(ID ${reply.messageId})`}`);
    }
    const targets = mentionedList(msg).map((u) =>
      u.name ? `${u.name} (user_id=${u.id})` : `user_id=${u.id}`
    );
    if (targets.length) parts.push(`  ↳ erwähnt: ${targets.join(', ')}`);

    const body = clip(humanizeContent(msg, msg.content), MAX_MSG_CHARS) || '(leer)';
    parts.push(`  "${body}"${attachmentNote(msg)}`);
    lines.push(parts.join('\n'));
  }

  const text = lines.join('\n');
  return { text, idMap, tokens: estimateTokens(text) };
}

/** Sehr einfache, ausreichende Token-Schätzung (Deutsch ≈ 3,5 Zeichen/Token). */
function estimateTokens(value) {
  return Math.ceil(String(value ?? '').length / 3.5);
}

/**
 * Text aus einer beliebigen Nachricht holen – für den Regel-Import.
 * Unterstützt: normalen Inhalt, Embeds (Titel/Beschreibung/Felder/Footer) und
 * Components V2 (TextDisplay, Section-Text, Container, verschachtelt).
 */
function extractTextFromMessage(message) {
  const chunks = [];

  if (typeof message?.content === 'string' && message.content.trim()) {
    chunks.push(message.content.trim());
  }

  for (const embed of message?.embeds || []) {
    const e = typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
    if (e.author?.name) chunks.push(`**${e.author.name}**`);
    if (e.title) chunks.push(`## ${e.title}`);
    if (e.description) chunks.push(e.description);
    for (const field of e.fields || []) {
      if (field?.name) chunks.push(`**${field.name}**`);
      if (field?.value) chunks.push(field.value);
    }
    if (e.footer?.text) chunks.push(`— ${e.footer.text}`);
  }

  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (!node || typeof node !== 'object') continue;
      if (typeof node.toJSON === 'function') {
        walk([node.toJSON()]);
        continue;
      }
      if (node.type === 10 && node.content) chunks.push(node.content);
      if (node.type === 17 || node.type === 1 || node.type === 18 || node.type === 9) {
        if (node.type === 9 && node.content) chunks.push(node.content);
        walk(node.components || node.accessory ? [...(node.components || []), node.accessory].filter(Boolean) : node.components);
      }
      if (node.type === 11 && node.description) chunks.push(node.description);
    }
  };
  walk(message?.components);

  // Doppelte Zeilen entfernen, Reihenfolge erhalten
  const seen = new Set();
  const out = [];
  for (const chunk of chunks) {
    const clean = String(chunk).replace(/\r/g, '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out.join('\n\n').trim();
}

module.exports = {
  MAX_MSG_CHARS,
  clip,
  humanizeContent,
  displayNameOf,
  isImmune,
  attachmentNote,
  replyMetaOf,
  mentionedList,
  buildTranscript,
  estimateTokens,
  extractTextFromMessage,
};
