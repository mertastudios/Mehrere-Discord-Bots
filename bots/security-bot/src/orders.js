/**
 * ============================================================================
 *  „Neuer Auftrag“ – der Moderator erzwingt eine Entscheidung
 *
 *  Ablauf:
 *   1. Grauer Button an jeder Log-Meldung → privates Panel (nur fürs Team).
 *   2. Bis zu 3 Nachrichten-IDs + eine Anweisung (z. B. „Banne ihn“).
 *   3. Der Bot holt die Nachrichten mit Kontext (±15 Nachrichten) und lässt die
 *      KI den Auftrag ausführen – sie tut so, als hätte sie den Verstoß selbst
 *      bemerkt (kein Hinweis auf den Auftrag im Chat).
 *   4. Im Log steht die Maßnahme inkl. „Auftrag von <Moderator>“.
 *   5. Ergibt die Anweisung keine klare Maßnahme → Log: „Keine klare Anweisung
 *      verstanden“ (ebenfalls mit Moderator).
 *   6. Groq-Limit oder Groq-Fehler → der vorbereitete Auftrag bleibt in einer
 *      Warteschlange, wird automatisch erneut versucht und kann entfernt werden.
 * ============================================================================
 */

const { randomUUID } = require('node:crypto');
const ui = require('./ui');
const { t } = require('./languages');
const { buildTranscript, estimateTokens, isImmune } = require('./transcript');
const { toRecord } = require('./collector');
const { buildSystemPrompt, buildOrderPrompt, verdictSchema } = require('./prompts');
const { callGroqWithFallback, modelFromEnv, nextBackoffMs } = require('./groq');
const { applyModerations } = require('./moderator');
const { logNotice, sendToLog, ACCENT } = require('./logging');
const { isTeamMember } = require('./guard');

const CONTEXT_RADIUS = 15;
const MAX_CHANNEL_SEARCH = 60;
const KEY_RETRY_MS = 60_000;

// ------------------------------ Panel ------------------------------

function orderPanel(lang) {
  return ui.payload(
    [
      ui.container(
        [
          ui.text(t(lang, 'orderPanelTitle')),
          ui.text(t(lang, 'orderPanelHint')),
          ui.separator(),
          ui.row([ui.button({ id: 'ord:create', label: t(lang, 'orderCreate'), style: ui.STYLE.primary, emoji: '📝' })]),
        ],
        { accentColor: ACCENT.mod }
      ),
    ],
    { ephemeral: true }
  );
}

// ------------------------------ Warteschlange ------------------------------

function orderQueueFor(ctx, guildId, { create = true } = {}) {
  if (!ctx.orderQueue) ctx.orderQueue = new Map();
  const key = String(guildId);
  if (!ctx.orderQueue.has(key) && create) ctx.orderQueue.set(key, new Map());
  return ctx.orderQueue.get(key) || null;
}

function orderFailureReason(lang, result) {
  const detail = [result.error, result.status, result.reason].filter(Boolean).join(' · ');
  if (result.error === 'rate_limited' || result.error === 'pacing') {
    return t(lang, 'orderQueueLimitReason', { detail });
  }
  return t(lang, 'orderQueueErrorReason', { detail: detail || 'unknown' });
}

