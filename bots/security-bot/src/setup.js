/**
 * ============================================================================
 *  /setup – der Assistent
 *
 *  Verhalten:
 *   - Der Bot speichert den Stand auch über Neustarts hinweg.
 *   - „Weiter“ ist erst aktiv, wenn der aktuelle Schritt eingerichtet ist;
 *     Änderungen springen nicht automatisch zum nächsten Schritt.
 *   - Nach Abschluss startet /setup bei Schritt 1 mit den gespeicherten Werten.
 *
 *  Die 7 Schritte:
 *   1 Sprache · 2 Kanäle · 3 immune Rollen · 4 Regelwerk · 5 KI-Anweisungen +
 *   erlaubte Maßnahmen · 6 Log-Kanal · 7 Groq-Key
 *
 *  Bedienung: ausschließlich Buttons, Select-Menüs und Formulare – eine
 *  Nachricht, die sich selbst neu zeichnet.
 * ============================================================================
 */

const { ChannelType } = require('discord.js');
const ui = require('./ui');
const { t, langOptions, LANGS } = require('./languages');
const { MAX_RULES_CHARS, MAX_INSTRUCTIONS_CHARS, SYSTEM_RULES, parseCustomRules, clampRules, clampInstructions } = require('./rules');
const { extractTextFromMessage } = require('./transcript');
const { validateGroqKey, DEFAULT_SMART_MODEL } = require('./groq');
const { ensureLogChannel, createLogChannel, applyLogPermissions, logSetupDone, logNotice, ACCENT } = require('./logging');
const { guard } = require('./guard');

const STEPS = 7;
const STEP_EMOJI = {
  1: '🌐',
  2: '📡',
  3: '🛡️',
  4: '📜',
  5: '🤖',
  6: '🧾',
  7: '🔑',
};
const MONITORED_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];

// ------------------------------ Hilfen ------------------------------

function sentenceCaseStart(value, lang) {
  return String(value).replace(/^([^\p{L}]*)(\p{L})/u, (match, prefix, letter) => `${prefix}${letter.toLocaleUpperCase(lang)}`);
}

function stepCopy(lang, step) {
  const raw = String(t(lang, `s${step}Title`));
  const match = raw.match(/^\s*\*\*(.+?)\*\*\s*(?:[–—-]\s*)?([\s\S]*)$/);
  return match
    ? { title: match[1].trim(), description: sentenceCaseStart(match[2].trim(), lang) }
    : { title: raw.replace(/\*\*/g, '').trim(), description: '' };
}

function configuredStepSet(cfg) {
  return new Set((cfg.setup?.configuredSteps || []).map(Number));
}

/** A step is complete only when its choice is usable (or was explicitly skipped). */
function isStepComplete(ctx, guild, cfg, step) {
  const setup = cfg.setup || {};
  const configured = configuredStepSet(cfg);

  switch (step) {
    case 1:
      // Older wizard versions advanced as soon as a language was selected.
      return Boolean(setup.done || configured.has(1) || Number(setup.step) > 1 || Number(setup.furthest) > 1);
    case 2:
      // An empty list on an already-finished legacy setup means “all text channels”.
      return Boolean((cfg.channels || []).length || setup.done);
    case 3:
      // Extra immune roles are optional, but an empty choice must be deliberate.
      return Boolean((cfg.immuneRoles || []).length || configured.has(3) || setup.done);
    case 4:
      return ['manual', 'import', 'skip'].includes(cfg.rulesMode);
    case 5:
      // Warnings and the safe timeout default are already active out of the box.
      return Boolean(cfg.allow && typeof cfg.allow.timeout === 'boolean');
    case 6:
      return Boolean(cfg.logChannelId);
    case 7: {
      const envKey = String(ctx.env('SECURITY_GROQ_API_KEY', '') || '').trim();
      return Boolean(String(cfg.groqKey || '').trim() || envKey);
    }
    default:
      return false;
  }
}

function firstIncompleteStep(ctx, guild, cfg, through = STEPS) {
  for (let step = 1; step <= Math.min(STEPS, through); step += 1) {
    if (!isStepComplete(ctx, guild, cfg, step)) return step;
  }
  return null;
}

function updateConfiguredStep(ctx, guild, patch, step) {
  const current = ctx.store.getGuild(guild.id);
  const configuredSteps = configuredStepSet(current);
  configuredSteps.add(step);
  return ctx.store.updateGuild(guild.id, {
    ...patch,
    setup: { configuredSteps: [...configuredSteps].sort((a, b) => a - b) },
  });
}

