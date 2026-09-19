/**
 * UI-Container (Discord Components V2) für den Sicherheitsbot.
 */

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require('discord.js');

const { t } = require('./languages');

const MAX_TEXT = 3800; // Sicherheitsmarge unter Discords 4000-Zeichen-Limit pro TextDisplay

function clip(text, max = 300) {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Kompakter Hinweis-Container: Überschrift (optional) + Text. */
function smallContainer(heading, text) {
  const parts = [];
  if (heading) parts.push(`## ${heading}`);
  parts.push(String(text || '').slice(0, MAX_TEXT));
  const container = new ContainerBuilder();
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(parts.join('\n')));
  return container;
}

/** /help – Befehlsübersicht mit klickbaren Command-Mentions. */
function buildHelpContainer({ lang, commands }) {
  const lines = [
    `# ${t('helpTitle', lang)}`,
    t('helpDesc', lang),
    '',
    `**${commands.set_gemini_api_key}**\n${t('helpApiKey', lang)}`,
    '',
    `**${commands.set_prompt}**\n${t('helpPrompt', lang)}`,
    '',
    `**${commands.set_log_channel}**\n${t('helpLogChannel', lang)}`,
    '',
    `**${commands.set_anti_delete_messages}**\n${t('helpAntiDelete', lang)}`,
    '',
    `**${commands.set_language}**\n${t('helpLanguage', lang)}`,
    '',
    `**${commands.security_check_now}**\n${t('helpCheckNow', lang)}`,
    '',
    `**${commands.security_action}**\n🎯 Führt eine Verwarnung oder einen Timeout exakt für das gewählte Mitglied aus – optional mit konkretem Nachrichtenlink, ohne KI-Warteschlange.`,
    '',
    `**${commands.security_status}**\n📊 Zeigt Key, Log-Kanal, Prompt, Anti-Delete und wartende Analysen auf einen Blick.`,
    '',
    `**${commands.help}**\n${t('helpHelp', lang)}`,
  ];

  const container = new ContainerBuilder();
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join('\n').slice(0, MAX_TEXT))
  );
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `🧠 **KI-Verhalten:** Warnung ⚠️ oder Timeout ⏱️ (1m / 5m / 10m / 1h / 1d / 1w) – die Antwort des Bots geht immer auf den schwerwiegendsten Verstoß. Administratoren sind immun. 🔒`
    )
  );
  return container;
}

function actionLabel(lang, moderation) {
  if (moderation.action === 'timeout') {
    let label = `${t('logActionTimeout', lang)} (${moderation.duration})`;
    if (moderation.issue) label += ` ⚠️ _(${moderation.issue})_`;
    return label;
  }
  return t('logActionWarn', lang);
}

/**
 * Log-Kanal-Hinweis zu einer einzelnen Moderation.
 * `moderation`: { userId, userName, action, duration, reason, primary,
 *                 excerpt, jumpLink, batchSize }
 */
function buildModerationLogContainer({ lang, moderation }) {
  const lines = [
    `## ${t('logModTitle', lang)}${moderation.primary ? `\n-# ${t('logPrimary', lang)}` : ''}`,
    `**${t('logFieldUser', lang)}:** <@${moderation.userId}> (\`${moderation.userName || moderation.userId}\`)`,
    `**${t('logFieldAction', lang)}:** ${actionLabel(lang, moderation)}`,
    `**${t('logFieldReason', lang)}:** ${clip(moderation.reason, 800) || '—'}`,
    moderation.excerpt ? `**${t('logFieldMessage', lang)}:**\n>>> ${clip(moderation.excerpt, 400)}` : '',
    moderation.jumpLink ? `${moderation.jumpLink}` : '',
    moderation.batchSize ? `-# ${t('logBatchSize', lang, { count: moderation.batchSize })}` : '',
  ].filter(Boolean);

  const container = new ContainerBuilder();
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join('\n').slice(0, MAX_TEXT))
  );
  return container;
}

/** Log-Kanal-Hinweis: API-Fehler, Batch bleibt erhalten. */
function buildApiErrorContainer({ lang, count, error, attempt, nextRetry }) {
  const container = new ContainerBuilder();
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      [
        `## ${t('logApiTitle', lang)}`,
        t('logApiDesc', lang, { count, error: clip(error, 300), attempt, retry: nextRetry }),
      ]
        .join('\n')
        .slice(0, MAX_TEXT)
    )
  );
  return container;
}

/** Log-Kanal-Hinweis: Kein API-Key gesetzt, obwohl Batches warten. */
function buildNoKeyContainer({ lang, count }) {
  const container = new ContainerBuilder();
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      [`## ${t('logNoKeyTitle', lang)}`, t('logNoKeyDesc', lang, { count })].join('\n')
    )
  );
  return container;
}

/** Log-Kanal-Hinweis: Veralteter Batch wurde aufgegeben. */
function buildDropContainer({ lang, count }) {
  const container = new ContainerBuilder();
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      [`## ${t('logDropTitle', lang)}`, t('logDropDesc', lang, { count })].join('\n')
    )
  );
  return container;
}

module.exports = {
  smallContainer,
  clip,
  buildHelpContainer,
  buildModerationLogContainer,
  buildApiErrorContainer,
  buildNoKeyContainer,
  buildDropContainer,
};
