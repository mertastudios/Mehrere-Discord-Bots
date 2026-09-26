/**
 * Live-Scan der Discord-Nachrichtenhistorie.
 *
 * Der normale Sammler (collector.js) sieht nur Nachrichten, die seit dem
 * letzten Start eingegangen sind. Für die gezielte KI-Moderation
 * (/security_action) und für freie KI-Aufträge (/security_ai_order) brauchen
 * wir aber den ECHTEN Verlauf – auch ältere Nachrichten, die nie im Buffer
 * gelandet sind.
 *
 * Dieses Modul liest die Kanalhistorie über die Discord-API nach und liefert
 * Datensätze in exakt derselben Form, die prompts.buildChatLog erwartet:
 *   { ord, seq, channelId, channelName, authorId, authorName, content,
 *     discordMessageId, sentAt, isAdmin, authorMeta, replyMeta, mentionsMeta }
 */

const { PermissionFlagsBits, ChannelType } = require('discord.js');
const {
  humanizeContent,
  identityOf,
  mentionIdentitiesOf,
} = require('./collector');

// Harte Obergrenzen, damit ein Scan niemals in ein Rate-Limit-Desaster läuft.
const DEFAULT_USER_MESSAGE_LIMIT = 200; // gesuchte Nachrichten EINES Nutzers
const DEFAULT_FETCH_BUDGET = 2400;      // maximal gelesene Nachrichten insgesamt
const PER_CHANNEL_FETCH = 600;          // maximal gelesene Nachrichten pro Kanal
const PAGE_SIZE = 100;                  // Discord-Maximum pro Abruf
const MAX_CHANNELS = 30;

const TEXTY_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
]);

function lastActivityOf(channel) {
  const id = channel?.lastMessageId;
  if (id && /^\d{15,21}$/.test(String(id))) return Number(BigInt(String(id)) >> 22n);
  return 0;
}

/** Alle Kanäle, in denen der Bot die Historie tatsächlich lesen darf. */
function readableChannels(guild, me) {
  const out = [];
  const cache = guild?.channels?.cache;
  const list = cache?.values ? [...cache.values()] : Array.isArray(cache) ? cache : [];
  for (const channel of list) {
    if (!channel || !TEXTY_TYPES.has(channel.type)) continue;
    if (typeof channel.messages?.fetch !== 'function') continue;
    if (channel.archived) continue;
    const perms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    if (perms && !(perms.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.ReadMessageHistory))) {
      continue;
    }
    out.push(channel);
  }
  // Zuletzt aktive Kanäle zuerst – dort stehen die relevanten Nachrichten.
  out.sort((a, b) => lastActivityOf(b) - lastActivityOf(a));
  return out.slice(0, MAX_CHANNELS);
}

function collectionToArray(collection) {
  if (!collection) return [];
  if (typeof collection.values === 'function') return [...collection.values()];
  if (Array.isArray(collection)) return collection;
  return [];
}

/** Leichtgewichtige Reply-Info (ohne teuren Extra-Fetch pro Nachricht). */
function lightReplyMeta(msg) {
  const ref = msg?.reference || null;
  const messageId = ref?.messageId || ref?.message_id || null;
  if (!messageId) return null;
  const cached = ref.cachedMessage || null;
  return {
    messageId: String(messageId),
    channelId: String(ref.channelId || ref.channel_id || msg.channelId || ''),
    author: cached?.author
      ? {
          id: String(cached.author.id),
          displayName: cached.member?.displayName || cached.author.globalName || cached.author.username || null,
          username: cached.author.username || null,
        }
      : null,
    content: cached?.content ? String(cached.content).slice(0, 300) : null,
    createdAt: Number(cached?.createdTimestamp) || null,
  };
}

async function isAdminMember(guild, userId, member) {
  let resolved = member || guild?.members?.cache?.get?.(String(userId)) || null;
  if (!resolved && typeof guild?.members?.fetch === 'function') {
    resolved = await guild.members.fetch(String(userId)).catch(() => null);
  }
  return Boolean(resolved?.permissions?.has?.(PermissionFlagsBits.Administrator));
}

/** Wandelt eine Discord-Nachricht in einen Analyse-Datensatz um. */
async function toRecord({ ctx, guild, msg, isAdmin = false }) {
  const [content, authorMeta, mentionsMeta] = await Promise.all([
    humanizeContent(msg, msg.content),
    identityOf(guild, msg.author.id, {
      user: msg.author,
      member: msg.member,
      fallbackName: msg.member?.displayName || msg.author.globalName || msg.author.username,
    }),
    mentionIdentitiesOf(msg).catch(() => []),
  ]);
  if (!content) return null;
  return {
    seq: null,
    ord: Number(msg.createdTimestamp) || Date.now(),
    channelId: String(msg.channelId || msg.channel?.id || ''),
    channelName: msg.channel?.name || 'unbekannt',
    authorId: String(msg.author.id),
    authorName:
      authorMeta?.displayName ||
      msg.member?.displayName ||
      msg.author.globalName ||
      msg.author.username ||
      'Unbekannt',
    authorMeta,
    mentionsMeta,
    replyMeta: lightReplyMeta(msg),
    content,
    discordMessageId: String(msg.id),
    sentAt: Number(msg.createdTimestamp) || Date.now(),
    isAdmin,
  };
}

