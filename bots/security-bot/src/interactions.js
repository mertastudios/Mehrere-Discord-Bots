/**
 * Interaktions-Router für Slash-Commands und Modals.
 *
 * Der neue Befehlssatz benötigt keine Buttons oder Select-Menüs mehr:
 *   - Slash-Commands: /set_gemini_api_key, /set_prompt, /set_log_channel,
 *     /set_language, /help
 *   - Modal: secgem_modal_prompt (KI-Anweisungen aus /set_prompt)
 */

const { PermissionFlagsBits } = require('discord.js');

const { handleChatInput } = require('./commands');
const { smallContainer } = require('./embed-builder');
const { componentsV2Payload } = require('./message-payload');
const { t, langFromDiscord } = require('./languages');

async function handleInteraction(ctx, interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      return await handleChatInput(ctx, interaction);
    }

    if (interaction.isModalSubmit()) {
      return await handleModalSubmit(ctx, interaction);
    }

    if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
      const { handlePanelInteraction } = require('./admin-panel');
      return await handlePanelInteraction(ctx, interaction);
    }
  } catch (err) {
    ctx.logger?.error?.('[security-bot] Fehler bei Interaction-Handling:', err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply(
          componentsV2Payload([smallContainer(null, '❌ Ein Fehler ist aufgetreten.')], { ephemeral: true })
        );
      } else if (interaction.deferred && !interaction.replied) {
        await interaction.editReply(
          componentsV2Payload([smallContainer(null, '❌ Ein Fehler ist aufgetreten.')])
        );
      }
    } catch {}
  }
}

// ----------------- Modal Handler -----------------

async function handleModalSubmit(ctx, interaction) {
  const id = interaction.customId;

  if (id === 'secgem_modal_prompt') {
    if (!interaction.inGuild()) {
      return interaction.reply(
        componentsV2Payload([smallContainer(null, t('errGuildOnly', 'en'))], { ephemeral: true })
      );
    }
    const perms = interaction.memberPermissions ?? interaction.member?.permissions;
    const lang = ctx.store.ensureGuild(interaction.guildId).lang || langFromDiscord(interaction.locale);
    if (!perms?.has?.(PermissionFlagsBits.Administrator)) {
      return interaction.reply(
        componentsV2Payload([smallContainer(null, t('errNoPermission', lang))], { ephemeral: true })
      );
    }

    const raw = interaction.fields.getTextInputValue('secgem_input_prompt')?.trim() || '';
    if (!raw) {
      // Leer abgeschickt -> auf Standardtext zurücksetzen.
      ctx.store.setPrompt(interaction.guildId, null);
      await ctx.store.flush();
      return interaction.reply(
        componentsV2Payload([smallContainer(null, t('promptReset', lang))], { ephemeral: true })
      );
    }

    ctx.store.setPrompt(interaction.guildId, raw);
    await ctx.store.flush();
    return interaction.reply(
      componentsV2Payload(
        [smallContainer(null, t('promptSaved', lang, { chars: raw.length }))],
        { ephemeral: true }
      )
    );
  }

  return null;
}

module.exports = { handleInteraction };
