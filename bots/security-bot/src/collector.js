/**
 * Nachrichten-Sammler für den Sicherheitsbot.
 *
 * - Sammelt NUR Textnachrichten von echten Nutzern (keine Bots, keine
 *   Webhooks, keine Systemnachrichten).
 * - Mitglieder mit Administrator-Berechtigung sind IMMUN: Sie werden als Kontext
 *   gesammelt, bekommen aber keine moderierbare ID und werden nie bestraft.
 * - Bilder/Anhänge werden bewusst NICHT analysiert – der Bot moderiert Text.
 *   Enthält eine Nachricht einen Anhang plus Text, wird nur der Text gesammelt
 *   und mit einem Hinweis markiert, damit die KI nicht blind urteilt.
 * - Discord-Formate (Mentions, Rollen, Kanäle, Emojis, Timestamps, Markdown)
 *   werden in lesbaren Klartext für Gemini umgewandelt.
 * - Sobald das harte Token-Budget oder die adaptive Batch-Policy anschlägt
 *   (Risikosignal, Mention-Druck/Dogpiling, kurze Ruhephase, max. Buffer-Alter),
 *   wird der Buffer als Batch mit IDs ab 1 verpackt und die Analyse angestoßen.
 *   Der Scheduler behält zusätzlich den 2-Stunden-Flush als Sicherheitsnetz.
 */

const { PermissionFlagsBits } = require('discord.js');
const { estimateTokens } = require('./gemini');
const { MAX_BUFFER_MESSAGES } = require('./store');
const { shouldFlushBuffer } = require('./batch-policy');

const ATTACHMENT_NOTE = ' [Anhang war beigelegt – wird nicht geprüft]';

/** Konfiguriertes Token-Budget pro Gemini-Anfrage (Default 15000). */
function maxInputTokens(env) {
  const raw = Number.parseInt(String(env?.('SECURITY_GEMINI_MAX_INPUT_TOKENS', '') || ''), 10);
  return Number.isFinite(raw) && raw >= 2000 ? raw : 15000;
}

/**
 * Entfernt Discord-Markdown-Steuerzeichen, damit Gemini den ROHtext sieht und
 * nichts als Formatierung fehlinterpretiert (auch nicht unser "| "-Logformat).
 * Ein führendes ">" oder "#" wird escaped, damit Nutzer nicht aussehen wie
 * Zitate/Überschriften.
 */
