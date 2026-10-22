/**
 * ============================================================================
 *  Log-Kanal
 *
 *  - Der Bot legt seinen Log-Kanal selbst an (oder nimmt den gewählten),
 *    setzt die Berechtigungen und baut ihn wieder auf, wenn er gelöscht wird.
 *  - Überwacht der Bot den Log-Kanal selbst, nimmt er ihn aus der Liste.
 *  - Jede Moderation landet hier: wer, warum, welche Maßnahme – mit Zitat,
 *    Regel, Begründung und den Buttons 👍/👎 (Zähler steckt unsichtbar in der
 *    Nachricht), sowie „Neuer Auftrag“.
 *  - Fehler und Groq-Limits werden hier ebenfalls gemeldet (inklusive Angabe,
 *    wann sich das Limit erneuert).
 * ============================================================================
 */

const { PermissionFlagsBits, ChannelType } = require('discord.js');
const ui = require('./ui');
const { t } = require('./languages');
const { encodeLogState } = require('./hidden');

const AUTO_LOG_NAME = 'mod-log';
const AUTOMOD_NAME = 'moderation-log';

const ACCENT = {
  mod: 0x5865f2,
  ok: 0x57f287,
  warn: 0xfee75c,
  error: 0xed4245,
  neutral: 0x2b2d31,
};

function actionEmoji(action) {
  switch (action) {
    case 'ban':
      return '🔨';
    case 'kick':
      return '👢';
    case 'timeout':
      return '⏳';
    default:
      return '⚠️';
  }
}

// ------------------------------ Berechtigungen ------------------------------

function immuneRoleIdsOf(guild, cfg) {
  const ids = new Set((cfg?.immuneRoles || []).map(String));
  const botHighest = guild.members?.me?.roles?.highest?.position ?? 0;
  for (const [, role] of guild.roles?.cache || []) {
    if (role.managed && role.id !== guild.id) continue;
    if (typeof role.position === 'number' && role.position >= botHighest) ids.add(role.id);
    if (role.permissions?.has?.(PermissionFlagsBits.Administrator)) ids.add(role.id);
  }
  ids.delete(guild.id); // @everyone bekommt nie Zugriff
  return [...ids];
}

/** Setzt die Log-Kanal-Rechte: nur Owner, Bot und Team-Rollen. */
async function applyLogPermissions(ctx, guild, channel, cfg) {
  const botId = guild.members?.me?.id || ctx.client?.user?.id;
  const allowRoles = immuneRoleIdsOf(guild, cfg);

  const base = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels,
      ],
    },
    {
      id: guild.ownerId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    ...allowRoles.map((id) => ({
      id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    })),
  ];

  try {
    await channel.permissionOverwrites.set(base);
    return { ok: true };
  } catch (err) {
    // Rollen über dem Bot lassen sich nicht bearbeiten → sichere Teilmenge setzen.
    try {
      const safe = base.filter((o, index) => index < 3);
      await channel.permissionOverwrites.set(safe);
      return { ok: true, partial: true };
    } catch (err2) {
      ctx.logger?.warn?.('[security-bot] Log-Kanal-Rechte konnten nicht gesetzt werden:', err2.message);
      return { ok: false, error: err2.message };
    }
  }
}

async function createLogChannel(ctx, guild, cfg) {
  if (!guild.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageChannels)) {
    return { ok: false, error: 'missing_manage_channels' };
  }
  const used = new Set((guild.channels?.cache || new Map()).keys());
  const name = used.has(AUTO_LOG_NAME) ? AUTOMOD_NAME : AUTO_LOG_NAME;
  try {
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      topic: 'Moderations-Log & Meldungen des Sicherheits-Bots',
      reason: 'Sicherheits-Bot: Log-Kanal',
    });
    await applyLogPermissions(ctx, guild, channel, cfg);
    return { ok: true, channel };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Stellt einen bereits konfigurierten Log-Kanal sicher. Einen fehlenden Kanal
 * legt der Bot nur nach abgeschlossenem Setup neu an. Der erstmalige Kanal wird
 * weiterhin ausschließlich bewusst in Schritt 6 des Setups erstellt/ausgewählt.
 */