function withNote(content, note) {
  return note ? `${content}\n\n> ℹ️ ${note}` : content;
}

function keyErrorDescription(lang, result) {
  const keyByError = {
    missing_api_key: 'keyErrMissing',
    invalid_api_key: 'keyErrInvalid',
    network_error: 'keyErrNetwork',
    timeout: 'keyErrTimeout',
    rate_limited: 'keyErrRateLimit',
    server_error: 'keyErrServer',
    bad_json_response: 'keyErrMalformed',
  };
  const translationKey = keyByError[result.error];
  if (translationKey) return t(lang, translationKey);
  if (result.status) return t(lang, 'keyErrApi', { status: result.status });
  return t(lang, 'keyErrOther');
}

function progressBar(step) {
  return `${'▰'.repeat(step)}${'▱'.repeat(STEPS - step)}`;
}

function navRow(lang, step, { canNext = true } = {}) {
  const buttons = [
    ui.button({
      id: 'setup:nav:back',
      label: t(lang, 'back'),
      style: ui.STYLE.secondary,
      emoji: '◀️',
      disabled: step <= 1,
    }),
    step < STEPS
      ? ui.button({ id: 'setup:nav:next', label: t(lang, 'next'), style: ui.STYLE.primary, emoji: '▶️', disabled: !canNext })
      : ui.button({ id: 'setup:nav:finish', label: t(lang, 'finish'), style: ui.STYLE.success, emoji: '✅', disabled: !canNext }),
  ];
  return ui.row(buttons);
}

// ------------------------------ Rendern ------------------------------

