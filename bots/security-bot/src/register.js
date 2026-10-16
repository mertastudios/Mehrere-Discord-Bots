/**
 * ============================================================================
 *  Command-Registrierung
 *
 *  Es gibt genau EINEN Befehl: /setup.
 *  Registriert wird er
 *    - global (damit ihn auch künftige Server sofort haben) und
 *    - zusätzlich auf JEDEM Server, auf dem der Bot bereits ist
 *      (Guild-Commands sind sofort verfügbar, globale brauchen bis zu 1 h).
 *  Alte Befehle verschwinden automatisch, weil Discord den kompletten Satz
 *  ersetzt (PUT).
 * ============================================================================
 */

const { Routes } = require('discord.js');

const SETUP_COMMAND = {
  name: 'setup',
  description: 'Sicherheits-Bot einrichten – nur Server-Owner/Admins',
  description_localizations: {
    'en-US': 'Set up the security bot – owner/admins only',
    'en-GB': 'Set up the security bot – owner/admins only',
  },
  options: [],
  default_member_permissions: null,
  dm_permission: false,
};

async function putGlobal(ctx) {
  const body = await ctx.rest.put(Routes.applicationCommands(ctx.client.user.id), { body: [SETUP_COMMAND] });
  return Array.isArray(body) ? body : [];
}

async function putGuild(ctx, guildId) {
  const body = await ctx.rest.put(Routes.applicationGuildCommands(ctx.client.user.id, String(guildId)), {
    body: [SETUP_COMMAND],
  });
  return Array.isArray(body) ? body : [];
}

/** Registriert /setup global und auf allen Servern. */
async function registerCommands(ctx, { onlyGuild = null } = {}) {
  const guildIds = onlyGuild ? [String(onlyGuild)] : [...ctx.client.guilds.cache.keys()];
  const result = { global: false, guilds: 0, failed: [] };

  if (!onlyGuild) {
    try {
      await putGlobal(ctx);
      result.global = true;
    } catch (err) {
      result.failed.push({ scope: 'global', error: err.message });
      ctx.logger?.error?.('[security-bot] Globale Command-Registrierung fehlgeschlagen:', err.message);
    }
  }

  for (const guildId of guildIds) {
    try {
      await putGuild(ctx, guildId);
      result.guilds += 1;
    } catch (err) {
      result.failed.push({ scope: guildId, error: err.message });
    }
  }

  if (result.guilds) {
    ctx.logger?.info?.(`[security-bot] /setup registriert: global=${result.global ? 'ja' : 'nein'}, Server=${result.guilds}`);
  }
  return result;
}

module.exports = { SETUP_COMMAND, registerCommands, putGlobal, putGuild };