async function ensureLogChannel(ctx, guild, { createIfMissing = true } = {}) {
  const store = ctx.store;
  let cfg = store.getGuild(guild.id);

  // Ohne zuvor eingestellten Kanal gibt es nichts selbstheilend wiederherzustellen.
  if (!cfg.logChannelId) return { ok: false, error: 'no_log_channel', cfg };

  let channel = guild.channels?.cache?.get(cfg.logChannelId);
  if (!channel) {
    channel = await guild.channels.fetch(cfg.logChannelId).catch(() => null);
  }
  if (channel) {
    // Log-Kanal darf nie gleichzeitig überwacht werden
    if ((cfg.channels || []).includes(String(channel.id))) {
      cfg = store.updateGuild(guild.id, { channels: cfg.channels.filter((id) => String(id) !== String(channel.id)) });
    }
    return { ok: true, channel, recreated: false, cfg };
  }

  // Ein unvollständiges Setup darf niemals automatisch einen Kanal erzeugen.
  if (!cfg.setup.done) {
    return { ok: false, error: 'setup_incomplete', recreated: false, cfg };
  }

  // Der zuvor eingestellte Kanal ist weg → neu anlegen und ankündigen.
  if (createIfMissing) {
    const created = await createLogChannel(ctx, guild, cfg);
    if (created.ok) {
      cfg = store.updateGuild(guild.id, { logChannelId: created.channel.id, logAuto: true });
      try {
        await created.channel.send(
          buildNoticeLog({
            lang: cfg.lang || 'de',
            lines: [t(cfg.lang || 'de', 'logRecreated', { channel: created.channel.name })],
            accentColor: ACCENT.warn,
          })
        );
      } catch {
        /* Ankündigung ist optional */
      }
      return { ok: true, channel: created.channel, recreated: true, cfg };
    }
    ctx.logger?.warn?.('[security-bot] Log-Kanal konnte nicht neu angelegt werden:', created.error);
    return { ok: false, error: created.error, recreated: false, cfg };
  }
  return { ok: false, error: 'log_channel_missing', cfg };
}

// ------------------------------ Bausteine ------------------------------

function orderButton({ lang = 'de', penaltyId = 'none', disabled = false } = {}) {
  return ui.button({ id: `ord:new:${penaltyId}`, label: t(lang, 'orderButton'), style: ui.STYLE.secondary, disabled });
}

/** Adds the log action once, without mutating the caller's payload. */
function withOrderButton(payload, lang = 'de') {
  const hasOrderButton = (nodes) => (nodes || []).some((node) =>
    node.custom_id?.startsWith('ord:new') || hasOrderButton(node.components)
  );
  if (hasOrderButton(payload.components)) return payload;

  const components = [...payload.components];
  const index = components.findLastIndex((node) => node.type === 17);
  const actions = [ui.separator(), ui.row([orderButton({ lang })])];
  if (index >= 0) {
    components[index] = { ...components[index], components: [...components[index].components, ...actions] };
  } else {
    components.push(ui.container(actions));
  }
  return { ...payload, components };
}

function buttonRow({ state, penaltyIds = [], lang = 'de', disabled = false }) {
  const firstId = penaltyIds[0] || 'none';
  return ui.row([
    ui.button({ id: `fb:up:${firstId}`, label: `👍 (${state?.up || 0})`, style: ui.STYLE.success, disabled }),
    ui.button({ id: `fb:down:${firstId}`, label: `👎 (${state?.down || 0})`, style: ui.STYLE.danger, disabled }),
    orderButton({ lang, penaltyId: firstId, disabled }),
  ]);
}

/**
 * Baut die Log-Nachricht einer Moderation (auch zum Neu-Rendern nach Votes).
 * Der Zustand (Zähler + Bewerter + Register-IDs) steckt unsichtbar im Text.
 */