function renderStep(ctx, guild, cfg, step, { draft = null, note = null } = {}) {
  const safeStep = Math.min(STEPS, Math.max(1, Number(step) || 1));
  const lang = cfg.lang || 'de';
  const copy = stepCopy(lang, safeStep);
  const header = [
    `# ${t(lang, 'setupTitle')} · ${t(lang, 'stepOf', { n: safeStep })}`,
    `## ${STEP_EMOJI[safeStep]} ${copy.title}`,
    copy.description,
  ].filter(Boolean).join('\n');
  const components = [
    ui.text(header),
    ui.separator(),
    ui.text(`**Fortschritt**  ${progressBar(safeStep)}`),
    ui.separator(),
  ];

  if (safeStep === 1) {
    const current = LANGS.find((item) => item.code === lang);
    const currentLabel = current ? `${current.flag} ${current.name}` : lang;
    const status = isStepComplete(ctx, guild, cfg, 1)
      ? `**${t(lang, 'setupCurrentSelection')}**\n${currentLabel}`
      : `**${t(lang, 'setupNotConfigured')}**\n${t(lang, 's1Hint')}`;
    components.push(ui.text(withNote(status, note)));
    components.push(ui.row([
      ui.stringSelect({
        id: 'setup:sel:lang',
        placeholder: copy.title,
        options: langOptions({ selected: lang }),
        min: 1,
        max: 1,
      }),
    ]));
  }

  if (safeStep === 2) {
    const selected = (cfg.channels || []).map(String).filter((id) => id !== String(cfg.logChannelId || ''));
    const selectedText = selected.length
      ? selected.map((id) => `<#${id}>`).join(' · ')
      : cfg.setup?.done
        ? t(lang, 's2AllExisting')
        : t(lang, 's2NoneSelected');
    const status = `${t(lang, 's2Hint')}\n\n**${t(lang, 'selectedCount', { n: selected.length })}**\n${selectedText}`;
    components.push(ui.text(withNote(status, note)));
    components.push(ui.row([
      ui.channelSelect({
        id: 'setup:sel:channels',
        placeholder: copy.title,
        min: 1,
        max: 25,
        types: MONITORED_CHANNEL_TYPES,
        selected,
      }),
    ]));
  }

  if (safeStep === 3) {
    const roles = (cfg.immuneRoles || []).map(String).filter((id) => id !== String(guild.id));
    const selectedRoles = roles.filter((id) => {
      const role = guild.roles?.cache?.get(id);
      return Boolean(role && !role.managed);
    });
    const roleList = roles.length ? roles.map((id) => `<@&${id}>`).join(' · ') : t(lang, 'rolesNoneSelected');
    const status = `${t(lang, 's3Auto')}\n\n**${t(lang, 'rolesAdditional')} · ${roles.length}**\n${roleList}\n\n${t(lang, 's3Hint')}`;
    components.push(ui.text(withNote(status, note)));
    components.push(ui.row([
      ui.roleSelect({ id: 'setup:sel:roles', placeholder: copy.title, min: 0, max: 25, selected: selectedRoles }),
    ]));
    components.push(ui.row([
      ui.button({ id: 'setup:btn:none_roles', label: t(lang, 'rolesNoExtra'), style: ui.STYLE.secondary, emoji: '⏭️' }),
    ]));
  }

  if (safeStep === 4) {
    const modeKey = cfg.rulesMode === 'manual'
      ? 'rulesModeManual'
      : cfg.rulesMode === 'import'
        ? 'rulesModeImport'
        : cfg.rulesMode === 'skip'
          ? 'rulesModeSkip'
          : 'rulesModeUnset';
    const rulesCount = parseCustomRules(cfg.rules).length;
    const status = `${t(lang, 's4Base')}\n\n**${t(lang, 'rulesStatus')}** · ${t(lang, modeKey)}\n${t(lang, 'rulesCount', { n: rulesCount, chars: String(cfg.rules || '').length, max: MAX_RULES_CHARS })}\n${t(lang, 'systemRulesCount', { n: SYSTEM_RULES.length })}`;
    components.push(ui.text(withNote(status, note)));

    if (draft === 'choose') {
      components.push(ui.separator());
      components.push(ui.text(t(lang, 'rulesImportHint')));
      components.push(ui.row([
        ui.channelSelect({
          id: 'setup:sel:import',
          placeholder: t(lang, 'rulesImport'),
          min: 1,
          max: 1,
          types: [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum],
        }),
      ]));
    } else if (draft && typeof draft === 'object') {
      components.push(ui.separator());
      const truncation = draft.truncated ? `\n\n⚠️ ${t(lang, 'rulesTooLong', { max: MAX_RULES_CHARS })}` : '';
      const preview = `${t(lang, 'rulesImported')}\n-# ${draft.channelName ? `#${draft.channelName} · ` : ''}${String(draft.text || '').length} ${t(lang, 'characters')}\n\n${ui.clip(draft.text || '', 1000)}${truncation}`;
      components.push(ui.text(withNote(preview, note)));
      components.push(ui.row([
        ui.button({ id: 'setup:btn:import_use', label: t(lang, 'rulesUse'), style: ui.STYLE.success, emoji: '✅' }),
        ui.button({ id: 'setup:btn:import_edit', label: t(lang, 'rulesEdit'), style: ui.STYLE.primary, emoji: '✏️' }),
        ui.button({ id: 'setup:btn:import_other', label: t(lang, 'rulesAnother'), style: ui.STYLE.secondary, emoji: '🔁' }),
      ]));
    } else {
      components.push(ui.separator());
      components.push(ui.row([
        ui.button({ id: 'setup:btn:rules_manual', label: t(lang, 'rulesManual'), style: ui.STYLE.primary, emoji: '✍️' }),
        ui.button({ id: 'setup:btn:rules_import', label: t(lang, 'rulesImport'), style: ui.STYLE.secondary, emoji: '📥' }),
        ui.button({ id: 'setup:btn:rules_skip', label: t(lang, 'rulesSkip'), style: ui.STYLE.secondary, emoji: '⏭️' }),
      ]));
    }
  }

  if (safeStep === 5) {
    const instructions = String(cfg.instructions || '').trim();
    const instructionText = instructions
      ? `„${ui.clip(instructions, 500)}“ · ${instructions.length}/${MAX_INSTRUCTIONS_CHARS}`
      : t(lang, 's5NoInstruction');
    const status = `${t(lang, 's5Hint')}\n\n**${t(lang, 's5CurrentInstruction')}**\n${instructionText}`;
    components.push(ui.text(withNote(status, note)));
    components.push(ui.separator());
    components.push(ui.text(
      `**${t(lang, 's5AllowTitle')}**\n✅ ${t(lang, 'warnLabel')}\n${cfg.allow.timeout ? '✅' : '▫️'} ${t(lang, 'timeoutLabel')} · ${cfg.allow.kick ? '✅' : '▫️'} ${t(lang, 'kickLabel')} · ${cfg.allow.ban ? '✅' : '▫️'} ${t(lang, 'banLabel')}`
    ));
    components.push(ui.row([
      ui.button({ id: 'setup:btn:instr', label: t(lang, 's5Write'), style: ui.STYLE.primary, emoji: '✍️' }),
    ]));
    components.push(ui.row([
      ui.button({ id: 'setup:btn:allow_timeout', label: `${cfg.allow.timeout ? '✅' : '▫️'} ${t(lang, 'timeoutLabel')}`, style: ui.STYLE.secondary }),
      ui.button({ id: 'setup:btn:allow_kick', label: `${cfg.allow.kick ? '✅' : '▫️'} ${t(lang, 'kickLabel')}`, style: ui.STYLE.secondary }),
      ui.button({ id: 'setup:btn:allow_ban', label: `${cfg.allow.ban ? '✅' : '▫️'} ${t(lang, 'banLabel')}`, style: ui.STYLE.secondary }),
    ]));
  }

  if (safeStep === 6) {
    const channel = cfg.logChannelId ? guild.channels?.cache?.get(String(cfg.logChannelId)) : null;
    const channelText = channel
      ? `<#${channel.id}>${cfg.logAuto ? ` · ${t(lang, 's6Managed')}` : ''}`
      : t(lang, 's6NoneSelected');
    components.push(ui.text(withNote(`${t(lang, 's6Hint')}\n\n**${t(lang, 'setupCurrentSelection')}**\n${channelText}`, note)));
    components.push(ui.row([
      ui.channelSelect({
        id: 'setup:sel:log',
        placeholder: t(lang, 'logSelectPlaceholder'),
        min: 1,
        max: 1,
        types: [ChannelType.GuildText],
        selected: cfg.logChannelId ? [cfg.logChannelId] : [],
      }),
    ]));
    components.push(ui.row([
      ui.button({ id: 'setup:btn:log_auto', label: t(lang, 's6Auto'), style: ui.STYLE.success, emoji: '🤖' }),
      ui.button({ id: 'setup:btn:log_clear', label: t(lang, 'logClear'), style: ui.STYLE.secondary, emoji: '🗑️', disabled: !cfg.logChannelId }),
    ]));
  }

  if (safeStep === 7) {
    const storedKey = String(cfg.groqKey || '').trim();
    const envKey = String(ctx.env('SECURITY_GROQ_API_KEY', '') || '').trim();
    const keyStatus = storedKey ? t(lang, 'keySet') : envKey ? t(lang, 'keyEnvSet') : t(lang, 'keyMissing');
    const status = `${t(lang, 's7Hint')}\n\n**${t(lang, 'setupCurrentSelection')}**\n${keyStatus}\n-# ${t(lang, 's7Model', { model: DEFAULT_SMART_MODEL })}`;
    components.push(ui.text(withNote(status, note)));
    components.push(ui.row([
      ui.button({ id: 'setup:btn:key', label: t(lang, 'keyEnter'), style: ui.STYLE.primary, emoji: '🔑' }),
      ui.linkButton({ label: t(lang, 'keyHelp'), url: 'https://console.groq.com/keys', emoji: '↗️' }),
      ui.button({ id: 'setup:btn:key_clear', label: t(lang, 'keyClear'), style: ui.STYLE.secondary, emoji: '🗑️', disabled: !storedKey }),
    ]));
  }

  components.push(navRow(lang, safeStep, {
    canNext: firstIncompleteStep(ctx, guild, cfg, safeStep) === null,
  }));

  return ui.payload([ui.container(components)], { ephemeral: true });
}

