/**
 * Hinweis-Versand für den Sicherheitsbot:
 *  - Log-Kanal-Nachrichten (Moderationen, API-Fehler, Sonstiges)
 *  - Join-Notice an den Bot-Owner
 */

const { ChannelType } = require('discord.js');
const { componentsV2Payload } = require('./message-payload');
const { smallContainer } = require('./embed-builder');
const { t } = require('./languages');

/** Löst die konfigurierte Log-Kanal-ID in ein sendbares Channel-Objekt auf. */
async function resolveLogChannel(ctx, guildId) {
  const channelId = ctx.store?.getLogChannelId?.(guildId);
  if (!channelId) return null;
  const guild = ctx.client?.guilds?.cache?.get?.(String(guildId));
  if (!guild) return null;
  let channel = guild.channels?.cache?.get?.(channelId) || null;
  if (!channel && typeof guild.channels?.fetch === 'function') {
    channel = await guild.channels.fetch(channelId).catch(() => null);
  }
  if (!channel || typeof channel.send !== 'function') return null;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return null;
  return channel;
}

/** Sendet einen Components-V2-Container in den Log-Kanal (schlägt still fehl). */
async function sendLogNotice(ctx, guildId, container) {
  try {
    const channel = await resolveLogChannel(ctx, guildId);
    if (!channel) return false;
    // Discord kann bei einem kurzen Netzwerk-/Rate-Limit-Fehler ablehnen.
    // Fehler beim Loggen dürfen nicht still verschwinden: drei kurze Retries.
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await channel.send(componentsV2Payload([container]));
        return true;
      } catch (err) {
        lastError = err;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
      }
    }
    throw lastError;
  } catch (err) {
    ctx.logger?.warn?.('[security-bot] Log-Kanal-Nachricht fehlgeschlagen:', err?.message || err);
    return false;
  }
}

/** Kurze DM an den Bot-Owner, wenn der Bot einem neuen Server beitritt. */
async function sendJoinNotice(ctx, guild) {
  if (!ctx.ownerId) return;
  try {
    const ownerUser =
      ctx.client.users.cache.get(ctx.ownerId) || (await ctx.client.users.fetch(ctx.ownerId));
    const dm = await ownerUser.createDM();
    const text = t('joinDesc', 'de', {});
    try {
      await dm.send(componentsV2Payload([smallContainer(t('joinTitle', 'de'), text)]));
    } catch {
      await dm.send({ content: `${t('joinTitle', 'de')}\n\n${text.replace(/[*_`>|]/g, '')}` });
    }
    ctx.logger?.info?.(`[security-bot] Join-Notice an Owner für ${guild.name} gesendet.`);
  } catch (err) {
    ctx.logger?.warn?.('[security-bot] Join-Notice fehlgeschlagen:', err?.message || err);
  }
}

module.exports = { resolveLogChannel, sendLogNotice, sendJoinNotice };