function buildModerationLog({ lang = 'de', userLine, actionLine, ruleLine, quoteLine, reasonLine, extraLines = [], state }) {
  const body = [
    `${actionLine}`,
    userLine ? `👤 ${userLine}` : '',
    ruleLine ? `📜 ${ruleLine}` : '',
    quoteLine ? `💬 ${quoteLine}` : '',
    reasonLine ? `🧠 ${reasonLine}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const stateText = encodeLogState({
    up: state?.up || 0,
    down: state?.down || 0,
    voters: state?.voters || {},
    penalties: state?.penalties || [],
  });

  const components = [
    ui.text(t(lang, 'modTitle')),
    ui.separator(),
    ui.text(`${body}\n${extraLines.filter(Boolean).join('\n')}${stateText}`),
    ui.separator(),
    buttonRow({ state, penaltyIds: state?.penalties || [], lang }),
  ];
  return ui.payload([ui.container(components, { accentColor: ACCENT.mod })]);
}

/** Baut einen einfachen Log-Eintrag (Fehler, Hinweise, Limits). */
function buildNoticeLog({ lang = 'de', lines, accentColor = ACCENT.neutral }) {
  return withOrderButton(ui.payload([ui.container([ui.text(lines.join('\n'))], { accentColor })]), lang);
}

// ------------------------------ Senden ------------------------------

async function sendToLog(ctx, guild, payload) {
  const { ok, channel, cfg } = await ensureLogChannel(ctx, guild);
  if (!ok || !channel) {
    ctx.logger?.warn?.('[security-bot] Kein Log-Kanal verfügbar – Meldung verworfen.');
    return null;
  }
  try {
    return await channel.send({ ...withOrderButton(payload, cfg.lang || 'de'), allowedMentions: { parse: [] } });
  } catch (err) {
    ctx.logger?.warn?.('[security-bot] Log-Nachricht fehlgeschlagen:', err.message);
    return null;
  }
}

/** Moderation ins Log (mit Buttons + unsichtbarem Zustand). */
async function logModeration(ctx, guild, details) {
  const payload = buildModerationLog(details);
  return sendToLog(ctx, guild, payload);
}

async function logNotice(ctx, guild, { lang = 'de', title = null, lines = [], accentColor = ACCENT.neutral }) {
  const content = [title, ...lines].filter(Boolean).join('\n');
  return sendToLog(ctx, guild, buildNoticeLog({ lang, lines: [content], accentColor }));
}

async function logError(ctx, guild, { lang = 'de', detail, hint = null }) {
  return logNotice(ctx, guild, {
    lang,
    title: t(lang, 'errorTitle'),
    lines: [detail, hint].filter(Boolean),
    accentColor: ACCENT.error,
  });
}

/** Rate-Limit-Meldung inklusive Angabe, wann es weitergeht. */
async function logRateLimit(ctx, guild, { lang = 'de', resetText, pending = 0, detail = null }) {
  return logNotice(ctx, guild, {
    lang,
    title: t(lang, 'rateLimitTitle'),
    lines: [detail, t(lang, 'rateLimitBody', { reset: resetText, pending })].filter(Boolean),
    accentColor: ACCENT.warn,
  });
}

/** Nette Begrüßung im Log, wenn das Setup abgeschlossen wurde. */
async function logSetupDone(ctx, guild, { lang = 'de' }) {
  const botName = ctx.client?.user?.username || 'Sentinel';
  return logNotice(ctx, guild, {
    lang,
    lines: [t(lang, 'logWelcomeSetupDone', { bot: `**${botName}**` })],
    accentColor: ACCENT.ok,
  });
}

module.exports = {
  AUTO_LOG_NAME,
  ACCENT,
  actionEmoji,
  immuneRoleIdsOf,
  applyLogPermissions,
  createLogChannel,
  ensureLogChannel,
  buildModerationLog,
  buildNoticeLog,
  buttonRow,
  withOrderButton,
  sendToLog,
  logModeration,
  logNotice,
  logError,
  logRateLimit,
  logSetupDone,
};
