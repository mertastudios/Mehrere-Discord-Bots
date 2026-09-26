/**
 * /security_ai_order – freier KI-Auftrag auf den kompletten Chatverlauf.
 *
 * Der Admin beschreibt in einem Formular,
 *   1. WAS die KI tun soll ("Prüfe den Streit in #allgemein und moderiere alle,
 *      die gegen X nachtreten"), und
 *   2. WARUM (Hintergrund, Beschwerden, Vorgeschichte, Sorgen des Teams).
 *
 * Der Bot schickt beides zusammen mit dem gesammelten UND live nachgelesenen
 * Chatverlauf an Gemini und wendet die zurückgegebenen Maßnahmen an – wie
 * immer so, als hätte der Bot selbst moderiert. Der Auftrag selbst taucht im
 * Chat nirgends auf.
 */

const {
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');

const { componentsV2Payload } = require('./message-payload');
const { smallContainer, clip } = require('./embed-builder');
const { collectRecentMessages } = require('./message-scan');
const { sendLogNotice } = require('./notices');

const MODAL_ID = 'secgem_modal_order';
const LIVE_SCAN_LIMIT = 250;
const MAX_MESSAGES = 400;

function isAdminInteraction(interaction) {
  const perms = interaction.memberPermissions ?? interaction.member?.permissions;
  return Boolean(perms?.has?.(PermissionFlagsBits.Administrator));
}

function ephemeralText(text) {
  return componentsV2Payload([smallContainer(null, text)], { ephemeral: true });
}

/** Öffnet das Auftrags-Formular. */
async function handleAiOrderCommand(ctx, interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply(ephemeralText('❌ Dieser Befehl funktioniert nur auf einem Server.'));
  }
  if (!isAdminInteraction(interaction)) {
    return interaction.reply(ephemeralText('⛔ Dieser Befehl ist nur für Administratoren.'));
  }
  const cfg = ctx.store.ensureGuild(interaction.guildId);
  if (!cfg.geminiApiKey) {
    return interaction.reply(
      ephemeralText('❌ Es ist **kein Gemini-Key** hinterlegt – setze ihn zuerst mit `/set_gemini_api_key`.')
    );
  }

  const modal = new ModalBuilder().setCustomId(MODAL_ID).setTitle('KI-Auftrag an den Sicherheitsbot');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('secgem_order_task')
        .setLabel('Was soll die KI tun?')
        .setPlaceholder('z. B. Prüfe den Streit in #allgemein und moderiere alle, die gegen Lena nachtreten.')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(1200)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('secgem_order_reason')
        .setLabel('Warum? (Begründung / Hintergrund)')
        .setPlaceholder('z. B. Mehrere Mitglieder haben sich beschwert, die Stimmung kippt seit gestern.')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(1200)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('secgem_order_focus')
        .setLabel('Optional: Fokus, Grenzen, Wunsch-Strenge')
        .setPlaceholder('z. B. Nur die letzten 2 Stunden, im Zweifel nur verwarnen.')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(800)
        .setRequired(false)
    )
  );

  return interaction.showModal(modal);
}

/** Sammelt Buffer + wartende Batches + Live-Verlauf und dedupliziert sie. */
async function gatherHistory(ctx, interaction) {
  const gid = String(interaction.guildId);
  const fromStore = [];
  try {
    for (const rec of ctx.store.getBuffer(gid) || []) fromStore.push(rec);
    for (const batch of ctx.store.getBatches(gid) || []) {
      for (const rec of ctx.store.getBatchMessages(gid, batch.id) || []) fromStore.push(rec);
    }
  } catch {}

  let live = [];
  try {
    const scan = await collectRecentMessages({ ctx, guild: interaction.guild, limit: LIVE_SCAN_LIMIT });
    live = scan.messages;
  } catch (err) {
    ctx.logger?.warn?.('[security-bot] Live-Scan für /security_ai_order fehlgeschlagen:', err?.message || err);
  }

  const byKey = new Map();
  for (const rec of [...fromStore, ...live]) {
    if (!rec || !String(rec.content || '').trim()) continue;
    const key = String(rec.discordMessageId || `${rec.channelId}:${rec.ord}`);
    if (!byKey.has(key)) byKey.set(key, { ...rec, seq: null });
  }
  const all = [...byKey.values()].sort((a, b) => a.ord - b.ord);
  return all.slice(-MAX_MESSAGES);
}