function escapeDiscordMarkdown(text) {
  return String(text)
    .replace(/[\\*_`~|]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([>#])/gm, (m, ws, ch) => `${ws}\\${ch}`);
}

/** Auflösbare Anzeigename eines Nutzers (Member-Cache, sonst Fetch, sonst Fallback). */
async function displayNameOf(guild, userId, fallbackName) {
  const identity = await identityOf(guild, userId, { fallbackName });
  return identity.displayName || identity.serverNickname || identity.globalName || identity.username || fallbackName || `Nutzer ${userId}`;
}

function cleanName(value, max = 100) {
  if (value == null) return null;
  const out = String(value).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return out ? out.slice(0, max) : null;
}

function identityFromMemberOrUser(member, user, fallbackId, fallbackName) {
  const u = user || member?.user || null;
  const id = cleanName(u?.id || member?.id || fallbackId, 40);
  const serverNickname = cleanName(member?.nickname || null);
  const displayName = cleanName(member?.displayName || serverNickname || u?.globalName || u?.username || fallbackName || (id ? `Nutzer ${id}` : null));
  return {
    id,
    displayName,
    serverNickname,
    globalName: cleanName(u?.globalName || u?.global_name || null),
    username: cleanName(u?.username || fallbackName || null),
  };
}

/** Vollständige öffentliche Discord-Identität: Server-Name/Nick + globaler Name + Username. */
async function identityOf(guild, userId, { user = null, member = null, fallbackName = null } = {}) {
  let resolvedMember = member || null;
  const id = String(userId || user?.id || member?.id || '').trim();
  try {
    if (!resolvedMember && guild && id) {
      resolvedMember = guild.members?.cache?.get?.(id) || null;
      if (!resolvedMember?.displayName && typeof guild.members?.fetch === 'function') {
        resolvedMember = await guild.members.fetch(id).catch(() => resolvedMember || null);
      }
    }
  } catch {}
  return identityFromMemberOrUser(resolvedMember, user, id, fallbackName);
}

function valuesOfCollection(collection) {
  if (!collection) return [];
  if (typeof collection.values === 'function') return [...collection.values()];
  if (Array.isArray(collection)) return collection;
  if (typeof collection === 'object') return Object.values(collection);
  return [];
}

async function mentionIdentitiesOf(msg) {
  const guild = msg.guild;
  const byId = new Map();

  const add = async (id, user = null, member = null, fallbackName = null) => {
    if (!id || byId.has(String(id))) return;
    const identity = await identityOf(guild, id, { user, member, fallbackName });
    if (identity?.id) byId.set(identity.id, identity);
  };

  for (const member of valuesOfCollection(msg.mentions?.members)) {
    await add(member?.id || member?.user?.id, member?.user, member, member?.displayName);
  }
  for (const user of valuesOfCollection(msg.mentions?.users)) {
    await add(user?.id, user, null, user?.globalName || user?.username);
  }
  for (const match of String(msg.content || '').matchAll(/<@!?(\d{15,21})>/g)) {
    await add(match[1]);
  }

  return [...byId.values()].slice(0, 20);
}

async function replyMetaOf(msg) {
  const ref = msg.reference || null;
  const messageId = ref?.messageId || ref?.message_id || null;
  if (!messageId) return null;

  const meta = {
    messageId: String(messageId),
    channelId: String(ref.channelId || ref.channel_id || msg.channelId || msg.channel?.id || ''),
    guildId: String(ref.guildId || ref.guild_id || msg.guildId || msg.guild?.id || ''),
    author: null,
    content: null,
    createdAt: null,
  };

  // Wenn Discord die Referenz schon mitsendet/gecached hat, nutzen wir sie;
  // sonst versuchen wir einen einzelnen Fetch. Scheitert er, bleiben zumindest
  // IDs erhalten, damit Gemini Reply-Ketten erkennt.
  let referenced = ref.cachedMessage || msg.reference?.cachedMessage || null;
  const sameChannel = !meta.channelId || meta.channelId === String(msg.channelId || msg.channel?.id || '');
  if (!referenced && sameChannel && typeof msg.channel?.messages?.fetch === 'function') {
    referenced = await msg.channel.messages.fetch(String(messageId)).catch(() => null);
  }

  if (referenced) {
    const author = referenced.author || null;
    meta.author = await identityOf(msg.guild, author?.id || referenced.member?.id, {
      user: author,
      member: referenced.member,
      fallbackName: referenced.member?.displayName || author?.globalName || author?.username,
    });
    const refText = referenced.content ? await humanizeContent(referenced, referenced.content) : '';
    meta.content = refText ? refText.slice(0, 500) : null;
    meta.createdAt = Number(referenced.createdTimestamp) || null;
  }

  return meta;
}

/**
 * Wandelt alle Discord-Sonderformate in lesbaren Klartext um:
 * <@id>/<@!id> → Anzeigename, <@&id> → @Rolle, <#id> → #kanal,
 * <:name:id> → :name:, <t:unix:F> → Datum, Anhänge → Hinweis.
 */
async function humanizeContent(msg, text) {
  const guild = msg.guild;
  let out = String(text || '');

  const replacements = [];
  for (const match of out.matchAll(/<@!?(\d{15,21})>/g)) {
    replacements.push([match[0], await displayNameOf(guild, match[1])]);
  }
  for (const match of out.matchAll(/<@&(\d{15,21})>/g)) {
    const role = guild?.roles?.cache?.get?.(match[1]);
    replacements.push([match[0], `@${role?.name || 'geloeschte-rolle'}`]);
  }
  for (const match of out.matchAll(/<#(\d{15,21})>/g)) {
    const channel = guild?.channels?.cache?.get?.(match[1]);
    replacements.push([match[0], `#${channel?.name || 'geloeschter-kanal'}`]);
  }
  for (const match of out.matchAll(/<a?:(\w{2,32}):\d{15,21}>/g)) {
    replacements.push([match[0], `:${match[1]}:`]);
  }
  for (const match of out.matchAll(/<t:(\d+)(?::[tTdDfFR])?>/g)) {
    const ts = Number(match[1]);
    replacements.push([
      match[0],
      Number.isFinite(ts)
        ? `${new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`
        : match[0],
    ]);
  }

  for (const [raw, human] of replacements) {
    out = out.split(raw).join(human);
  }

  const hasAttachments = Boolean(
    msg.attachments && typeof msg.attachments.size === 'number' && msg.attachments.size > 0
  );
  if (hasAttachments) out += ATTACHMENT_NOTE;

  return escapeDiscordMarkdown(out).trim();
}

/**
 * Klassifiziert eine Nachricht für das Sammeln.
 * Rückgabe: { collect: boolean, isAdmin: boolean }
 *
 * - Echte User mit Text werden gesammelt.
 * - Administratoren werden EBENFALLS gesammelt – aber nur als Kontext: Ihre
 *   Nachrichten bekommen im Batch keine ID, sind für Gemini als "ADMIN – immun"
 *   markiert und können deshalb nie moderiert werden.
 */
async function classifyMessage({ ctx, msg }) {
  const no = { collect: false, isAdmin: false };
  if (!msg?.guild || msg.system) return no;
  if (msg.author?.bot || msg.webhookId) return no;
  if (ctx.client?.user && msg.author?.id === ctx.client.user.id) return no;
  if (!String(msg.content || '').trim()) return no; // Nur-Emoji/Sticker/Bilder -> kein Text

  let member = msg.member;
  if (!member && typeof msg.guild.members?.fetch === 'function') {
    member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
  }
  const isAdmin = Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator));
  return { collect: true, isAdmin };
}

