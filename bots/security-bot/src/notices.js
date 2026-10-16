/**
 * ============================================================================
 *  Hinweise (kein Command)
 *
 *  - Beim Beitritt schreibt der Bot den Server-Owner direkt an: er braucht
 *    Administrator-Rechte und danach einfach /setup.
 *  - Ist die DM zu, versucht er den System-Kanal, sonst bleibt nur das Log
 *    auf der Konsole.
 *  - Nach dem ersten Setup meldet er sich menschlich im Log-Kanal (siehe
 *    logging.js → logSetupDone).
 *  - Fehlen die Administrator-Rechte, sagt er das klar (höchstens alle 12 h).
 * ============================================================================
 */

const ui = require('./ui');
const { t } = require('./languages');
const { logNotice, ACCENT, withOrderButton } = require('./logging');

async function dmGuildOwner(ctx, guild) {
  const lang = ctx.store.getGuild(guild.id).lang || 'de';
  const owner = await guild.fetchOwner?.().catch(() => null);
  const botName = ctx.client.user?.username || 'Sentinel';
  const text = t(lang, 'joinDm', { bot: botName, guild: guild.name });

  if (owner?.send) {
    try {
      await owner.send(ui.payload([ui.container([ui.text(text)], { accentColor: 0x5865f2 })]));
      ctx.logger?.info?.(`[security-bot] Owner von ${guild.name} angeschrieben.`);
      return { ok: true, via: 'dm' };
    } catch {
      /* DMs zu → System-Kanal versuchen */
    }
  }

  const channel =
    guild.systemChannel ||
    guild.channels?.cache?.find?.((c) => c.isTextBased?.() && c.permissionsFor?.(guild.members.me)?.has?.('SendMessages'));

  if (channel?.send) {
    try {
      let body = ui.payload([ui.container([ui.text(t(lang, 'joinDmNoDm'))], { accentColor: 0x5865f2 })]);
      if (String(channel.id) === String(ctx.store.getGuild(guild.id).logChannelId)) body = withOrderButton(body, lang);
      await channel.send(body);
      return { ok: true, via: 'channel' };
    } catch {
      /* ignorieren */
    }
  }

  ctx.logger?.warn?.(`[security-bot] Konnte den Owner von ${guild.name} nicht anschreiben.`);
  return { ok: false };
}

/**
 * Meldet, dass dem Bot die Administrator-Rechte fehlen (höchstens alle 12 h).
 * Ohne diese Rechte macht der Bot bewusst gar nichts.
 */
async function notifyMissingAdmin(ctx, guild, { force = false } = {}) {
  const last = ctx.adminWarnAt?.get(guild.id) || 0;
  if (!force && Date.now() - last < 12 * 60 * 60 * 1000) return { ok: false, reason: 'throttled' };
  ctx.adminWarnAt?.set(guild.id, Date.now());

  const lang = ctx.store.getGuild(guild.id).lang || 'de';
  const lines = [t(lang, 'needBotAdmin'), t(lang, 'needBotAdminWhy'), '', t(lang, 'needBotAdminFix')];

  let delivered = false;
  const cfg = ctx.store.getGuild(guild.id);
  if (cfg.logChannelId) {
    const sent = await logNotice(ctx, guild, { lang, lines, accentColor: ACCENT.error }).catch(() => null);
    delivered = Boolean(sent);
  }
  if (!delivered) {
    const owner = await guild.fetchOwner?.().catch(() => null);
    if (owner?.send) {
      try {
        await owner.send(ui.payload([ui.container([ui.text(lines.join('\n'))], { accentColor: 0xed4245 })]));
        delivered = true;
      } catch {
        /* DMs zu */
      }
    }
  }
  ctx.logger?.warn?.(`[security-bot] Keine Administrator-Rechte auf ${guild.name} – Bot ist inaktiv.`);
  return { ok: true, delivered };
}

module.exports = { dmGuildOwner, notifyMissingAdmin };