/** Verarbeitet das abgeschickte Auftrags-Formular. */
async function handleAiOrderModal(ctx, interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply(ephemeralText('❌ Dieser Befehl funktioniert nur auf einem Server.'));
  }
  if (!isAdminInteraction(interaction)) {
    return interaction.reply(ephemeralText('⛔ Dieser Befehl ist nur für Administratoren.'));
  }

  const order = String(interaction.fields.getTextInputValue('secgem_order_task') || '').trim();
  const reasoning = String(interaction.fields.getTextInputValue('secgem_order_reason') || '').trim();
  let focus = '';
  try {
    focus = String(interaction.fields.getTextInputValue('secgem_order_focus') || '').trim();
  } catch {}

  if (!order || !reasoning) {
    return interaction.reply(ephemeralText('❌ Auftrag und Begründung dürfen nicht leer sein.'));
  }

  await interaction.deferReply({ ephemeral: true });

  const messages = await gatherHistory(ctx, interaction);
  if (!messages.some((m) => !m.isAdmin)) {
    return interaction.editReply(
      componentsV2Payload([
        smallContainer(
          null,
          '❌ Ich konnte **keinen moderierbaren Chatverlauf** einlesen (keine Nachrichten oder keine ' +
            'Leseberechtigung). Ohne Verlauf kann die KI keinen Auftrag ausführen.'
        ),
      ])
    );
  }

  const { runCustomOrder } = require('./moderator');
  let result;
  try {
    result = await runCustomOrder({ ctx, guildId: interaction.guildId, messages, order, reasoning, focus });
  } catch (err) {
    ctx.logger?.error?.('[security-bot] /security_ai_order fehlgeschlagen:', err?.message || err);
    result = { ok: false, error: String(err?.message || err) };
  }

  if (!result.ok) {
    const hint =
      result.error === 'missing_api_key'
        ? 'Es ist kein Gemini-Key hinterlegt (`/set_gemini_api_key`).'
        : `Fehler: \`${clip(String(result.error || 'unbekannt'), 200)}\`` +
          (result.message ? `\n\`${clip(String(result.message), 300)}\`` : '');
    return interaction.editReply(
      componentsV2Payload([
        smallContainer(null, `❌ **Der KI-Auftrag konnte nicht ausgeführt werden.**\n${hint}`),
      ])
    );
  }

  const applied = result.applied || [];
  const summary = applied.length
    ? applied
        .map((entry) => {
          const measure =
            entry.action === 'timeout'
              ? `**Timeout (${entry.duration || '1h'})**${entry.timeoutApplied ? '' : ' ⚠️ _(nicht setzbar)_'}`
              : '**Verwarnung**';
          return `• <@${entry.userId}> → ${measure}\n> **${clip(String(entry.reason || '—').replace(/\*+/g, ''), 200)}**`;
        })
        .join('\n')
    : '_Die KI hat im Verlauf nichts gefunden, das den Auftrag erfüllt – es wurde nichts unternommen._';

  await sendLogNotice(
    ctx,
    interaction.guildId,
    smallContainer(
      '🧠 KI-Auftrag ausgeführt',
      [
        `**Auftrag:** ${clip(order, 700)}`,
        `**Begründung:** ${clip(reasoning, 700)}`,
        focus ? `**Fokus:** ${clip(focus, 400)}` : '',
        `**Analysierte Nachrichten:** ${result.analyzed}`,
        `**Maßnahmen:** ${applied.length}`,
        summary,
        '',
        `-# Intern angestoßen von <@${interaction.user.id}> über /security_ai_order.`,
      ]
        .filter(Boolean)
        .join('\n')
    )
  );

  return interaction.editReply(
    componentsV2Payload([
      smallContainer(
        null,
        [
          `✅ **Auftrag ausgeführt** – ${result.analyzed} Nachrichten geprüft, **${applied.length} Maßnahme(n)**.`,
          '',
          summary,
          '',
          'Im Chat wirkt alles wie eine eigenständige Entscheidung des Bots – **dein Auftrag bleibt intern**.',
        ].join('\n')
      ),
    ])
  );
}

module.exports = {
  handleAiOrderCommand,
  handleAiOrderModal,
  gatherHistory,
  MODAL_ID,
};
