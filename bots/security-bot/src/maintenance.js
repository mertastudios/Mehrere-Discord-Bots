/**
 * ============================================================================
 *  Wartung – Aufräumen und Selbstheilung
 *
 *   1. Log-Kanal gelöscht?  → sofort neu anlegen und ankündigen.
 *   2. Überwachter Kanal gelöscht? → aus der Liste entfernen.
 *   3. Immune Rolle gelöscht? → aus dem Speicher entfernen (kein Müll).
 *   4. Server verlassen/gekickt? → alle Daten des Servers löschen.
 * ============================================================================
 */

const { ensureLogChannel } = require('./logging');

async function handleChannelDelete(ctx, channel) {
  const guild = channel?.guild;
  if (!guild) return { ok: false, reason: 'no_guild' };
  const cfg = ctx.store.getGuild(guild.id);
  let recreated = false;

  if (cfg.logChannelId && String(cfg.logChannelId) === String(channel.id)) {
    const result = await ensureLogChannel(ctx, guild).catch(() => ({ ok: false }));
    recreated = Boolean(result?.ok);
  }

  if ((cfg.channels || []).includes(String(channel.id))) {
    ctx.store.updateGuild(guild.id, { channels: cfg.channels.filter((id) => String(id) !== String(channel.id)) });
    await ctx.store.commit();
  }

  return { ok: true, recreated };
}

async function handleRoleDelete(ctx, role) {
  const guild = role?.guild;
  if (!guild) return { ok: false, reason: 'no_guild' };
  const cfg = ctx.store.getGuild(guild.id);
  if (!(cfg.immuneRoles || []).includes(String(role.id))) return { ok: true, removed: false };

  ctx.store.updateGuild(guild.id, { immuneRoles: cfg.immuneRoles.filter((id) => String(id) !== String(role.id)) });
  await ctx.store.commit();
  ctx.logger?.info?.(`[security-bot] Rolle ${role.name || role.id} gelöscht – aus dem Speicher entfernt.`);
  return { ok: true, removed: true };
}

async function handleGuildDelete(ctx, guild) {
  if (!guild) return { ok: false };
  ctx.store.deleteGuild(guild.id);
  ctx.pipeline?.delete?.(guild.id);
  ctx.setupDraft?.delete?.(guild.id);
  ctx.adminWarnAt?.delete?.(guild.id);
  await ctx.store.flush({ force: true });
  ctx.logger?.info?.(`[security-bot] Server ${guild.name || guild.id} verlassen – alle Daten gelöscht.`);
  return { ok: true };
}

module.exports = { handleChannelDelete, handleRoleDelete, handleGuildDelete };