function usableMessage(ctx, msg) {
  if (!msg || msg.system) return false;
  if (msg.author?.bot || msg.webhookId) return false;
  if (ctx?.client?.user && msg.author?.id === ctx.client.user.id) return false;
  return Boolean(String(msg.content || '').trim());
}

/**
 * Liest die letzten Nachrichten EINES Nutzers serverweit ein.
 *
 * Es werden so lange Kanalhistorien durchsucht, bis entweder `limit`
 * Nachrichten des Nutzers gefunden wurden oder das Lesebudget erschöpft ist.
 * Rückgabe: { messages (chronologisch), scanned, channelsScanned, truncated }
 */
async function collectUserMessages({
  ctx,
  guild,
  userId,
  limit = DEFAULT_USER_MESSAGE_LIMIT,
  fetchBudget = DEFAULT_FETCH_BUDGET,
} = {}) {
  const uid = String(userId);
  const me = guild?.members?.me || null;
  const channels = readableChannels(guild, me);
  const found = [];
  let scanned = 0;
  let channelsScanned = 0;

  for (const channel of channels) {
    if (found.length >= limit || scanned >= fetchBudget) break;
    channelsScanned += 1;
    let before;
    let readInChannel = 0;

    while (found.length < limit && scanned < fetchBudget && readInChannel < PER_CHANNEL_FETCH) {
      const batch = await channel.messages
        .fetch({ limit: PAGE_SIZE, ...(before ? { before } : {}) })
        .catch(() => null);
      const list = collectionToArray(batch);
      if (!list.length) break;

      scanned += list.length;
      readInChannel += list.length;
      before = list[list.length - 1]?.id;

      for (const msg of list) {
        if (String(msg.author?.id) !== uid) continue;
        if (!usableMessage(ctx, msg)) continue;
        found.push(msg);
        if (found.length >= limit) break;
      }

      if (list.length < PAGE_SIZE) break; // Kanalanfang erreicht
    }
  }

  const isAdmin = await isAdminMember(guild, uid);
  const records = [];
  for (const msg of found) {
    const rec = await toRecord({ ctx, guild, msg, isAdmin });
    if (rec) records.push(rec);
  }
  records.sort((a, b) => a.ord - b.ord);

  return {
    messages: records,
    scanned,
    channelsScanned,
    truncated: found.length >= limit,
    isAdmin,
  };
}

/**
 * Liest den letzten allgemeinen Chatverlauf des Servers ein (alle Nutzer).
 * Für /security_ai_order, damit der Auftrag auch dann Material hat, wenn der
 * Buffer gerade leer ist.
 */
async function collectRecentMessages({
  ctx,
  guild,
  limit = 250,
  perChannel = 120,
  maxChannels = 8,
} = {}) {
  const me = guild?.members?.me || null;
  const channels = readableChannels(guild, me).slice(0, maxChannels);
  const picked = [];
  let scanned = 0;

  for (const channel of channels) {
    let before;
    let readInChannel = 0;
    while (readInChannel < perChannel && picked.length < limit * 2) {
      const batch = await channel.messages
        .fetch({ limit: Math.min(PAGE_SIZE, perChannel - readInChannel), ...(before ? { before } : {}) })
        .catch(() => null);
      const list = collectionToArray(batch);
      if (!list.length) break;
      scanned += list.length;
      readInChannel += list.length;
      before = list[list.length - 1]?.id;
      for (const msg of list) {
        if (usableMessage(ctx, msg)) picked.push(msg);
      }
      if (list.length < PAGE_SIZE) break;
    }
  }

  // Serverweit die neuesten `limit` Nachrichten behalten.
  picked.sort((a, b) => Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0));
  const newest = picked.slice(0, limit);

  const adminCache = new Map();
  const records = [];
  for (const msg of newest) {
    const authorId = String(msg.author.id);
    if (!adminCache.has(authorId)) {
      adminCache.set(authorId, await isAdminMember(guild, authorId, msg.member));
    }
    const rec = await toRecord({ ctx, guild, msg, isAdmin: adminCache.get(authorId) });
    if (rec) records.push(rec);
  }
  records.sort((a, b) => a.ord - b.ord);
  return { messages: records, scanned };
}

/** Vergibt fortlaufende IDs ab 1 für alle moderierbaren (nicht-Admin) Nachrichten. */
function numberMessages(records) {
  let seq = 0;
  const out = [];
  for (const rec of [...records].sort((a, b) => a.ord - b.ord)) {
    const copy = { ...rec };
    copy.seq = copy.isAdmin ? null : ++seq;
    out.push(copy);
  }
  return out;
}

module.exports = {
  collectUserMessages,
  collectRecentMessages,
  numberMessages,
  readableChannels,
  toRecord,
  DEFAULT_USER_MESSAGE_LIMIT,
  DEFAULT_FETCH_BUDGET,
  PAGE_SIZE,
};
