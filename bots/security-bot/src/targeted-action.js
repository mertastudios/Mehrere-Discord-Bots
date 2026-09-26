/**
 * /security_action – gezielte, VERDECKTE KI-Moderation.
 *
 * Warum es diesen Befehl gibt:
 * Manche Admins trauen sich nicht, selbst zu moderieren (Angst vor Drama,
 * Stress, persönliche Anfeindungen). Statt selbst einen Timeout zu vergeben,
 * wählen sie hier nur die problematischen Nachrichten aus – die Maßnahme
 * trifft danach die KI, und nach außen wirkt es so, als hätte der Bot den
 * Verstoß beim normalen Scannen selbst gefunden und selbst entschieden.
 *
 * Ablauf:
 *   1. /security_action user:<Mitglied> [hinweis:<Text>]
 *   2. Der Bot liest die letzten ~200 Nachrichten dieses Nutzers live aus der
 *      Kanalhistorie (message-scan.js). Hat der Nutzer nichts geschrieben,
 *      kann er auch nicht moderiert werden – der Befehl bricht ab.
 *   3. Die Nachrichten erscheinen in einem Mehrfach-Auswahlmenü. Discord
 *      erlaubt nur 25 Optionen pro Select-Menü, deshalb gibt es Seiten;
 *      die Auswahl bleibt beim Blättern über alle Seiten hinweg erhalten.
 *   4. "KI entscheiden lassen" schickt die Auswahl an Gemini. Gemini sucht
 *      sich die schwerwiegendste Nachricht heraus, wählt Maßnahme und Dauer
 *      und formuliert die (fett formatierte) Begründung.
 *
 * Der Auftraggeber wird nirgends im Chat erwähnt – weder im Prompt-Ergebnis
 * noch in der Antwort des Bots. Nur der Log-Kanal bekommt einen internen
 * Vermerk, damit das Team nachvollziehen kann, was passiert ist.
 */