function renderDone(ctx, guild, cfg) {
  const lang = cfg.lang || 'de';
  const storedKey = String(cfg.groqKey || '').trim();
  const envKey = String(ctx.env('SECURITY_GROQ_API_KEY', '') || '').trim();
  const channel = cfg.logChannelId ? guild.channels?.cache?.get(String(cfg.logChannelId)) : null;
  const summary = [
    `1 · ${LANGS.find((item) => item.code === lang)?.name || lang}`,
    `2 · ${cfg.channels.length ? `${cfg.channels.length} ${t(lang, 'channelsLabel')}` : t(lang, 's2AllExisting')}`,
    `3 · ${cfg.immuneRoles.length ? `${cfg.immuneRoles.length} ${t(lang, 'rolesLabel')}` : t(lang, 'rolesNoneSelected')}`,
    `4 · ${cfg.rulesMode === 'skip' || !cfg.rules ? t(lang, 'rulesModeSkip') : `${parseCustomRules(cfg.rules).length} ${t(lang, 'rulesLabel')}`}`,
    `5 · ${[cfg.allow.timeout ? t(lang, 'timeoutLabel') : null, cfg.allow.kick ? t(lang, 'kickLabel') : null, cfg.allow.ban ? t(lang, 'banLabel') : null, t(lang, 'warnLabel')].filter(Boolean).join(' · ')}`,
    `6 · ${channel ? `<#${channel.id}>` : t(lang, 's6NoneSelected')}`,
    `7 · ${storedKey || envKey ? t(lang, 'keySet') : t(lang, 'keyMissing')}`,
  ].join('\n');

  const components = [
    ui.text(`# ${t(lang, 'doneTitle')}\n## ${t(lang, 'setupSummary')}`),
    ui.separator(),
    ui.text(summary),
  ];
  if (!storedKey && !envKey) components.push(ui.text(t(lang, 'doneWarning')));
  components.push(ui.separator(false));
  components.push(ui.row([
    ui.button({ id: 'setup:nav:open', label: t(lang, 'setupTitle'), style: ui.STYLE.primary, emoji: '🛠️' }),
  ]));

  return ui.payload([ui.container(components)], { ephemeral: true });
}

