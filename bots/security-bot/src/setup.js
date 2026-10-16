/**
 * ============================================================================
 *  /setup – der Assistent
 *
 *  Verhalten:
 *   - Ist noch nicht alles eingerichtet, merkt sich der Bot den Stand und macht
 *     beim nächsten Aufruf genau dort weiter (auch nach Neustarts).
 *   - Zurück geht immer, vor geht es bis zum weitesten erreichten Schritt.
 *   - Ist alles fertig, startet /setup wieder bei Schritt 1 – alle Werte sind
 *     vorbelegt und man kann frei vor- und zurückspringen.
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

const STEP_KEY_LABELS = {
  1: { de: 'Sprache', en: 'Language' },
  2: { de: 'Kanäle', en: 'Channels' },
  3: { de: 'Immun', en: 'Immune' },
  4: { de: 'Regelwerk', en: 'Rules' },
  5: { de: 'KI-Anweisung', en: 'AI instructions' },
  6: { de: 'Log-Kanal', en: 'Log channel' },
  7: { de: 'Groq-Key', en: 'Groq key' },
};

// ------------------------------ Hilfen ------------------------------

function stepTitle(lang, step) {
  return `${t(lang, 'setupTitle')} · ${t(lang, 'stepOf', { n: step })} · **${t(lang, `s${step}Title`).replace(/\*\*/g, '')}**`;
}

function shortList(items, max = 12) {
  if (!items.length) return '—';
  const shown = items.slice(0, max).map((x) => `#${x}`).join(', ');
  return items.length > max ? `${shown} …` : shown;
}

function autoImmuneRoles(guild) {
  const botHighest = guild.members?.me?.roles?.highest?.position ?? 0;
  return [...(guild.roles?.cache || new Map()).values()]
    .filter((role) => role.id !== guild.id && (role.position >= botHighest || role.permissions?.has?.('Administrator')))
    .map((role) => role.name);
}

function navRow(lang, step, { canNext = true } = {}) {
  const buttons = [
    ui.button({ id: 'setup:nav:back', label: t(lang, 'back'), style: ui.STYLE.secondary, emoji: '◀️', disabled: step <= 1 }),
  ];
  if (step < STEPS) {
    buttons.push(ui.button({ id: 'setup:nav:next', label: t(lang, 'next'), style: ui.STYLE.primary, emoji: '▶️', disabled: !canNext }));
  } else {
    buttons.push(ui.button({ id: 'setup:nav:finish', label: t(lang, 'finish'), style: ui.STYLE.success, emoji: '✅' }));
  }
  return ui.row(buttons);
}

function stepSelectRow(lang, step) {
  return ui.row([
    ui.stringSelect({
      id: 'setup:sel:step',
      placeholder: t(lang, 'stepOf', { n: step }),
      options: Object.keys(STEP_KEY_LABELS).map((n) => {
        const label = STEP_KEY_LABELS[n][lang] || STEP_KEY_LABELS[n].de;
        return { label: `${n} · ${label}`, value: String(n), default: Number(n) === Number(step) };
      }),
      min: 1,
      max: 1,
    }),
  ]);
}

// ------------------------------ Rendern ------------------------------