const {
  PermissionFlagsBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { componentsV2Payload } = require('./message-payload');
const { smallContainer, clip } = require('./embed-builder');
const { collectUserMessages, DEFAULT_USER_MESSAGE_LIMIT } = require('./message-scan');
const { sendLogNotice } = require('./notices');

const PREFIX = 'secact';
const PAGE_SIZE = 25;            // Discord-Hartlimit: 25 Optionen pro Select-Menü
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_CONTEXT_MESSAGES = 60; // zusätzliche (nicht moderierbare) Kontextnachrichten

const sessions = new Map();

function newToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function pruneSessions(now = Date.now()) {
  for (const [token, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(token);
  }
}

function keyOf(rec) {
  return String(rec.discordMessageId || `${rec.channelId}:${rec.ord}`);
}

function isAdminInteraction(interaction) {
  const perms = interaction.memberPermissions ?? interaction.member?.permissions;
  return Boolean(perms?.has?.(PermissionFlagsBits.Administrator));
}

function ephemeralText(text) {
  return componentsV2Payload([smallContainer(null, text)], { ephemeral: true });
}

function fmtTime(ms) {
  return `<t:${Math.floor(Number(ms) / 1000)}:R>`;
}

function shortTime(ms) {
  try {
    return new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 16);
  } catch {
    return '??';
  }
}

/** Auswahl-Label einer Nachricht (Discord: max. 100 Zeichen). */
function optionFor(rec, index) {
  const preview = String(rec.content || '')
    .replace(/\s+/g, ' ')
    .replace(/\\([\\*_`~|>#])/g, '$1')
    .trim();
  return {
    label: clip(`${index}. ${preview || '(kein Text)'}`, 95) || `${index}. (kein Text)`,
    value: keyOf(rec),
    description: clip(`#${rec.channelName || '?'} · ${shortTime(rec.sentAt)} UTC`, 95),
  };
}

function pageCount(session) {
  return Math.max(1, Math.ceil(session.messages.length / PAGE_SIZE));
}

function pageSlice(session) {
  const start = session.page * PAGE_SIZE;
  return session.messages.slice(start, start + PAGE_SIZE);
}

/** Baut die komplette (ephemere) Auswahl-Oberfläche neu auf. */
function renderSession(session, { busy = false, footer = '' } = {}) {
  const pages = pageCount(session);
  const slice = pageSlice(session);
  const selectedOnPage = slice.filter((rec) => session.selected.has(keyOf(rec)));

  const header = [
    '## 🤖 KI-Moderation vorbereiten',
    `**Mitglied:** <@${session.target.id}> (\`${session.target.name}\`)`,
    `**Gefundene Nachrichten:** ${session.messages.length}${session.truncated ? '+' : ''} ` +
      `(Scan über ${session.scanned} Nachrichten in ${session.channelsScanned} Kanälen)`,
    `**Ausgewählt:** ${session.selected.size}`,
    `**Seite:** ${session.page + 1}/${pages}`,
    '',
    'Wähle alle Nachrichten aus, die geprüft werden sollen – auch über mehrere Seiten hinweg.',
    'Die KI sucht sich daraus **selbst den schwersten Verstoß** heraus, entscheidet über',
    '**Verwarnung oder Timeout** und begründet die Maßnahme öffentlich so, als hätte sie den',
    'Verstoß beim normalen Scannen selbst entdeckt. **Dein Name taucht nirgends auf.**',
  ].join('\n');

  const container = new ContainerBuilder();
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header.slice(0, 3800)));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

  const listing = slice
    .map((rec, i) => {
      const index = session.page * PAGE_SIZE + i + 1;
      const mark = session.selected.has(keyOf(rec)) ? '✅' : '▫️';
      const text = clip(String(rec.content || '').replace(/\s+/g, ' '), 120);
      return `${mark} **${index}.** ${fmtTime(rec.sentAt)} in <#${rec.channelId}>\n> ${text}`;
    })
    .join('\n');
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent((listing || '_(keine Nachrichten auf dieser Seite)_').slice(0, 3800))
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:sel:${session.token}`)
    .setPlaceholder(`Nachrichten dieser Seite auswählen (Seite ${session.page + 1}/${pages})`)
    .setMinValues(0)
    .setMaxValues(Math.max(1, slice.length))
    .setDisabled(busy || slice.length === 0)
    .addOptions(
      slice.length
        ? slice.map((rec, i) => ({
            ...optionFor(rec, session.page * PAGE_SIZE + i + 1),
            default: session.selected.has(keyOf(rec)),
          }))
        : [{ label: 'Keine Nachrichten', value: 'none' }]
    );
  container.addActionRowComponents(new ActionRowBuilder().addComponents(select));

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:prev:${session.token}`)
        .setLabel('◀ Seite')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(busy || session.page === 0),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:next:${session.token}`)
        .setLabel('Seite ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(busy || session.page + 1 >= pages),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:all:${session.token}`)
        .setLabel(selectedOnPage.length === slice.length && slice.length ? 'Seite abwählen' : 'Ganze Seite wählen')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(busy || slice.length === 0),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:clear:${session.token}`)
        .setLabel('Auswahl leeren')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(busy || session.selected.size === 0)
    )
  );

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:run:${session.token}`)
        .setLabel(busy ? 'KI prüft …' : '🤖 KI entscheiden lassen')
        .setStyle(ButtonStyle.Success)
        .setDisabled(busy || session.selected.size === 0),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:cancel:${session.token}`)
        .setLabel('Abbrechen')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(busy)
    )
  );

  if (footer) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footer.slice(0, 3800)));
  }

  // Kein Ephemeral-Flag: Die Nachricht IST bereits ephemer (deferReply bzw.
  // Component-Update) – ein erneutes Flag würde Discord beim Bearbeiten stören.
  return componentsV2Payload([container]);
}

// ---------------------------------------------------------------------------
// Slash-Command
// ---------------------------------------------------------------------------

async function handleSecurityAction(ctx, interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply(ephemeralText('❌ Dieser Befehl funktioniert nur auf einem Server.'));
  }
  if (!isAdminInteraction(interaction)) {
    return interaction.reply(ephemeralText('⛔ Dieser Befehl ist nur für Administratoren.'));
  }

  const cfg = ctx.store.ensureGuild(interaction.guildId);
  if (!cfg.geminiApiKey) {
    return interaction.reply(
      ephemeralText(
        '❌ Es ist **kein Gemini-Key** hinterlegt. Ohne KI kann der Bot nicht moderieren – ' +
          'setze ihn zuerst mit `/set_gemini_api_key`.'
      )
    );
  }

  const user = interaction.options.getUser('user');
  const note = String(interaction.options.getString('hinweis') || '').trim();
  const ownId = ctx.client?.user?.id || interaction.client?.user?.id || null;

  let member = interaction.guild?.members?.cache?.get?.(user.id) || null;
  if (!member && typeof interaction.guild?.members?.fetch === 'function') {
    member = await interaction.guild.members.fetch(user.id).catch(() => null);
  }
  if (
    !member ||
    user.bot ||
    (ownId && String(user.id) === String(ownId)) ||
    member.permissions?.has?.(PermissionFlagsBits.Administrator)
  ) {
    return interaction.reply(
      ephemeralText(
        '❌ **Bots, unbekannte Mitglieder und Administratoren** können nicht moderiert werden.'
      )
    );
  }

  await interaction.deferReply({ ephemeral: true });

  const scan = await collectUserMessages({
    ctx,
    guild: interaction.guild,
    userId: user.id,
    limit: DEFAULT_USER_MESSAGE_LIMIT,
  });

  if (!scan.messages.length) {
    return interaction.editReply(
      componentsV2Payload([
        smallContainer(
          null,
          `❌ <@${user.id}> hat in den lesbaren Kanälen **keine Nachricht geschrieben** ` +
            `(${scan.scanned} Nachrichten in ${scan.channelsScanned} Kanälen durchsucht).\n` +
            'Wer nichts geschrieben hat, kann auch nicht moderiert werden.'
        ),
      ])
    );
  }

  pruneSessions();
  const token = newToken();
  const session = {
    token,
    createdAt: Date.now(),
    guildId: String(interaction.guildId),
    adminId: String(interaction.user.id),
    target: {
      id: String(user.id),
      name: member.displayName || user.globalName || user.username || String(user.id),
    },
    note,
    // Neueste zuerst – die interessanten Nachrichten stehen auf Seite 1.
    messages: [...scan.messages].sort((a, b) => b.ord - a.ord),
    scanned: scan.scanned,
    channelsScanned: scan.channelsScanned,
    truncated: scan.truncated,
    selected: new Set(),
    page: 0,
  };
  sessions.set(token, session);

  return interaction.editReply(renderSession(session));
}

// ---------------------------------------------------------------------------
// Button-/Select-Interaktionen
// ---------------------------------------------------------------------------

function isTargetedActionInteraction(interaction) {
  return typeof interaction?.customId === 'string' && interaction.customId.startsWith(`${PREFIX}:`);
}

async function handleComponent(ctx, interaction) {
  const [, action, token] = String(interaction.customId).split(':');
  const session = sessions.get(token);

  if (!session) {
    return interaction.update(
      componentsV2Payload([
        smallContainer(
          null,
          '⌛ Diese Auswahl ist abgelaufen. Starte `/security_action` einfach neu.'
        ),
      ])
    );
  }
  if (String(interaction.user.id) !== session.adminId) {
    return interaction.reply(ephemeralText('⛔ Diese Auswahl gehört zu einem anderen Administrator.'));
  }
  if (!isAdminInteraction(interaction)) {
    return interaction.reply(ephemeralText('⛔ Dieser Befehl ist nur für Administratoren.'));
  }
  session.createdAt = Date.now();

  const slice = pageSlice(session);
  const pageKeys = slice.map(keyOf);

  switch (action) {
    case 'sel': {
      // Die Auswahl der aktuellen Seite ersetzen; andere Seiten bleiben erhalten.
      const chosen = new Set(interaction.values || []);
      for (const key of pageKeys) session.selected.delete(key);
      for (const key of chosen) if (pageKeys.includes(key)) session.selected.add(key);
      return interaction.update(renderSession(session));
    }
    case 'prev':
      session.page = Math.max(0, session.page - 1);
      return interaction.update(renderSession(session));
    case 'next':
      session.page = Math.min(pageCount(session) - 1, session.page + 1);
      return interaction.update(renderSession(session));
    case 'all': {
      const allSelected = pageKeys.every((key) => session.selected.has(key));
      for (const key of pageKeys) {
        if (allSelected) session.selected.delete(key);
        else session.selected.add(key);
      }
      return interaction.update(renderSession(session));
    }
    case 'clear':
      session.selected.clear();
      return interaction.update(renderSession(session));
    case 'cancel':
      sessions.delete(token);
      return interaction.update(
        componentsV2Payload([
          smallContainer(null, '✅ Abgebrochen – es wurde **nichts** unternommen.'),
        ])
      );
    case 'run':
      return runSession(ctx, interaction, session);
    default:
      return interaction.update(renderSession(session));
  }
}

/** Führt die KI-Moderation für die ausgewählten Nachrichten aus. */
async function runSession(ctx, interaction, session) {
  if (!session.selected.size) {
    return interaction.reply(ephemeralText('❌ Wähle zuerst mindestens eine Nachricht aus.'));
  }

  await interaction.update(
    renderSession(session, {
      busy: true,
      footer: '⏳ Die KI liest die ausgewählten Nachrichten und entscheidet selbst über die Maßnahme …',
    })
  );

  const selected = session.messages.filter((rec) => session.selected.has(keyOf(rec)));
  const context = session.messages
    .filter((rec) => !session.selected.has(keyOf(rec)))
    .sort((a, b) => b.ord - a.ord)
    .slice(0, MAX_CONTEXT_MESSAGES);

  const { runTargetedModeration } = require('./moderator');
  let result;
  try {
    result = await runTargetedModeration({
      ctx,
      guildId: session.guildId,
      target: session.target,
      selected,
      context,
      adminNote: session.note,
    });
  } catch (err) {
    ctx.logger?.error?.('[security-bot] /security_action fehlgeschlagen:', err?.message || err);
    result = { ok: false, error: String(err?.message || err) };
  }

  sessions.delete(session.token);

  if (!result.ok) {
    const hint =
      result.error === 'missing_api_key'
        ? 'Es ist kein Gemini-Key hinterlegt (`/set_gemini_api_key`).'
        : `Fehler: \`${clip(String(result.error || 'unbekannt'), 200)}\`` +
          (result.message ? `\n\`${clip(String(result.message), 300)}\`` : '');
    return interaction.editReply(
      componentsV2Payload([
        smallContainer(
          null,
          `❌ **Die KI-Moderation konnte nicht ausgeführt werden.**\n${hint}\n\n` +
            'Es wurde **nichts** im Chat gepostet. Versuch es gleich noch einmal.'
        ),
      ])
    );
  }

  const applied = result.applied || [];
  if (!applied.length) {
    return interaction.editReply(
      componentsV2Payload([
        smallContainer(
          null,
          `🤔 **Die KI hat in den ${selected.length} ausgewählten Nachrichten keinen Verstoß gesehen** ` +
            'und deshalb bewusst nichts unternommen.\n' +
            'Der Chat bleibt unberührt – niemand erfährt von dieser Prüfung.\n\n' +
            '💡 Tipp: Wähle die eindeutigen Nachrichten aus oder beschreibe das Problem im ' +
            'Feld `hinweis`, damit die KI den Kontext versteht.'
        ),
      ])
    );
  }

  const lines = applied.map((entry) => {
    const measure =
      entry.action === 'timeout'
        ? `**Timeout (${entry.duration || '1h'})**${entry.timeoutApplied ? '' : ' ⚠️ _(konnte nicht gesetzt werden)_'}`
        : '**Verwarnung**';
    return `• <@${entry.userId}> → ${measure}\n> **${clip(String(entry.reason || '—').replace(/\*+/g, ''), 200)}**`;
  });

  await sendLogNotice(
    ctx,
    session.guildId,
    smallContainer(
      '🕵️ Verdeckte KI-Moderation',
      [
        `**Ziel:** <@${session.target.id}>`,
        `**Ausgewählte Nachrichten:** ${selected.length}`,
        `**Maßnahmen:** ${applied.length}`,
        ...lines,
        '',
        `-# Intern angestoßen von <@${session.adminId}> über /security_action – ` +
          'im Chat tritt ausschließlich der Bot als Moderator auf.',
      ].join('\n')
    )
  );

  return interaction.editReply(
    componentsV2Payload([
      smallContainer(
        null,
        [
          '✅ **Erledigt – die KI hat moderiert.**',
          '',
          ...lines,
          '',
          'Im Chat sieht es aus wie eine ganz normale, eigenständige Entscheidung des Bots: ' +
            'Die Begründung wurde als Antwort auf die Nachricht gepostet, **dein Name kommt nirgends vor**.',
        ].join('\n')
      ),
    ])
  );
}

module.exports = {
  handleSecurityAction,
  handleComponent,
  isTargetedActionInteraction,
  renderSession,
  sessions,
  PAGE_SIZE,
  PREFIX,
};