// ------------------------------ Einstieg ------------------------------

async function handleCommand(ctx, interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  if (!(await guard(ctx, interaction))) return;

  const cfg = ctx.store.getGuild(guild.id);
  const requestedStep = cfg.setup.done ? 1 : cfg.setup.step || 1;
  const blocker = requestedStep > 1 ? firstIncompleteStep(ctx, guild, cfg, requestedStep - 1) : null;
  const step = blocker || requestedStep;
  ctx.store.updateGuild(guild.id, { setup: { step, furthest: Math.max(cfg.setup.furthest || 1, step) } });
  await ctx.store.commit();
  await interaction.reply(renderStep(ctx, guild, ctx.store.getGuild(guild.id), step));
}

// ------------------------------ Interaktion ------------------------------

async function setStep(ctx, guild, step) {
  const cfg = ctx.store.getGuild(guild.id);
  const clamped = Math.min(STEPS, Math.max(1, Math.trunc(Number(step) || 1)));
  const next = ctx.store.updateGuild(guild.id, {
    setup: { step: clamped, furthest: Math.max(cfg.setup.furthest || 1, clamped) },
  });
  await ctx.store.commit();
  return next;
}

async function handleComponent(ctx, interaction) {
  const guild = interaction.guild;
  const [, kind, action] = String(interaction.customId).split(':');
  const cfg = ctx.store.getGuild(guild.id);
  const lang = cfg.lang || 'de';
  const currentStep = cfg.setup.step || 1;

  if (kind === 'sel' && action === 'step') {
    const target = Math.min(STEPS, Math.max(1, Number(interaction.values?.[0]) || 1));
    if (target > currentStep) {
      const blocker = firstIncompleteStep(ctx, guild, cfg, target - 1);
      if (blocker) {
        const next = await setStep(ctx, guild, blocker);
        return interaction.update(renderStep(ctx, guild, next, blocker, { note: t(lang, 'setupNeedFirst') }));
      }
    }
    const next = await setStep(ctx, guild, target);
    return interaction.update(renderStep(ctx, guild, next, target));
  }

  if (kind === 'nav') {
    if (action === 'open') {
      const next = await setStep(ctx, guild, 1);
      return interaction.update(renderStep(ctx, guild, next, 1));
    }
    if (action === 'back') {
      const next = await setStep(ctx, guild, currentStep - 1);
      return interaction.update(renderStep(ctx, guild, next, next.setup.step));
    }
    if (action === 'next') {
      const blocker = firstIncompleteStep(ctx, guild, cfg, currentStep);
      if (blocker) {
        const next = await setStep(ctx, guild, blocker);
        return interaction.update(renderStep(ctx, guild, next, blocker, { note: t(lang, 'setupNeedFirst') }));
      }
      const next = await setStep(ctx, guild, currentStep + 1);
      return interaction.update(renderStep(ctx, guild, next, next.setup.step));
    }
    if (action === 'finish') {
      const blocker = firstIncompleteStep(ctx, guild, cfg, STEPS);
      if (blocker) {
        const next = await setStep(ctx, guild, blocker);
        return interaction.update(renderStep(ctx, guild, next, blocker, { note: t(lang, 'setupNeedFirst') }));
      }
      await finish(ctx, guild);
      return interaction.update(renderDone(ctx, guild, ctx.store.getGuild(guild.id)));
    }
  }

  if (kind === 'sel') {
    const values = Array.isArray(interaction.values) ? interaction.values : [];

    if (action === 'lang') {
      const chosen = String(values[0] || '');
      if (!LANGS.some((item) => item.code === chosen)) {
        return interaction.update(renderStep(ctx, guild, cfg, 1, { note: t(lang, 'setupInvalidChoice') }));
      }
      const next = updateConfiguredStep(ctx, guild, { lang: chosen }, 1);
      await ctx.store.commit();
      // Die Sprachauswahl aktualisiert die Seite, aber navigiert nie selbst weiter.
      return interaction.update(renderStep(ctx, guild, next, 1, { note: t(chosen, 'setupLanguageSaved') }));
    }

    if (action === 'channels') {
      const picked = [...new Set(values.map(String))];
      const withoutLog = picked.filter((id) => String(id) !== String(cfg.logChannelId || ''));
      const valid = withoutLog.filter((id) => {
        const channel = guild.channels?.cache?.get(id);
        return channel && MONITORED_CHANNEL_TYPES.includes(channel.type);
      });
      const next = valid.length
        ? updateConfiguredStep(ctx, guild, { channels: valid }, 2)
        : ctx.store.updateGuild(guild.id, { channels: [] });
      await ctx.store.commit();
      const note = picked.some((id) => String(id) === String(cfg.logChannelId || ''))
        ? t(lang, 's2LogExcluded')
        : valid.length
          ? t(lang, 'setupSaved')
          : t(lang, 's2NeedChannel');
      return interaction.update(renderStep(ctx, guild, next, 2, { note }));
    }

    if (action === 'roles') {
      const requestedRoles = [...new Set(values.map(String))];
      const roles = requestedRoles.filter((id) => {
        if (id === String(guild.id)) return false;
        const role = guild.roles?.cache?.get(id);
        return Boolean(role && !role.managed);
      });
      const next = updateConfiguredStep(ctx, guild, { immuneRoles: roles }, 3);
      await ctx.store.commit();
      const note = requestedRoles.length !== roles.length ? t(lang, 'rolesExcluded') : t(lang, 'setupSaved');
      return interaction.update(renderStep(ctx, guild, next, 3, { note }));
    }

    if (action === 'log') {
      const channelId = String(values[0] || '');
      const channel = guild.channels?.cache?.get(channelId)
        || (await guild.channels?.fetch?.(channelId).catch(() => null));
      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.update(renderStep(ctx, guild, cfg, 6, { note: t(lang, 's6NeedChannel') }));
      }
      const channels = (cfg.channels || []).filter((id) => String(id) !== channelId);
      const next = updateConfiguredStep(ctx, guild, { logChannelId: channelId, logAuto: false, channels }, 6);
      await applyLogPermissions(ctx, guild, channel, next);
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, ctx.store.getGuild(guild.id), 6, { note: t(lang, 'setupSaved') }));
    }

    if (action === 'import') {
      const channelId = String(values[0] || '');
      const channel = guild.channels?.cache?.get(channelId)
        || (await guild.channels?.fetch?.(channelId).catch(() => null));
      if (!channel) {
        return interaction.update(renderStep(ctx, guild, cfg, 4, { draft: 'choose', note: t(lang, 'rulesNotFound') }));
      }
      const messages = await channel.messages?.fetch?.({ limit: 10 }).catch(() => null);
      const recentMessages = messages?.values ? [...messages.values()] : Array.isArray(messages) ? messages : [];
      if (!recentMessages.length || recentMessages.length > 1) {
        return interaction.update(renderStep(ctx, guild, cfg, 4, { draft: 'choose', note: t(lang, 'rulesNotFound') }));
      }
      const message = recentMessages[0];
      const text = extractTextFromMessage(message);
      if (!text) {
        return interaction.update(renderStep(ctx, guild, cfg, 4, { draft: 'choose', note: t(lang, 'rulesNotFound') }));
      }

      const clamped = clampRules(text);
      const pending = {
        text: clamped.text,
        truncated: clamped.truncated,
        channelId,
        channelName: channel.name,
        messageId: message.id,
      };
      ctx.setupDraft.set(guild.id, pending);
      return interaction.update(renderStep(ctx, guild, cfg, 4, { draft: pending }));
    }
  }

  if (kind === 'btn') {
    if (action === 'none_roles') {
      const next = updateConfiguredStep(ctx, guild, { immuneRoles: [] }, 3);
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 3, { note: t(lang, 'setupSaved') }));
    }

    if (action === 'rules_manual') {
      return interaction.showModal(
        ui.modal({
          id: 'setup:modal:rules',
          title: t(lang, 'rulesManual'),
          components: [
            ui.textInput({
              id: 'rules',
              label: t(lang, 'rulesManual'),
              style: 2,
              required: false,
              maxLength: MAX_RULES_CHARS,
              value: cfg.rules || '',
              placeholder: t(lang, 'rulesExample'),
            }),
          ],
        })
      );
    }
    if (action === 'rules_skip') {
      ctx.setupDraft.delete(guild.id);
      const next = updateConfiguredStep(ctx, guild, { rulesMode: 'skip', rules: '' }, 4);
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 4, { note: t(lang, 'rulesSkipped') }));
    }
    if (action === 'rules_import') {
      ctx.setupDraft.delete(guild.id);
      return interaction.update(renderStep(ctx, guild, cfg, 4, { draft: 'choose' }));
    }
    if (action === 'import_use') {
      const pending = ctx.setupDraft.get(guild.id);
      if (!pending || typeof pending.text !== 'string') {
        return interaction.update(renderStep(ctx, guild, cfg, 4, { draft: 'choose', note: t(lang, 'rulesNotFound') }));
      }
      ctx.setupDraft.delete(guild.id);
      const next = updateConfiguredStep(ctx, guild, { rulesMode: 'import', rules: pending.text }, 4);
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 4, {
        note: pending.truncated ? t(lang, 'rulesTooLong', { max: MAX_RULES_CHARS }) : t(lang, 'rulesSaved'),
      }));
    }
    if (action === 'import_edit') {
      const pending = ctx.setupDraft.get(guild.id);
      return interaction.showModal(
        ui.modal({
          id: 'setup:modal:rules',
          title: t(lang, 'rulesEdit'),
          components: [
            ui.textInput({ id: 'rules', label: t(lang, 'rulesManual'), style: 2, required: false, maxLength: MAX_RULES_CHARS, value: pending?.text || cfg.rules || '' }),
          ],
        })
      );
    }
    if (action === 'import_other') {
      ctx.setupDraft.delete(guild.id);
      return interaction.update(renderStep(ctx, guild, cfg, 4, { draft: 'choose' }));
    }

    if (action === 'instr') {
      return interaction.showModal(
        ui.modal({
          id: 'setup:modal:instr',
          title: t(lang, 's5Write'),
          components: [
            ui.textInput({
              id: 'instructions',
              label: t(lang, 's5Write'),
              style: 2,
              required: false,
              maxLength: MAX_INSTRUCTIONS_CHARS,
              value: cfg.instructions || '',
              placeholder: t(lang, 's5Example'),
            }),
          ],
        })
      );
    }
    if (['allow_timeout', 'allow_kick', 'allow_ban'].includes(action)) {
      const field = action.replace('allow_', '');
      const next = updateConfiguredStep(ctx, guild, { allow: { ...cfg.allow, [field]: !cfg.allow[field] } }, 5);
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 5));
    }

    if (action === 'log_auto') {
      const created = await createLogChannel(ctx, guild, cfg);
      if (!created.ok) {
        return interaction.update(renderStep(ctx, guild, cfg, 6, { note: t(lang, 'logNeedPermission') }));
      }
      const channels = (cfg.channels || []).filter((id) => String(id) !== String(created.channel.id));
      const next = updateConfiguredStep(ctx, guild, {
        logChannelId: created.channel.id,
        logAuto: true,
        channels,
      }, 6);
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 6, { note: t(lang, 's6ChannelCreated', { channel: `<#${created.channel.id}>` }) }));
    }
    if (action === 'log_clear') {
      const next = ctx.store.updateGuild(guild.id, { logChannelId: null, logAuto: false });
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 6, { note: t(lang, 's6NeedChannel') }));
    }

    if (action === 'key') {
      return interaction.showModal(
        ui.modal({
          id: 'setup:modal:key',
          title: t(lang, 'keyEnter'),
          components: [ui.textInput({ id: 'key', label: t(lang, 'keyInputLabel'), style: 1, required: true, maxLength: 200, placeholder: 'gsk_…' })],
        })
      );
    }
    if (action === 'key_clear') {
      const next = ctx.store.updateGuild(guild.id, { groqKey: null });
      await ctx.store.commit();
      const note = String(ctx.env('SECURITY_GROQ_API_KEY', '') || '').trim() ? t(lang, 'keyEnvStillSet') : t(lang, 'keyCleared');
      return interaction.update(renderStep(ctx, guild, next, 7, { note }));
    }
  }

  return interaction.update(renderStep(ctx, guild, ctx.store.getGuild(guild.id), currentStep));
}