function renderStep(ctx, guild, cfg, step, { draft = null, note = null } = {}) {
  const lang = cfg.lang || 'de';
  const lines = [stepTitle(lang, step)];
  const rows = [];

  if (step === 1) {
    const current = LANGS.find((l) => l.code === lang);
    lines.push(ui.separator(false), `Aktuell: **${current?.flag || ''} ${current?.name || lang}**`);
    rows.push(ui.row([ui.stringSelect({ id: 'setup:sel:lang', placeholder: t(lang, 's1Title').replace(/\*\*/g, ''), options: langOptions({ selected: lang }), min: 1, max: 1 })]));
  }

  if (step === 2) {
    const channels = (cfg.channels || []).map((id) => guild.channels?.cache?.get(id)?.name || id);
    const mention = (cfg.channels || []).map((id) => `<#${id}>`);
    lines.push(ui.separator(false), t(lang, 's2Hint'), `Ausgewählt: **${t(lang, 'selectedCount', { n: cfg.channels.length })}**`, shortList(mention.length ? mention : channels, 10));
    rows.push(
      ui.row([
        ui.channelSelect({
          id: 'setup:sel:channels',
          placeholder: t(lang, 's2Title').replace(/\*\*/g, ''),
          min: 0,
          max: 25,
          types: [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum],
        }),
      ]),
      ui.row([
        ui.button({ id: 'setup:btn:all_channels', label: t(lang, 'all'), style: ui.STYLE.secondary, emoji: '✅' }),
        ui.button({ id: 'setup:btn:none_channels', label: t(lang, 'none'), style: ui.STYLE.secondary, emoji: '🧹' }),
      ])
    );
  }

  if (step === 3) {
    const roles = (cfg.immuneRoles || []).map((id) => guild.roles?.cache?.get(id)?.name || id);
    lines.push(ui.separator(false), t(lang, 's3Auto'), `Ausgewählt: **${t(lang, 'selectedCount', { n: cfg.immuneRoles.length })}**`, roles.length ? roles.map((r) => `@${r}`).join(', ') : '—');
    rows.push(
      ui.row([ui.roleSelect({ id: 'setup:sel:roles', placeholder: t(lang, 's3Title').replace(/\*\*/g, ''), min: 0, max: 25 })]),
      ui.row([
        ui.button({ id: 'setup:btn:all_roles', label: t(lang, 'all'), style: ui.STYLE.secondary, emoji: '✅' }),
        ui.button({ id: 'setup:btn:none_roles', label: t(lang, 'none'), style: ui.STYLE.secondary, emoji: '🧹' }),
      ])
    );
  }

  if (step === 4) {
    const modeText = cfg.rulesMode === 'manual' ? 'manuell' : cfg.rulesMode === 'skip' ? `⏭ übersprungen` : cfg.rulesMode === 'import' ? 'importiert' : '—';
    const count = parseCustomRules(cfg.rules).length;
    lines.push(
      ui.separator(false),
      t(lang, 's4Base'),
      `Status: **${modeText}** · ${count} eigene Regel(n) · ${String(cfg.rules || '').length}/${MAX_RULES_CHARS} Zeichen`,
      `Systemregeln (immer aktiv): ${SYSTEM_RULES.length}`
    );
    if (draft) {
      lines.push(ui.separator(), `📥 ${t(lang, 'rulesImported')}`, `-# ${draft.channelName ? `#${draft.channelName} · ` : ''}${String(draft.text).length} Zeichen${draft.truncated ? ` · ${t(lang, 'rulesTooLong', { max: MAX_RULES_CHARS })}` : ''}`, '', ui.clip(draft.text, 1200));
      rows.push(
        ui.row([
          ui.button({ id: 'setup:btn:import_use', label: t(lang, 'rulesUse'), style: ui.STYLE.success, emoji: '✅' }),
          ui.button({ id: 'setup:btn:import_edit', label: t(lang, 'rulesEdit'), style: ui.STYLE.primary, emoji: '✏️' }),
          ui.button({ id: 'setup:btn:import_other', label: t(lang, 'rulesAnother'), style: ui.STYLE.secondary, emoji: '🔁' }),
        ])
      );
    } else if (draft === 'choose') {
      lines.push(ui.separator(), t(lang, 'rulesImportHint'));
      rows.push(ui.row([ui.channelSelect({ id: 'setup:sel:import', placeholder: t(lang, 'rulesImport'), min: 1, max: 1, types: [ChannelType.GuildText, ChannelType.GuildAnnouncement] })]));
    } else {
      rows.push(
        ui.row([
          ui.button({ id: 'setup:btn:rules_manual', label: t(lang, 'rulesManual'), style: ui.STYLE.primary, emoji: '✍️' }),
          ui.button({ id: 'setup:btn:rules_skip', label: t(lang, 'rulesSkip'), style: ui.STYLE.secondary, emoji: '⏭' }),
          ui.button({ id: 'setup:btn:rules_import', label: t(lang, 'rulesImport'), style: ui.STYLE.secondary, emoji: '📥' }),
        ])
      );
    }
  }

  if (step === 5) {
    const instructions = String(cfg.instructions || '');
    lines.push(
      ui.separator(false),
      t(lang, 's5Hint'),
      `Anweisung: ${instructions ? `„${ui.clip(instructions, 300)}“ (${instructions.length}/${MAX_INSTRUCTIONS_CHARS})` : '— (keine)'}`,
      ui.separator(),
      t(lang, 's5AllowTitle'),
      `✅ ${t(lang, 'warnLabel')} · ${cfg.allow.timeout ? '✅' : '⬜'} ${t(lang, 'timeoutLabel')} · ${cfg.allow.kick ? '✅' : '⬜'} ${t(lang, 'kickLabel')} · ${cfg.allow.ban ? '✅' : '⬜'} ${t(lang, 'banLabel')}`
    );
    rows.push(
      ui.row([ui.button({ id: 'setup:btn:instr', label: t(lang, 's5Write'), style: ui.STYLE.primary, emoji: '✍️' })]),
      ui.row([
        ui.button({ id: 'setup:btn:allow_timeout', label: `${cfg.allow.timeout ? '✅' : '⬜'} ${t(lang, 'timeoutLabel')}`, style: ui.STYLE.secondary }),
        ui.button({ id: 'setup:btn:allow_kick', label: `${cfg.allow.kick ? '✅' : '⬜'} ${t(lang, 'kickLabel')}`, style: ui.STYLE.secondary }),
        ui.button({ id: 'setup:btn:allow_ban', label: `${cfg.allow.ban ? '✅' : '⬜'} ${t(lang, 'banLabel')}`, style: ui.STYLE.secondary }),
      ])
    );
  }

  if (step === 6) {
    const channel = cfg.logChannelId ? guild.channels?.cache?.get(cfg.logChannelId) : null;
    lines.push(
      ui.separator(false),
      `Aktuell: ${channel ? `<#${channel.id}>${cfg.logAuto ? ' _(von mir verwaltet)_' : ''}` : '— (keiner)'}`,
      'Der Kanal ist automatisch nur für den Owner, mich, das Team und Rollen über mir sichtbar.',
      'Wird er gelöscht, lege ich ihn neu an.'
    );
    rows.push(
      ui.row([ui.channelSelect({ id: 'setup:sel:log', placeholder: `#${'log-channel'}`, min: 1, max: 1, types: [ChannelType.GuildText] })]),
      ui.row([
        ui.button({ id: 'setup:btn:log_auto', label: t(lang, 's6Auto'), style: ui.STYLE.success, emoji: '🤖' }),
        ui.button({ id: 'setup:btn:log_clear', label: t(lang, 'none'), style: ui.STYLE.secondary, emoji: '🧹' }),
      ])
    );
  }

  if (step === 7) {
    const key = cfg.groqKey || String(ctx.env('SECURITY_GROQ_API_KEY', '') || '').trim();
    lines.push(
      ui.separator(false),
      `Aktuell: ${key ? t(lang, 'keySet') : t(lang, 'keyMissing')}`,
      `-# Modell: \`${DEFAULT_SMART_MODEL}\` · Free-Plan von console.groq.com/keys`,
      cfg.setup.done ? `\n${t(lang, 'doneTitle')}` : '',
      cfg.setup.done && !key ? t(lang, 'doneWarning') : ''
    );
    rows.push(
      ui.row([
        ui.button({ id: 'setup:btn:key', label: t(lang, 'keyEnter'), style: ui.STYLE.primary, emoji: '🔑' }),
        ui.linkButton({ label: t(lang, 'keyHelp'), url: 'https://console.groq.com/keys', emoji: '🎁' }),
        ui.button({ id: 'setup:btn:key_clear', label: t(lang, 'keyClear'), style: ui.STYLE.secondary, emoji: '🗑' }),
      ])
    );
  }

  if (note) lines.push(ui.separator(), note);
  lines.push(ui.separator(false));
  rows.push(navRow(lang, step));

  const body = [ui.text(lines.filter(Boolean).join('\n')), ...rows];
  return ui.payload([ui.container(body, { accentColor: ACCENT.mod })], { ephemeral: true });
}

function renderDone(ctx, guild, cfg) {
  const lang = cfg.lang || 'de';
  const key = cfg.groqKey || String(ctx.env('SECURITY_GROQ_API_KEY', '') || '').trim();
  const channel = cfg.logChannelId ? guild.channels?.cache?.get(cfg.logChannelId) : null;
  const summary = [
    `1 · ${LANGS.find((l) => l.code === lang)?.name || lang}`,
    `2 · ${cfg.channels.length ? `${cfg.channels.length} Kanal/Kanäle` : 'alle Kanäle'}`,
    `3 · ${cfg.immuneRoles.length ? `${cfg.immuneRoles.length} Rolle(n)` : 'nur automatisch (Owner/Admins/über mir)'}`,
    `4 · ${cfg.rulesMode === 'skip' || !cfg.rules ? 'nur Systemregeln' : `${parseCustomRules(cfg.rules).length} eigene Regeln`}`,
    `5 · ${[cfg.allow.timeout ? 'Timeouts' : null, cfg.allow.kick ? 'Kicks' : null, cfg.allow.ban ? 'Bans' : null, 'Warnungen'].filter(Boolean).join(', ')}`,
    `6 · ${channel ? `<#${channel.id}>` : 'noch keiner'}`,
    `7 · ${key ? 'Key aktiv ✅' : 'kein Key ⚠️'}`,
  ].join('\n');

  return ui.payload(
    [
      ui.container(
        [
          ui.text(t(lang, 'doneTitle')),
          ui.separator(),
          ui.text(summary),
          !key ? ui.text(t(lang, 'doneWarning')) : null,
          ui.separator(false),
          ui.row([ui.button({ id: 'setup:nav:open', label: t(lang, 'setupTitle'), style: ui.STYLE.primary, emoji: '🛠️' })]),
        ].filter(Boolean),
        { accentColor: ACCENT.ok }
      ),
    ],
    { ephemeral: true }
  );
}

// ------------------------------ Einstieg ------------------------------

async function handleCommand(ctx, interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  if (!(await guard(ctx, interaction))) return;

  const cfg = ctx.store.getGuild(guild.id);
  const step = cfg.setup.done ? 1 : cfg.setup.step || 1;
  ctx.store.updateGuild(guild.id, { setup: { step, furthest: Math.max(cfg.setup.furthest || 1, step) } });
  await ctx.store.commit();

  const payload = cfg.setup.done
    ? renderStep(ctx, guild, ctx.store.getGuild(guild.id), step)
    : renderStep(ctx, guild, ctx.store.getGuild(guild.id), step);
  await interaction.reply(payload);
}

// ------------------------------ Interaktion ------------------------------

async function setStep(ctx, guild, step) {
  const cfg = ctx.store.getGuild(guild.id);
  const clamped = Math.min(STEPS, Math.max(1, step));
  return ctx.store.updateGuild(guild.id, {
    setup: { step: clamped, furthest: Math.max(cfg.setup.furthest || 1, clamped) },
  });
}

async function handleComponent(ctx, interaction) {
  const guild = interaction.guild;
  const [, kind, action] = String(interaction.customId).split(':');
  const cfg = ctx.store.getGuild(guild.id);
  const lang = cfg.lang || 'de';
  let note = null;
  let draft = null;

  // Schritt-Auswahl per Menü (freies Springen)
  if (kind === 'sel' && action === 'step') {
    await setStep(ctx, guild, Number(interaction.values?.[0]) || 1);
    return interaction.update(renderStep(ctx, guild, ctx.store.getGuild(guild.id), Number(interaction.values?.[0]) || 1));
  }

  if (kind === 'nav') {
    if (action === 'open') {
      await setStep(ctx, guild, 1);
      return interaction.update(renderStep(ctx, guild, ctx.store.getGuild(guild.id), 1));
    }
    if (action === 'back') {
      const next = await setStep(ctx, guild, (cfg.setup.step || 1) - 1);
      return interaction.update(renderStep(ctx, guild, next, next.setup.step));
    }
    if (action === 'next') {
      const next = await setStep(ctx, guild, (cfg.setup.step || 1) + 1);
      return interaction.update(renderStep(ctx, guild, next, next.setup.step));
    }
    if (action === 'finish') {
      await finish(ctx, guild);
      return interaction.update(renderDone(ctx, guild, ctx.store.getGuild(guild.id)));
    }
  }

  if (kind === 'sel') {
    const values = interaction.values || [];

    if (action === 'lang') {
      const chosen = values[0];
      ctx.store.updateGuild(guild.id, { lang: chosen });
      await setStep(ctx, guild, 2);
      const next = ctx.store.getGuild(guild.id);
      return interaction.update(renderStep(ctx, guild, next, 2));
    }

    if (action === 'channels') {
      const picked = values.map(String);
      const withoutLog = cfg.logChannelId ? picked.filter((id) => id !== String(cfg.logChannelId)) : picked;
      const next = ctx.store.updateGuild(guild.id, { channels: withoutLog });
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 2, { note: cfg.logChannelId && withoutLog.length !== picked.length ? 'Mein Log-Kanal kann nicht überwacht werden – ich habe ihn rausgenommen.' : null }));
    }

    if (action === 'roles') {
      const next = ctx.store.updateGuild(guild.id, { immuneRoles: values.map(String) });
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 3));
    }

    if (action === 'log') {
      const channelId = String(values[0]);
      const channels = (cfg.channels || []).filter((id) => String(id) !== channelId);
      const next = ctx.store.updateGuild(guild.id, { logChannelId: channelId, logAuto: false, channels });
      const channel = guild.channels.cache.get(channelId);
      if (channel) await applyLogPermissions(ctx, guild, channel, next);
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, ctx.store.getGuild(guild.id), 6));
    }

    if (action === 'import') {
      const channelId = String(values[0]);
      const channel = guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
      if (!channel) {
        return interaction.update(renderStep(ctx, guild, cfg, 4, { note: t(lang, 'rulesNotFound') }));
      }
      const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
      if (!messages || messages.size > 1) {
        return interaction.update(renderStep(ctx, guild, cfg, 4, { note: t(lang, 'rulesNotFound') }));
      }
      const message = [...messages.values()][0];
      const text = extractTextFromMessage(message);
      if (!text) return interaction.update(renderStep(ctx, guild, cfg, 4, { note: t(lang, 'rulesNotFound') }));

      const clamped = clampRules(text);
      ctx.setupDraft.set(guild.id, { text: clamped.text, truncated: clamped.truncated, channelId, channelName: channel.name, messageId: message.id });
      return interaction.update(renderStep(ctx, guild, cfg, 4, { draft: ctx.setupDraft.get(guild.id) }));
    }
  }

  if (kind === 'btn') {
    if (action === 'all_channels') {
      const all = [...guild.channels.cache.values()]
        .filter((c) => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(c.type))
        .filter((c) => String(c.id) !== String(cfg.logChannelId || ''))
        .map((c) => c.id)
        .slice(0, 100);
      const next = ctx.store.updateGuild(guild.id, { channels: all });
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 2));
    }
    if (action === 'none_channels') {
      const next = ctx.store.updateGuild(guild.id, { channels: [] });
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 2));
    }
    if (action === 'all_roles') {
      const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed).map((r) => r.id).slice(0, 100);
      const next = ctx.store.updateGuild(guild.id, { immuneRoles: roles });
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 3));
    }
    if (action === 'none_roles') {
      const next = ctx.store.updateGuild(guild.id, { immuneRoles: [] });
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 3));
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
              placeholder: '1. Keine Beleidigungen\n2. Kein Spam\n3. …',
            }),
          ],
        })
      );
    }
    if (action === 'rules_skip') {
      const next = ctx.store.updateGuild(guild.id, { rulesMode: 'skip', rules: '' });
      await setStep(ctx, guild, 5);
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, ctx.store.getGuild(guild.id), 5));
    }
    if (action === 'rules_import') {
      return interaction.update(renderStep(ctx, guild, cfg, 4, { draft: 'choose' }));
    }
    if (action === 'import_use') {
      const pending = ctx.setupDraft.get(guild.id);
      if (!pending) return interaction.update(renderStep(ctx, guild, cfg, 4, { note: t(lang, 'rulesNotFound') }));
      ctx.setupDraft.delete(guild.id);
      ctx.store.updateGuild(guild.id, { rulesMode: 'import', rules: pending.text });
      await setStep(ctx, guild, 5);
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, ctx.store.getGuild(guild.id), 5, { note: pending.truncated ? t(lang, 'rulesTooLong', { max: MAX_RULES_CHARS }) : null }));
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
              placeholder: 'z. B. „Bei Werbung sofort 1 Tag Timeout. Trash-Talk unter Freunden nie bestrafen."',
            }),
          ],
        })
      );
    }
    if (['allow_timeout', 'allow_kick', 'allow_ban'].includes(action)) {
      const field = action.replace('allow_', '');
      const next = ctx.store.updateGuild(guild.id, { allow: { ...cfg.allow, [field]: !cfg.allow[field] } });
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 5));
    }

    if (action === 'log_auto') {
      const created = await createLogChannel(ctx, guild, cfg);
      if (!created.ok) {
        return interaction.update(renderStep(ctx, guild, cfg, 6, { note: t(lang, 'logNeedPermission') }));
      }
      const channels = (cfg.channels || []).filter((id) => String(id) !== String(created.channel.id));
      const next = ctx.store.updateGuild(guild.id, { logChannelId: created.channel.id, logAuto: true, channels });
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 6, { note: `✅ <#${created.channel.id}>` }));
    }
    if (action === 'log_clear') {
      const next = ctx.store.updateGuild(guild.id, { logChannelId: null, logAuto: false });
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 6));
    }

    if (action === 'key') {
      return interaction.showModal(
        ui.modal({
          id: 'setup:modal:key',
          title: t(lang, 'keyEnter'),
          components: [ui.textInput({ id: 'key', label: 'Groq API Key', style: 1, required: true, maxLength: 200, placeholder: 'gsk_…' })],
        })
      );
    }
    if (action === 'key_clear') {
      const next = ctx.store.updateGuild(guild.id, { groqKey: null });
      await ctx.store.commit();
      return interaction.update(renderStep(ctx, guild, next, 7));
    }
  }

  return interaction.update(renderStep(ctx, guild, ctx.store.getGuild(guild.id), cfg.setup.step || 1, { note, draft }));
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
    ctx.store.updateGuild(guild.id, { rules: clamped.text, rulesMode: clamped.text.trim() ? 'manual' : 'skip' });
    await setStep(ctx, guild, 5);
    await ctx.store.commit();
    return interaction.update(
      renderStep(ctx, guild, ctx.store.getGuild(guild.id), 5, { note: clamped.truncated ? t(lang, 'rulesTooLong', { max: MAX_RULES_CHARS }) : null })
    );
  }

  if (action === 'instr') {
    const clamped = clampInstructions(interaction.fields.getTextInputValue('instructions') || '');
    const next = ctx.store.updateGuild(guild.id, { instructions: clamped.text });
    await ctx.store.commit();
    return interaction.update(
      renderStep(ctx, guild, next, 5, { note: clamped.truncated ? `Auf ${MAX_INSTRUCTIONS_CHARS} Zeichen gekürzt.` : null })
    );
  }

  if (action === 'key') {
    const key = String(interaction.fields.getTextInputValue('key') || '').trim();
    await interaction.deferUpdate().catch(() => {});
    const test = await validateGroqKey({ apiKey: key, fetchFn: ctx.fetchFn });
    if (!test.ok) {
      const next = ctx.store.getGuild(guild.id);
      await ctx.store.commit();
      return interaction.editReply(
        renderStep(ctx, guild, next, 7, { note: t(lang, 'keyBad', { err: test.error || 'unbekannt' }) })
      );
    }
    const next = ctx.store.updateGuild(guild.id, { groqKey: key });
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
    setup: { step: 1, furthest: STEPS, done: true, completedAt: Date.now() },
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
