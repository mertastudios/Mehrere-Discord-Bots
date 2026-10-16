/**
 * ============================================================================
 *  Interaction-Router
 *
 *  Es gibt genau einen Befehl (/setup) und drei Button-Familien:
 *    setup:  der Assistent (nur Owner/Admins, nur mit Administrator-Rechten)
 *    fb:     👍/👎-Feedback an Log-Meldungen (Team)
 *    ord:    „Neuer Auftrag“ (Team)
 *
 *  Jeder Pfad wird einzeln abgesichert: Ein Fehler darf nie den Bot zerlegen.
 * ============================================================================
 */

const ui = require('./ui');
const { t } = require('./languages');
const setup = require('./setup');
const feedback = require('./feedback');
const orders = require('./orders');
const { guard } = require('./guard');

function errorPayload(lang, detail) {
  return ui.payload([ui.container([ui.text(`⚠️ **Fehler**\n${ui.clip(detail, 300)}`)], { accentColor: 0xed4245 })], {
    ephemeral: true,
  });
}

async function safeReply(ctx, interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    /* z. B. „Unknown interaction“ – dann ist nichts zu retten */
  }
}

async function handleInteraction(ctx, interaction) {
  if (!interaction?.guildId) {
    // Nur Server-basiert (Command ist ohnehin auf Gilden beschränkt)
    if (interaction.isRepliable?.()) {
      await interaction.reply({ content: 'Bitte benutze mich auf einem Server.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  const lang = ctx.store.getGuild(interaction.guildId).lang || 'de';

  try {
    // ---------- Slash-Command ----------
    if (interaction.isChatInputCommand?.()) {
      if (interaction.commandName !== 'setup') return;
      return await setup.handleCommand(ctx, interaction);
    }

    // ---------- Buttons / Selects ----------
    if (interaction.isButton?.() || interaction.isAnySelectMenu?.()) {
      const id = String(interaction.customId || '');

      if (id.startsWith('setup:')) {
        if (!(await guard(ctx, interaction))) return;
        return await setup.handleComponent(ctx, interaction);
      }

      if (id.startsWith('fb:')) {
        const [, vote] = id.split(':');
        return await feedback.handleFeedbackButton(ctx, interaction, vote);
      }

      if (id.startsWith('ord:')) {
        const [, action] = id.split(':');
        return await orders.handleOrderButton(ctx, interaction, action);
      }
      return;
    }

    // ---------- Modals ----------
    if (interaction.isModalSubmit?.()) {
      const id = String(interaction.customId || '');

      if (id.startsWith('setup:')) {
        if (!(await guard(ctx, interaction))) return;
        return await setup.handleModal(ctx, interaction);
      }
      if (id.startsWith('fb:modal:')) {
        const [, , vote] = id.split(':');
        return await feedback.handleFeedbackModal(ctx, interaction, vote);
      }
      if (id === 'ord:modal:create') {
        return await orders.handleOrderModal(ctx, interaction);
      }
    }
  } catch (err) {
    ctx.logger?.error?.('[security-bot] Interaction-Fehler:', err?.message || err);
    await safeReply(ctx, interaction, errorPayload(lang, err?.message || 'unbekannter Fehler'));
  }
}

module.exports = { handleInteraction };