// ------------------------------ Modals ------------------------------

async function handleModal(ctx, interaction) {
  const guild = interaction.guild;
  const [, , action] = String(interaction.customId).split(':');
  const cfg = ctx.store.getGuild(guild.id);
  const lang = cfg.lang || 'de';

  if (action === 'rules') {
    const raw = interaction.fields.getTextInputValue('rules') || '';
    const clamped = clampRules(raw);
    ctx.setupDraft.delete(guild.id);
    const next = updateConfiguredStep(ctx, guild, {
      rules: clamped.text,
      rulesMode: clamped.text.trim() ? 'manual' : 'skip',
    }, 4);
    await ctx.store.commit();
    return interaction.update(
      renderStep(ctx, guild, next, 4, {
        note: clamped.truncated ? t(lang, 'rulesTooLong', { max: MAX_RULES_CHARS }) : t(lang, 'rulesSaved'),
      })
    );
  }

  if (action === 'instr') {
    const clamped = clampInstructions(interaction.fields.getTextInputValue('instructions') || '');
    const next = updateConfiguredStep(ctx, guild, { instructions: clamped.text }, 5);
    await ctx.store.commit();
    return interaction.update(
      renderStep(ctx, guild, next, 5, { note: clamped.truncated ? t(lang, 'instructionsTooLong', { max: MAX_INSTRUCTIONS_CHARS }) : t(lang, 'setupSaved') })
    );
  }

  if (action === 'key') {
    const key = String(interaction.fields.getTextInputValue('key') || '').trim();
    await interaction.deferUpdate().catch(() => {});
    await interaction.editReply(renderStep(ctx, guild, ctx.store.getGuild(guild.id), 7, { note: t(lang, 'keyChecking') })).catch(() => {});
    const test = await validateGroqKey({ apiKey: key, fetchFn: ctx.fetchFn });
    if (!test.ok) {
      const next = ctx.store.getGuild(guild.id);
      await ctx.store.commit();
      return interaction.editReply(
        renderStep(ctx, guild, next, 7, { note: t(lang, 'keyBad', { err: keyErrorDescription(lang, test) }) })
      );
    }
    const next = updateConfiguredStep(ctx, guild, { groqKey: key }, 7);
    await ctx.store.commit();
    return interaction.editReply(
      renderStep(ctx, guild, next, 7, { note: t(lang, 'keyOk', { ms: test.ms }) })
    );
  }

  return interaction.deferUpdate().catch(() => {});
}

