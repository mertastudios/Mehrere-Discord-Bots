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
 * ============================================================================
 */

const ui = require('./ui');
const { t } = require('./languages');
const { buildTranscript, estimateTokens, isImmune } = require('./transcript');
const { toRecord } = require('./collector');
const { buildSystemPrompt, buildOrderPrompt, verdictSchema } = require('./prompts');
const { callGroqWithFallback, modelFromEnv } = require('./groq');
const { applyModerations } = require('./moderator');
const { logNotice, logError, ACCENT } = require('./logging');
const { isTeamMember } = require('./guard');

const CONTEXT_RADIUS = 15;
const MAX_CHANNEL_SEARCH = 60;

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
    return reply(ui.payload([ui.container([ui.text(t(lang, 'orderNoMsg'))])]));
  }

  // 1) Nachrichten + Kontext sammeln
  const messages = [];
  for (const id of ids) {
    const message = await findMessage(ctx, guild, id);
    if (message) messages.push(message);
  }
  if (!messages.length) {
    return reply(ui.payload([ui.container([ui.text(t(lang, 'orderNoMsg'))], { accentColor: ACCENT.error })]));
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

  const apiKey = cfg.groqKey || String(ctx.env('SECURITY_GROQ_API_KEY', '') || '').trim();
  if (!apiKey) {
    await logError(ctx, guild, { lang, detail: '🔑 Kein Groq-Key hinterlegt – Auftrag kann nicht ausgeführt werden (`/setup` Schritt 7).' });
    return reply(ui.payload([ui.container([ui.text(t(lang, 'keyMissing'))], { accentColor: ACCENT.error })]));
  }

  // 2) KI entscheiden lassen
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

  const estimate = estimateTokens(system) + estimateTokens(user) + 1200;
  const check = ctx.budget.smart.canSpend(estimate, { priority: true });
  if (!check.ok) {
    await logError(ctx, guild, { lang, detail: `Auftrag pausiert – Groq-Limit (${check.reason}).` });
    return reply(ui.payload([ui.container([ui.text(t(lang, 'rateLimitTitle'))])]));
  }

  const result = await callGroqWithFallback({
    apiKey,
    model: modelFromEnv(ctx.env, 'smart'),
    system,
    user,
    schema: verdictSchema({ allow: cfg.allow, withOrder: true }),
    schemaName: 'auftrag',
    maxTokens: 1400,
    temperature: 0.3,
    reasoningEffort: 'medium',
    fetchFn: ctx.fetchFn,
  });

  if (!result.ok) {
    await logError(ctx, guild, {
      lang,
      detail: `Auftrag fehlgeschlagen (${result.error}${result.status ? ` ${result.status}` : ''}).`,
    });
    return reply(ui.payload([ui.container([ui.text(t(lang, 'errorTitle'))], { accentColor: ACCENT.error })]));
  }
  ctx.budget.smart.spend(result.usage.totalTokens || estimate);

  const verdicts = Array.isArray(result.json?.verstoesse) ? result.json.verstoesse : [];
  const understood = result.json?.verstanden !== false;

  // 3) Keine klare Anweisung → Log, nichts tun
  if (!understood || !verdicts.length) {
    await logNotice(ctx, guild, {
      lang,
      title: `${t(lang, 'modTitleOrder')} · ${t(lang, 'orderUnclear')}`,
      lines: [
        `📋 ${t(lang, 'modOrderBy')}: **${member.displayName || member.user?.username}** (<@${member.id}>)`,
        `💬 Anweisung: „${ui.clip(instruction, 200)}“`,
        `🔍 Nachrichten: ${ids.map((id) => `\`${id}\``).join(', ')}`,
        result.json?.hinweis ? `🧠 ${ui.clip(result.json.hinweis, 300)}` : t(lang, 'orderUnclearBody'),
      ],
      accentColor: ACCENT.warn,
    });
    return reply(ui.payload([ui.container([ui.text(`${t(lang, 'orderUnclear')}\n\n${t(lang, 'orderUnclearBody')}`)], { accentColor: ACCENT.warn })]));
  }

  // 4) Ausführen (als hätte die KI es selbst bemerkt)
  const outcome = await applyModerations({
    ctx,
    guild,
    idMap: recordMap,
    decisions: verdicts,
    source: 'order',
    forcedBy: member.id,
    moderatorName: member.displayName || member.user?.username || 'Moderator',
    orderInstruction: instruction,
  });

  return reply(
    ui.payload([
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
    ])
  );
}

module.exports = { orderPanel, handleOrderButton, handleOrderModal, findMessage, fetchContext, CONTEXT_RADIUS };