function queuedOrderPayload(lang, order, result, { ephemeral = false } = {}) {
  const retry = `<t:${Math.floor(order.retryAt / 1000)}:R>`;
  return ui.payload(
    [
      ui.container(
        [
          ui.text(t(lang, 'orderQueuedTitle')),
          ui.text(
            t(lang, 'orderQueuedBody', {
              reason: orderFailureReason(lang, result),
              retry,
            })
          ),
          ui.text(
            `📋 ${t(lang, 'modOrderBy')}: **${ui.clip(order.moderatorName, 80)}** (<@${order.moderatorId}>)\n` +
              `💬 ${ui.clip(order.instruction, 200)}\n🔍 ${order.ids.map((id) => `\`${id}\``).join(', ')}`
          ),
          ui.separator(),
          ui.row([
            ui.button({ id: `ord:cancel:${order.id}`, label: t(lang, 'orderRemove'), style: ui.STYLE.danger, emoji: '🗑️' }),
            ui.button({ id: 'ord:new:none', label: t(lang, 'orderButton'), style: ui.STYLE.secondary }),
          ]),
        ],
        { accentColor: ACCENT.warn }
      ),
    ],
    { ephemeral }
  );
}

function queueStatusPayload(lang, text, { ephemeral = false, accentColor = ACCENT.neutral } = {}) {
  return ui.payload(
    [
      ui.container(
        [
          ui.text(text),
          ui.separator(),
          ui.row([ui.button({ id: 'ord:new:none', label: t(lang, 'orderButton'), style: ui.STYLE.secondary })]),
        ],
        { accentColor }
      ),
    ],
    { ephemeral }
  );
}

async function closeQueuedOrderLog(order, lang, text, accentColor) {
  if (!order.logMessage?.edit) return;
  await order.logMessage.edit(queueStatusPayload(lang, text, { accentColor })).catch(() => null);
}

async function cancelQueuedOrder(ctx, interaction) {
  const guild = interaction.guild;
  const lang = ctx.store.getGuild(guild.id).lang || 'de';
  const orderId = String(interaction.customId || '').split(':').slice(2).join(':');
  const queue = orderQueueFor(ctx, guild.id, { create: false });
  const order = queue?.get(orderId);

  if (!order) {
    return interaction.reply(
      queueStatusPayload(lang, t(lang, 'orderNotQueued'), { ephemeral: true, accentColor: ACCENT.warn })
    );
  }

  queue.delete(orderId);
  const clickedQueueLog = interaction.message?.id && String(interaction.message.id) === String(order.logMessage?.id);
  if (!clickedQueueLog) {
    await closeQueuedOrderLog(order, lang, t(lang, 'orderRemoved'), ACCENT.neutral);
  }

  const payload = queueStatusPayload(lang, t(lang, 'orderRemoved'), {
    ephemeral: !clickedQueueLog,
    accentColor: ACCENT.neutral,
  });
  return interaction.update ? interaction.update(payload) : interaction.reply(payload);
}

async function handleOrderButton(ctx, interaction, action) {
  const guild = interaction.guild;
  const lang = ctx.store.getGuild(guild.id).lang || 'de';

  if (!isTeamMember(interaction.member, guild)) {
    return interaction.reply(ui.payload([ui.container([ui.text(t(lang, 'onlyTeam'))])], { ephemeral: true }));
  }

  if (action === 'new') {
    return interaction.reply(orderPanel(lang));
  }

  if (action === 'create') {
    return interaction.showModal(
      ui.modal({
        id: 'ord:modal:create',
        title: t(lang, 'orderCreate'),
        components: [
          ui.textInput({ id: 'ids', label: t(lang, 'orderIdsLabel'), style: 1, required: true, maxLength: 100, placeholder: '123456789012345678, …' }),
          ui.textInput({
            id: 'instruction',
            label: t(lang, 'orderWhatLabel'),
            style: 2,
            required: true,
            maxLength: 500,
            placeholder: t(lang, 'orderWhatPlaceholder'),
          }),
        ],
      })
    );
  }

  if (action === 'cancel') {
    return cancelQueuedOrder(ctx, interaction);
  }
}

// ------------------------------ Nachrichten finden ------------------------------

/** Nachricht anhand der ID finden: erst im Puffer, dann Kanal für Kanal. */
async function findMessage(ctx, guild, id) {
  const buffered = ctx.store.getBuffer(guild.id).find((r) => String(r.messageId) === String(id));
  if (buffered) {
    const channel = guild.channels.cache.get(buffered.channelId) || (await guild.channels.fetch(buffered.channelId).catch(() => null));
    if (channel) {
      const message = await channel.messages.fetch(id).catch(() => null);
      if (message) return message;
    }
  }

  const channels = [...(guild.channels.cache || new Map()).values()]
    .filter((c) => c.isTextBased?.() && !c.isThread?.())
    .slice(0, MAX_CHANNEL_SEARCH);

  for (let i = 0; i < channels.length; i += 6) {
    const batch = channels.slice(i, i + 6);
    const found = await Promise.all(
      batch.map(async (channel) => {
        const message = await channel.messages?.fetch?.(id).catch(() => null);
        return message || null;
      })
    );
    const hit = found.find(Boolean);
    if (hit) return hit;
  }
  return null;
}

/** ±N Nachrichten um eine Zielnachricht holen und chronologisch sortieren. */
async function fetchContext(message) {
  const channel = message.channel;
  const fetched = await channel.messages
    .fetch({ around: message.id, limit: CONTEXT_RADIUS * 2 + 1 })
    .catch(() => null);
  const list = fetched ? [...fetched.values()] : [message];
  return list.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

// ------------------------------ Ausführung ------------------------------

function retryFailure(order, details) {
  const error = details.error || 'unknown';
  const isMissingKey = error === 'missing_api_key' || error === 'invalid_api_key';
  const suggested = Number(details.retryInMs || details.resetInMs || details.waitMs) || 0;
  const retryInMs = Math.max(
    1000,
    suggested || (isMissingKey ? KEY_RETRY_MS : nextBackoffMs(Math.max(0, order.attempts - 1)))
  );
  return {
    ok: false,
    retryable: true,
    error,
    reason: details.reason || null,
    status: details.status || null,
    message: details.message || null,
    retryInMs,
  };
}

/** Führt einen bereits vorbereiteten Auftrag aus. Fehler verwerfen ihn nicht. */
async function executeOrder(ctx, guild, order, { fromQueue = false } = {}) {
  const cfg = ctx.store.getGuild(guild.id);
  order.attempts += 1;

  const apiKey = cfg.groqKey || String(ctx.env('SECURITY_GROQ_API_KEY', '') || '').trim();
  if (!apiKey) return retryFailure(order, { error: 'missing_api_key' });

  const check = ctx.budget.smart.canSpend(order.estimate, { priority: true });
  if (!check.ok || check.waitMs) {
    return retryFailure(order, {
      error: 'rate_limited',
      reason: check.reason,
      resetInMs: check.resetInMs,
      waitMs: check.waitMs,
    });
  }

  const result = await callGroqWithFallback({
    apiKey,
    model: modelFromEnv(ctx.env, 'smart'),
    system: order.system,
    user: order.user,
    schema: verdictSchema({ allow: cfg.allow, withOrder: true }),
    schemaName: 'auftrag',
    maxTokens: 1400,
    temperature: 0.3,
    reasoningEffort: 'medium',
    fetchFn: ctx.fetchFn,
  });

  if (!result.ok) {
    return retryFailure(order, {
      error: result.error,
      status: result.status,
      message: result.message,
      resetInMs: result.retryAfterMs,
    });
  }
  ctx.budget.smart.spend(result.usage.totalTokens || order.estimate, { priority: true });

  // Ein Klick auf „Entfernen“ während des API-Aufrufs verhindert noch die Maßnahme.
  if (fromQueue && orderQueueFor(ctx, guild.id, { create: false })?.get(order.id) !== order) {
    return { ok: false, cancelled: true };
  }

  const verdicts = Array.isArray(result.json?.verstoesse) ? result.json.verstoesse : [];
  const understood = result.json?.verstanden !== false;

  if (!understood || !verdicts.length) {
    await logNotice(ctx, guild, {
      lang: cfg.lang || 'de',
      title: `${t(cfg.lang || 'de', 'modTitleOrder')} · ${t(cfg.lang || 'de', 'orderUnclear')}`,
      lines: [
        `📋 ${t(cfg.lang || 'de', 'modOrderBy')}: **${order.moderatorName}** (<@${order.moderatorId}>)`,
        `💬 Anweisung: „${ui.clip(order.instruction, 200)}“`,
        `🔍 Nachrichten: ${order.ids.map((id) => `\`${id}\``).join(', ')}`,
        result.json?.hinweis ? `🧠 ${ui.clip(result.json.hinweis, 300)}` : t(cfg.lang || 'de', 'orderUnclearBody'),
      ],
      accentColor: ACCENT.warn,
    });
    return { ok: true, understood: false };
  }

  const outcome = await applyModerations({
    ctx,
    guild,
    idMap: order.recordMap,
    decisions: verdicts,
    source: 'order',
    forcedBy: order.moderatorId,
    moderatorName: order.moderatorName,
    orderInstruction: order.instruction,
  });
  return { ok: true, understood: true, outcome };
}

/** Versucht fällige Aufträge erneut; nicht fällige bleiben unangetastet. */
async function processOrderQueue(ctx, guild, { now = Date.now() } = {}) {
  const queue = orderQueueFor(ctx, guild.id, { create: false });
  if (!queue?.size) return { ok: true, processed: 0, pending: 0 };
  let processed = 0;

  for (const order of [...queue.values()].sort((a, b) => a.createdAt - b.createdAt)) {
    if (order.running || order.retryAt > now || queue.get(order.id) !== order) continue;
    order.running = true;
    try {
      const result = await executeOrder(ctx, guild, order, { fromQueue: true });
      if (result.cancelled) continue;
      if (result.ok) {
        if (queue.get(order.id) === order) queue.delete(order.id);
        await closeQueuedOrderLog(order, ctx.store.getGuild(guild.id).lang || 'de', t(ctx.store.getGuild(guild.id).lang || 'de', 'orderQueueDone'), ACCENT.ok);
        processed += 1;
      } else {
        order.retryAt = Date.now() + result.retryInMs;
        order.lastError = result;
      }
    } finally {
      order.running = false;
    }
  }
  return { ok: true, processed, pending: queue.size };
}

async function handleOrderModal(ctx, interaction) {
  const guild = interaction.guild;
  const cfg = ctx.store.getGuild(guild.id);
  const lang = cfg.lang || 'de';
  const member = interaction.member;

  if (!isTeamMember(member, guild)) {
    return interaction.reply(ui.payload([ui.container([ui.text(t(lang, 'onlyTeam'))])], { ephemeral: true }));
  }

  const rawIds = String(interaction.fields.getTextInputValue('ids') || '');
  const instruction = String(interaction.fields.getTextInputValue('instruction') || '').trim().slice(0, 500);
  const ids = [...new Set(rawIds.split(/[^\d]+/).filter((x) => x.length >= 10))].slice(0, 3);

  await interaction.deferReply({ ephemeral: true });
  const reply = (payload) => interaction.editReply(payload);

  if (!ids.length) {
    return reply(ui.payload([ui.container([ui.text(t(lang, 'orderNoMsg'))])], { ephemeral: true }));
  }

  // 1) Nachrichten + Kontext sammeln
  const messages = [];
  for (const id of ids) {
    const message = await findMessage(ctx, guild, id);
    if (message) messages.push(message);
  }
  if (!messages.length) {
    return reply(ui.payload([ui.container([ui.text(t(lang, 'orderNoMsg'))], { accentColor: ACCENT.error })], { ephemeral: true }));
  }

  const contextList = await fetchContext(messages[0]);
  for (const extra of messages.slice(1)) {
    const list = await fetchContext(extra);
    for (const m of list) if (!contextList.some((x) => x.id === m.id)) contextList.push(m);
  }
  contextList.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const transcript = buildTranscript(contextList, { header: `Server: ${guild.name}` });
  const targetNumbers = [...transcript.idMap.entries()].filter(([, m]) => ids.includes(String(m.id))).map(([n]) => n);

  // Für die Ausführung braucht die Moderation dieselbe Datensatz-Form wie im
  // Normalbetrieb – deshalb die rohen Nachrichten hier umwandeln.
  const recordMap = new Map();
  for (const [number, raw] of transcript.idMap.entries()) {
    recordMap.set(
      number,
      toRecord(raw, {
        immune: isImmune(raw, {
          immuneRoleIds: cfg.immuneRoles || [],
          botHighestPosition: ctx.botHighestPosition(guild),
        }),
        botId: ctx.client.user?.id,
      })
    );
  }

  const system = buildSystemPrompt({
    botName: ctx.client.user?.username || 'Sentinel',
    guildName: guild.name,
    lang,
    rules: cfg.rules,
    instructions: cfg.instructions,
    allow: cfg.allow,
    register: ctx.store.registerForPrompt(guild.id, {
      userIds: messages.map((m) => m.author?.id).filter(Boolean),
      sinceMs: Date.now() - 30 * 24 * 3600 * 1000,
    }),
    mode: 'order',
  });
  const user = buildOrderPrompt({
    transcript: transcript.text,
    instruction,
    targetIds: targetNumbers,
    moderator: member.displayName || member.user?.username || 'Moderator',
  });

  const order = {
    id: randomUUID(),
    guildId: guild.id,
    ids,
    instruction,
    moderatorId: member.id,
    moderatorName: member.displayName || member.user?.username || 'Moderator',
    recordMap,
    system,
    user,
    estimate: estimateTokens(system) + estimateTokens(user) + 1200,
    createdAt: Date.now(),
    retryAt: 0,
    attempts: 0,
    running: false,
    logMessage: null,
  };

  // 2) KI entscheiden lassen; bei Limit/Fehler bleibt genau dieser Auftrag erhalten.
  const result = await executeOrder(ctx, guild, order);
  if (!result.ok) {
    order.retryAt = Date.now() + result.retryInMs;
    order.lastError = result;
    orderQueueFor(ctx, guild.id).set(order.id, order);
    const payload = queuedOrderPayload(lang, order, result, { ephemeral: true });
    order.logMessage = await sendToLog(ctx, guild, queuedOrderPayload(lang, order, result));
    return reply(payload);
  }

  if (!result.understood) {
    return reply(
      ui.payload(
        [ui.container([ui.text(`${t(lang, 'orderUnclear')}\n\n${t(lang, 'orderUnclearBody')}`)], { accentColor: ACCENT.warn })],
        { ephemeral: true }
      )
    );
  }

  // 3) Ausführen (als hätte die KI es selbst bemerkt)
  const outcome = result.outcome;
  return reply(
    ui.payload(
      [
        ui.container(
          [
            ui.text(`✅ ${t(lang, 'orderStarted')}`),
            ui.text(
              outcome.applied
                .map((a) => `· **${a.record.authorName}** → ${a.measure}${a.seconds ? ` (${a.penalty.duration})` : ''} · ${a.penalty.ruleLabel || a.decision.regel_id}`)
                .join('\n') || t(lang, 'orderUnclearBody')
            ),
          ],
          { accentColor: ACCENT.ok }
        ),
      ],
      { ephemeral: true }
    )
  );
}

module.exports = {
  orderPanel,
  handleOrderButton,
  handleOrderModal,
  findMessage,
  fetchContext,
  executeOrder,
  processOrderQueue,
  orderQueueFor,
  queuedOrderPayload,
  CONTEXT_RADIUS,
};