// ------------------------------ Abschluss ------------------------------

async function finish(ctx, guild) {
  const store = ctx.store;
  let cfg = store.getGuild(guild.id);

  store.updateGuild(guild.id, {
    setup: {
      step: 1,
      furthest: STEPS,
      configuredSteps: Array.from({ length: STEPS }, (_, index) => index + 1),
      done: true,
      completedAt: Date.now(),
    },
  });
  cfg = store.getGuild(guild.id);

  const log = await ensureLogChannel(ctx, guild, { createIfMissing: true });
  if (!log.ok && cfg.logChannelId == null) {
    ctx.logger?.warn?.('[security-bot] Kein Log-Kanal möglich – bitte Rechte prüfen.');
  }
  if (log.ok) {
    await logSetupDone(ctx, guild, { lang: cfg.lang || 'de' });
    const key = cfg.groqKey || String(ctx.env('SECURITY_GROQ_API_KEY', '') || '').trim();
    if (!key) {
      await logNotice(ctx, guild, { lang: cfg.lang || 'de', lines: [t(cfg.lang || 'de', 'doneWarning')], accentColor: ACCENT.warn });
    } else {
      await logNotice(ctx, guild, {
        lang: cfg.lang || 'de',
        lines: [
          `🛡️ **Schutz aktiv**`,
          `· ${cfg.channels.length ? `${cfg.channels.length} Kanal/Kanäle` : 'alle Kanäle'}`,
          `· Maßnahmen: ${[cfg.allow.timeout ? t(cfg.lang || 'de', 'timeoutLabel') : null, cfg.allow.kick ? t(cfg.lang || 'de', 'kickLabel') : null, cfg.allow.ban ? t(cfg.lang || 'de', 'banLabel') : null, t(cfg.lang || 'de', 'warnLabel')].filter(Boolean).join(', ')}`,
          `· ${cfg.instructions ? 'Eigene KI-Anweisungen aktiv' : 'Standard-Verhalten'}`,
        ],
        accentColor: ACCENT.ok,
      });
    }
  }

  await store.commit();
  ctx.logger?.info?.(`[security-bot] Setup für ${guild.name} abgeschlossen.`);
}

module.exports = {
  STEPS,
  handleCommand,
  handleComponent,
  handleModal,
  renderStep,
  renderDone,
  finish,
  setStep,
};
