/**
 * ============================================================================
 *  Moderator – führt die Entscheidungen aus
 *
 *  Ablauf pro Verstoß:
 *    1. Nachricht + Nutzer prüfen (ID echt? immun? Maßnahme erlaubt?)
 *    2. Maßnahme ausführen (Timeout / Kick / Ban – Warn ist nur Text)
 *    3. Antwort im Kanal mit Ping auf die Verstoß-Nachricht
 *    4. DM an den Nutzer
 *    5. Eintrag ins Strafregister
 *    6. Meldung ins Log (mit 👍/👎 und „Neuer Auftrag“)
 *
 *  Wichtig: Es wird immer höchstens EINE Maßnahme pro Person und Durchgang
 *  angewendet (die schwerste). Team-Mitglieder sind immun.
 * ============================================================================
 */

const ui = require('./ui');
const { t } = require('./languages');
const { DURATIONS } = require('./prompts');
const { ruleLabel } = require('./rules');
const { actionEmoji, logModeration, withOrderButton } = require('./logging');

const MEASURE_RANK = { warn: 1, timeout: 2, kick: 3, ban: 4 };
const ORDER_RANK = ['warn', 'timeout', 'kick', 'ban'];
const MAX_TIMEOUT_SECONDS = 28 * 24 * 3600;

function allowedMeasures(cfg = {}) {
  const allow = cfg.allow || {};
  const list = ['warn'];
  if (allow.timeout !== false) list.push('timeout');
  if (allow.kick) list.push('kick');
  if (allow.ban) list.push('ban');
  return list;
}

/** Nicht erlaubte Maßnahme auf die nächstniedrigere erlaubte zurückstufen. */
function downgradeMeasure(measure, cfg) {
  const allowed = allowedMeasures(cfg);
  const wanted = ORDER_RANK.includes(measure) ? measure : 'warn';
  if (allowed.includes(wanted)) return { measure: wanted, downgraded: false };
  const index = ORDER_RANK.indexOf(wanted);
  for (let i = index - 1; i >= 0; i--) {
    if (allowed.includes(ORDER_RANK[i])) return { measure: ORDER_RANK[i], downgraded: true, from: wanted };
  }
  return { measure: 'warn', downgraded: true, from: wanted };
}

function normalizeDuration(action, durationSeconds) {
  if (action !== 'timeout') return 0;
  const seconds = Number(durationSeconds) || 0;
  if (seconds <= 0) return DURATIONS['10m'];
  return Math.min(MAX_TIMEOUT_SECONDS, seconds);
}

