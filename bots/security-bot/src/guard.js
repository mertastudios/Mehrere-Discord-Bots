/**
 * ============================================================================
 *  Rechte-Prüfungen
 *
 *  Zwei harte Regeln:
 *   1. Ohne **Administrator** tut der Bot GAR NICHTS – kein Setup, keine
 *      Moderation, kein Log. Er erklärt freundlich, warum.
 *   2. `/setup` dürfen nur der Server-Owner oder Mitglieder mit
 *      Administrator-Berechtigung benutzen.
 * ============================================================================
 */

const { PermissionFlagsBits } = require('discord.js');
const ui = require('./ui');
const { t } = require('./languages');

const DEFAULT_ACCENT = 0xed4245;

function isGuildAdmin(member, guild) {
  if (!member || !guild) return false;
  if (String(member.id) === String(guild.ownerId)) return true;
  return Boolean(member.permissions?.has?.(PermissionFlagsBits.Administrator));
}

function botHasAdmin(guild) {
  const me = guild?.members?.me;
  if (!me) return false;
  return Boolean(me.permissions?.has?.(PermissionFlagsBits.Administrator));
}

/** Nachricht: „Ich brauche Administrator.“ */
function adminRequiredPayload(lang = 'de') {
  return ui.payload(
    [
      ui.container(
        [
          ui.text(t(lang, 'needBotAdmin')),
          ui.separator(),
          ui.text(`${t(lang, 'needBotAdminWhy')}\n\n${t(lang, 'needBotAdminFix')}`),
        ],
        { accentColor: DEFAULT_ACCENT }
      ),
    ],
    { ephemeral: true }
  );
}

function teamOnlyPayload(lang = 'de') {
  return ui.payload([ui.container([ui.text(t(lang, 'onlyTeam'))], { accentColor: DEFAULT_ACCENT })], { ephemeral: true });
}

/**
 * Prüft beide Regeln für eine Interaction.
 * @returns {boolean} true = darf weiterlaufen
 */
async function guard(ctx, interaction) {
  const guild = interaction.guild;
  if (!guild) return false;
  const lang = ctx.store.getGuild(guild.id).lang || 'de';

  if (!botHasAdmin(guild)) {
    const payload = adminRequiredPayload(lang);
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
    return false;
  }

  if (!isGuildAdmin(interaction.member, guild)) {
    const payload = teamOnlyPayload(lang);
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
    return false;
  }

  return true;
}

/** Team-Check ohne Antwort (z. B. für Feedback-Buttons). */
function isTeamMember(member, guild) {
  return isGuildAdmin(member, guild);
}

module.exports = {
  guard,
  isGuildAdmin,
  botHasAdmin,
  isTeamMember,
  adminRequiredPayload,
  teamOnlyPayload,
};
