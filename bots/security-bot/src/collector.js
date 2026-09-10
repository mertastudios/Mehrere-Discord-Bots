/**
 * Nachrichten-Sammler für den Sicherheitsbot.
 *
 * - Sammelt NUR Textnachrichten von echten Nutzern (keine Bots, keine
 *   Webhooks, keine Systemnachrichten).
 * - Mitglieder mit Administrator-Berechtigung sind IMMUN und werden nie
 *   gesammelt oder moderiert.
 * - Bilder/Anhänge werden bewusst NICHT analysiert – der Bot moderiert Text.
 *   Enthält eine Nachricht einen Anhang plus Text, wird nur der Text gesammelt
 *   und mit einem Hinweis markiert, damit die KI nicht blind urteilt.
 * - Discord-Formate (Mentions, Rollen, Kanäle, Emojis, Timestamps, Markdown)
 *   werden in lesbaren Klartext für Gemini umgewandelt.
 * - Sobald das Token-Budget für eine Gemini-Anfrage voll ist, wird der Buffer
 *   als Batch mit IDs ab 1 verpackt und die Analyse angestoßen.
 */

const { PermissionFlagsBits } = require('discord.js');
const { estimateTokens } = require('./gemini');
const { MAX_BUFFER_MESSAGES } = require('./store');

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
  if (!guild) return fallbackName || `Nutzer ${userId}`;
  try {
    let member = guild.members?.cache?.get?.(userId) || null;
    if (!member?.displayName && typeof guild.members?.fetch === 'function') {
      member = await guild.members.fetch(userId).catch(() => null);
    }
    return member?.displayName || member?.user?.username || fallbackName || `Nutzer ${userId}`;
  } catch {
    return fallbackName || `Nutzer ${userId}`;
  }
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

/** Soll die Nachricht gesammelt werden? (Echte User, mit Text, kein Admin) */
async function shouldCollect({ ctx, msg }) {
  if (!msg?.guild || msg.system) return false;
  if (msg.author?.bot || msg.webhookId) return false;
  if (ctx.client?.user && msg.author?.id === ctx.client.user.id) return false;
  if (!String(msg.content || '').trim()) return false; // Nur-Emoji/Sticker/Bilder -> kein Text

  let member = msg.member;
  if (!member && typeof msg.guild.members?.fetch === 'function') {
    member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
  }
  // Admin-Bypass: Administratoren sind komplett immun.
  if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return false;

  return true;
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

    if (!(await shouldCollect({ ctx, msg }))) return;

    const text = await humanizeContent(msg, msg.content);
    if (!text) return;

    const payload = {
      channelId: String(msg.channelId || msg.channel?.id || ''),
      channelName: msg.channel?.name || 'unbekannt',
      authorId: String(msg.author.id),
      authorName: msg.member?.displayName || msg.author.globalName || msg.author.username || 'Unbekannt',
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
    const bufferTokens = ctx.store.getBufferTokenEstimate(guildId, estimateTokens);
    const bufferCount = ctx.store.getBuffer(guildId).length;

    if (bufferTokens >= budget || bufferCount >= MAX_BUFFER_MESSAGES) {
      const batch = ctx.store.buildBatchFromBuffer(guildId);
      if (batch) void dispatchBatch(ctx, guildId);
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
  humanizeContent,
  displayNameOf,
  escapeDiscordMarkdown,
  maxInputTokens,
  ATTACHMENT_NOTE,
};