/** Soll die Nachricht gesammelt werden? (Echte User mit Text – inkl. Admins als Kontext) */
async function shouldCollect({ ctx, msg }) {
  return (await classifyMessage({ ctx, msg })).collect;
}

/**
 * Haupt-Einstieg für jedes messageCreate-Event.
 * Sammelt die Nachricht und stößt bei vollem Token-Budget eine Analyse an.
 */
async function handleIncoming({ ctx, msg }) {
  try {
    const guildId = String(msg?.guild?.id || '');
    if (!guildId) return;

    const cfg = ctx.store.getGuild(guildId);
    // Ohne Gemini-Key wird nichts gesammelt (keine sinnlosen Chatdaten speichern).
    if (!cfg?.geminiApiKey) return;

    const { collect, isAdmin } = await classifyMessage({ ctx, msg });
    if (!collect) return;

    const [text, authorMeta, mentionsMeta, replyMeta] = await Promise.all([
      humanizeContent(msg, msg.content),
      identityOf(msg.guild, msg.author.id, {
        user: msg.author,
        member: msg.member,
        fallbackName: msg.member?.displayName || msg.author.globalName || msg.author.username,
      }),
      mentionIdentitiesOf(msg),
      replyMetaOf(msg),
    ]);
    if (!text) return;

    const payload = {
      isAdmin,
      channelId: String(msg.channelId || msg.channel?.id || ''),
      channelName: msg.channel?.name || 'unbekannt',
      authorId: String(msg.author.id),
      authorName: authorMeta?.displayName || msg.member?.displayName || msg.author.globalName || msg.author.username || 'Unbekannt',
      authorMeta,
      mentionsMeta,
      replyMeta,
      content: text,
      discordMessageId: msg.id,
      sentAt: Number(msg.createdTimestamp) || Date.now(),
    };

    if (!ctx.store.addBufferMessage(guildId, payload)) {
      // Buffer am Limit -> sofort als Batch abschieben und erneut versuchen.
      const batch = ctx.store.buildBatchFromBuffer(guildId);
      if (batch) void dispatchBatch(ctx, guildId);
      ctx.store.addBufferMessage(guildId, payload);
      return;
    }

    const budget = maxInputTokens(ctx.env);
    const buffer = ctx.store.getBuffer(guildId);
    const bufferTokens = ctx.store.getBufferTokenEstimate(guildId, estimateTokens);
    const bufferCount = buffer.length;
    const policy = shouldFlushBuffer({
      buffer,
      env: ctx.env,
      estimateTokensFn: estimateTokens,
      newestMessage: payload,
    });

    if (bufferTokens >= budget || bufferCount >= MAX_BUFFER_MESSAGES || policy.flush) {
      const batch = ctx.store.buildBatchFromBuffer(guildId);
      if (batch) {
        ctx.logger?.info?.(
          `[security-bot] Schneller Analyse-Flush für Gilde ${guildId}: ` +
            `${bufferCount} Nachrichten, ~${bufferTokens} Tokens, Grund=${policy.reason || 'hard_limit'}`
        );
        void dispatchBatch(ctx, guildId);
      }
    }
  } catch (err) {
    ctx.logger?.warn?.('[security-bot] Fehler beim Sammeln einer Nachricht:', err?.message || err);
  }
}

/** Leichte Indirektion, damit Tests dispatchen patchen können. */
function dispatchBatch(ctx, guildId) {
  const { processGuild } = require('./moderator');
  return processGuild(ctx, guildId);
}

module.exports = {
  handleIncoming,
  shouldCollect,
  classifyMessage,
  humanizeContent,
  displayNameOf,
  identityOf,
  mentionIdentitiesOf,
  replyMetaOf,
  escapeDiscordMarkdown,
  maxInputTokens,
  ATTACHMENT_NOTE,
};