function formatDuration(seconds) {
  const entry = Object.entries(DURATIONS).find(([, s]) => s === Number(seconds));
  if (entry) return entry[0];
  const minutes = Math.round(Number(seconds) / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** Menschenlesbare Maßnahme (für Log, DM, Kanal). */
function measureText(action, durationSeconds, lang = 'de') {
  const label = t(lang, `${action}Label`);
  if (action !== 'timeout') return label;
  return `${label} (${formatDuration(durationSeconds)})`;
}

/**
 * Fertige Nutzer-Nachricht im Ton eines echten Moderators – Rückfall, wenn die
 * KI keine geschrieben hat.
 */
function fallbackUserMessage({ lang = 'de', userName = 'du', action = 'warn', ruleText = '', durationSeconds = 0, previousPenalties = 0 }) {
  const measure = measureText(action, durationSeconds, lang);
  if (lang === 'en') {
    const actionText = action === 'ban'
      ? 'Because of the severity of this violation and your previous warnings, you are being banned from this server.'
      : action === 'kick'
        ? 'You are being kicked from the server for this behavior.'
        : action === 'timeout'
          ? `You have been given a ${measure} to cool off.`
          : previousPenalties > 0
            ? `This is another official warning – further violations will result in stricter action.`
            : 'This is an official warning.';
    return `${userName}, your recent message violates our server rules${ruleText ? ` (${ruleText})` : ''}. Behavior like this harms the chat environment and makes other members feel uncomfortable. ${actionText} Please make sure to follow our community guidelines going forward.`;
  }
  const actionText = action === 'ban'
    ? 'Aufgrund der Schwere dieses Verstoßes und deiner vorherigen Einträge wirst du dauerhaft von diesem Server gebannt.'
    : action === 'kick'
      ? 'Wegen dieses Verstoßes wirst du vorübergehend vom Server entfernt.'
      : action === 'timeout'
        ? `Um dich und den Chat zu beruhigen, bekommst du ${measure === t(lang, 'timeoutLabel') ? 'einen Timeout' : `einen ${measure}`} Pause vom Schreiben.`
        : previousPenalties > 0
          ? `Das ist eine weitere offizielle Verwarnung – bei einem weiteren Verstoß werden wir härtere Maßnahmen ergreifen müssen.`
          : 'Das ist eine offizielle Verwarnung.';
  const whyText = ruleText
    ? `Deine Nachricht verstößt gegen die Regel **${ruleText}**. Solche Inhalte schaden der Gesprächsatmosphäre und machen anderen Mitgliedern das Chatten unangenehm, deshalb tolerieren wir das nicht.`
    : 'Deine Nachricht verstößt gegen unsere Serverregeln. Solche Inhalte schaden der Gesprächsatmosphäre, deshalb tolerieren wir das nicht.';
  const futureText = action === 'ban' || action === 'kick'
    ? ''
    : ' Bitte achte zukünftig darauf, dich an die Regeln zu halten und respektvoll mit anderen Mitgliedern umzugehen.';
  return `${userName}, ${whyText} ${actionText}${futureText}`;
}

// ------------------------------ Maßnahmen ausführen ------------------------------

async function executeMeasure({ guild, userId, action, durationSeconds = 0, reason = '' }) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { ok: false, error: 'member_not_found' };

  try {
    if (action === 'timeout') {
      await member.timeout(normalizeDuration('timeout', durationSeconds) * 1000, reason);
    } else if (action === 'kick') {
      await member.kick(reason);
    } else if (action === 'ban') {
      await guild.members.ban(userId, { reason, deleteMessageSeconds: 0 });
    }
    return { ok: true, member };
  } catch (err) {
    return { ok: false, error: err.message, member };
  }
}

// ------------------------------ Kanal + DM ------------------------------

async function channelOf(guild, channelId) {
  return guild.channels?.cache?.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
}

async function sendPublicNotice({ ctx, guild, record, text, accentColor }) {
  const channel = await channelOf(guild, record.channelId);
  if (!channel) return null;
  let body = ui.payload([ui.container([ui.text(text)], { accentColor })], {
    allowedMentions: { parse: [], users: [record.authorId], repliedUser: false },
  });
  const cfg = ctx?.store.getGuild(guild.id);
  if (String(channel.id) === String(cfg?.logChannelId)) body = withOrderButton(body, cfg.lang || 'de');
  const original = await channel.messages?.fetch?.(record.messageId).catch(() => null);
  if (original?.reply) {
    try {
      return await original.reply(body);
    } catch {
      /* Nachricht weg oder Rechte fehlen → normal senden */
    }
  }
  try {
    return await channel.send(body);
  } catch {
    return null;
  }
}

function buildModerationDm({ guild, lang = 'de', measureLabel, publicMessage = null, record = null }) {
  const title = t(lang, 'modDmTitle', { guild: guild.name });
  const lines = [
    ui.text(`## ${title}`),
    ui.text(`**${t(lang, 'modAction')}:** ${measureLabel}`),
  ];
  const messageUrl =
    publicMessage?.url ||
    (publicMessage?.id && record?.channelId
      ? `https://discord.com/channels/${guild.id}/${record.channelId}/${publicMessage.id}`
      : null);
  if (messageUrl) lines.push(ui.text(`[${t(lang, 'modDmMoreInfo')}](${messageUrl})`));

  let iconUrl = null;
  try {
    iconUrl = guild.iconURL?.({ extension: 'png', size: 256 }) || null;
  } catch {
    /* Ohne Server-Icon bleibt nur der Text übrig. */
  }

  const content = iconUrl
    ? [{ type: 9, components: lines, accessory: { type: 11, media: { url: iconUrl } } }]
    : lines;
  return ui.payload([ui.container(content, { accentColor: 0xed4245 })]);
}

async function sendDirectMessage({ ctx, userId, text, accentColor, payload = null }) {
  const user = await ctx.client.users.fetch(userId).catch(() => null);
  if (!user?.send) return null;
  try {
    return await user.send(payload || ui.payload([ui.container([ui.text(text)], { accentColor })]));
  } catch {
    return null;
  }
}

// ------------------------------ Hauptablauf ------------------------------

/**
 * Wendet die Entscheidungen der KI an.
 *
 * @param {object} params
 * @param {Map<number, object>} params.idMap   ID → gepufferte Nachricht
 * @param {Array} params.decisions             verstoesse[] aus der KI-Antwort
 */
async function applyModerations({
  ctx,
  guild,
  idMap,
  decisions,
  source = 'ai',
  forcedBy = null,
  moderatorName = null,
  orderInstruction = null,
} = {}) {
  const store = ctx.store;
  const cfg = store.getGuild(guild.id);
  const lang = cfg.lang || 'de';
  const applied = [];
  const skipped = [];

  // 1) Validieren + pro Person nur die schwerste Maßnahme behalten
  const byUser = new Map();
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    const record = idMap?.get(Number(decision?.nachricht_id));
    if (!record) {
      skipped.push({ reason: 'unbekannte_id', decision });
      continue;
    }
    if (record.immune) {
      skipped.push({ reason: 'immun', record });
      continue;
    }
    const existing = byUser.get(record.authorId);
    const rank = MEASURE_RANK[decision?.massnahme] || 1;
    if (!existing || rank > existing.rank) {
      byUser.set(record.authorId, { record, decision, rank });
    }
  }

  for (const { record, decision } of byUser.values()) {
    const { measure, downgraded } = downgradeMeasure(decision.massnahme, cfg);
    const seconds = normalizeDuration(measure, DURATIONS[decision.dauer] ?? DURATIONS['10m']);
    const ruleText = ruleLabel(decision.regel_id, cfg.rules) || String(decision.regel_id || 'Regel');
    const reason = String(decision.begruendung || '').slice(0, 300) || 'Regelverstoß';
    const confidence = Number(decision.konfidenz) || 0;
    const previous = store.listPenalties(guild.id, { userId: record.authorId }).length;

    // 2) Maßnahme ausführen (warn braucht keine Aktion)
    let execution = { ok: true, skipped: true };
    if (measure !== 'warn') {
      execution = await executeMeasure({
        guild,
        userId: record.authorId,
        action: measure,
        durationSeconds: seconds,
        reason: `[${ruleText}] ${reason}`.slice(0, 500),
      });
      if (!execution.ok && execution.error === 'member_not_found') {
        skipped.push({ reason: 'nutzer_weg', record });
        continue;
      }
      if (!execution.ok) {
        ctx.logger?.warn?.(`[security-bot] ${measure} für ${record.authorName} fehlgeschlagen: ${execution.error}`);
      }
    }

    const userText =
      String(decision.nutzer_nachricht || '').trim() ||
      fallbackUserMessage({
        lang,
        userName: record.authorName,
        action: measure,
        ruleText,
        durationSeconds: seconds,
        previousPenalties: previous,
      });
    const measureLabel = measureText(measure, seconds, lang);

    // 3) Öffentliche Antwort mit Ping auf die Verstoß-Nachricht – volle Länge der KI-Antwort (max 1900 Zeichen, Discord-Limit ist 2000)
    const publicText = `<@${record.authorId}> ${ui.clip(userText, 1900)}`;
    const publicMessage = await sendPublicNotice({ ctx, guild, record, text: publicText, accentColor: 0xed4245 });

    // 4) Rote DM mit Server-Icon, Maßnahme und Link zur öffentlichen Begründung
    await sendDirectMessage({
      ctx,
      userId: record.authorId,
      payload: buildModerationDm({ guild, lang, measureLabel, publicMessage, record }),
    });

    // 5) Strafregister
    const penalty = store.addPenalty({
      guildId: guild.id,
      userId: record.authorId,
      userName: record.authorName,
      action: measure,
      duration: measure === 'timeout' ? formatDuration(seconds) : null,
      ruleId: decision.regel_id,
      ruleLabel: ruleText,
      reason,
      excerpt: ui.clip(record.content, 250),
      channelId: record.channelId,
      messageId: record.messageId,
      source,
      forcedBy,
    });

    // 6) Log
    const logMessage = await logModeration(ctx, guild, {
      lang,
      userLine: `${record.authorName} (<@${record.authorId}> · \`${record.authorId}\`) · ${t(lang, 'modRegister')}: ${previous}`,
      actionLine: `${actionEmoji(measure)} **${measureLabel}**${downgraded ? ' _(herabgestuft: nicht erlaubt)_' : ''}`,
      ruleLine: ruleText,
      quoteLine: record.content ? `„${ui.clip(record.content, 160)}“` : '(Anhang)',
      reasonLine: reason,
      extraLines: [
        orderInstruction ? `📋 ${t(lang, 'modOrderBy')}: **${moderatorName || forcedBy || 'Moderator'}** (<@${forcedBy || ''}>) · „${ui.clip(orderInstruction, 120)}“` : '',
        execution.ok ? '' : `⚠️ Ausführung fehlgeschlagen: ${ui.clip(execution.error, 120)}`,
        publicMessage ? '' : '⚠️ Konnte die Nachricht im Kanal nicht posten.',
        `-# ${t(lang, 'modRule')}: ${ruleText} · ${t(lang, 'modAction')}: ${measureLabel} · Konfidenz ${confidence}%`,
      ],
      state: { up: 0, down: 0, voters: {}, penalties: [penalty.id] },
    });

    applied.push({ record, decision, measure, seconds, penalty, logMessage, publicMessage });
  }

  return { applied, skipped };
}

module.exports = {
  MEASURE_RANK,
  ORDER_RANK,
  allowedMeasures,
  downgradeMeasure,
  normalizeDuration,
  formatDuration,
  measureText,
  fallbackUserMessage,
  executeMeasure,
  sendPublicNotice,
  buildModerationDm,
  sendDirectMessage,
  applyModerations,
};
