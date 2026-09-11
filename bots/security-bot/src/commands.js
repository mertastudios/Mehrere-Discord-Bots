/**
 * Slash-Commands Definition, Registrierung & Handlers für den Sicherheitsbot.
 *
 * Befehlssatz (ausschließlich, alles nur für Administratoren):
 *   /set_gemini_api_key [key]         – Gemini API-Key für den Server hinterlegen
 *   /set_prompt                       – Formular für KI-Anweisungen (Regeln/Strenge/Maßnahmen)
 *   /set_log_channel [channel]        – Log-Kanal für Moderations-Hinweise & API-Fehler
 *   /set_anti_delete_messages [true/false] – gelöschte letzte Nachrichten per Webhook erneut senden
 *   /set_language                     – Botsprache dauerhaft ändern (10 Sprachen)
 *   /security_check_now [user]        – Sofort-Analyse anstoßen (optional: Nutzer zwangsmoderieren)
 *   /help                             – Übersicht
 *
 * Alle Commands werden GLOBAL registriert (siehe registerCommands weiter
 * unten) – neue Commands wie /security_check_now landen dadurch automatisch
 * auf JEDEM bisherigen Server, ohne dass Admins den Bot neu einladen müssen.
 */

const {
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
  InteractionContextType,
  ApplicationIntegrationType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ChannelType,
} = require('discord.js');

const { LANGS, t, langFromDiscord, isValidLang } = require('./languages');
const { smallContainer, buildHelpContainer } = require('./embed-builder');
const { componentsV2Payload } = require('./message-payload');
const { validateApiKey } = require('./gemini');
const { maskApiKey } = require('./mask');

const ALL_COMMAND_NAMES = [
  'set_gemini_api_key',
  'set_prompt',
  'set_log_channel',
  'set_anti_delete_messages',
  'set_language',
  'security_check_now',
  'help',
];

// Alle Commands sind global und ausschließlich im Guild-Context sichtbar.
const GLOBAL_COMMAND_NAMES = [...ALL_COMMAND_NAMES];
const GUILD_COMMAND_NAMES = [...ALL_COMMAND_NAMES];
const DM_ONLY_COMMAND_NAMES = [];

const DISCORD_LOCALE = {
  de: 'de',
  en: 'en-US',
  fr: 'fr',
  es: 'es-ES',
  pt: 'pt-BR',
  ru: 'ru',
  ja: 'ja',
  ko: 'ko',
  zh: 'zh-CN',
  it: 'it',
};

function pick(key) {
  const map = {};
  for (const code of Object.keys(LANGS)) {
    map[DISCORD_LOCALE[code]] = t(key, code);
  }
  return map;
}

function defineCommands() {
  const languageChoices = Object.entries(LANGS).map(([code, lang]) => ({
    name: `${lang.flag} ${lang.name}`,
    value: code,
    name_localizations: Object.fromEntries(
      Object.entries(lang.names).map(([c, n]) => [DISCORD_LOCALE[c], n])
    ),
  }));

  return [
    new SlashCommandBuilder()
      .setName('set_gemini_api_key')
      .setDescription('Google Gemini API-Key für diesen Server hinterlegen (nur Admins)')
      .setDescriptionLocalizations(pick('descApiKey'))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((o) =>
        o
          .setName('key')
          .setDescription('Gemini API-Key (AIza...) – "remove" löscht den Key wieder')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('set_prompt')
      .setDescription('Formular: Anweisungen der KI (Regeln, Strenge, Maßnahmen) – nur Admins')
      .setDescriptionLocalizations(pick('descPrompt'))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('set_log_channel')
      .setDescription('Log-Kanal für Moderations-Hinweise & API-Fehler setzen (nur Admins)')
      .setDescriptionLocalizations(pick('descLogChannel'))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Log-Kanal – leer lassen, um den Log-Kanal zu entfernen')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('set_anti_delete_messages')
      .setDescription('Anti-Delete: gelöschte letzte Nachrichten per Webhook erneut senden (nur Admins)')
      .setDescriptionLocalizations(pick('descAntiDelete'))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addBooleanOption((o) =>
        o
          .setName('enabled')
          .setDescription('true = Anti-Delete einschalten, false = ausschalten')
          .setDescriptionLocalizations(pick('descAntiDeleteOption'))
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('set_language')
      .setDescription('Ändert die Sprache des Sicherheitsbots dauerhaft (nur Admins)')
      .setDescriptionLocalizations(pick('descLanguage'))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((o) =>
        o
          .setName('language')
          .setDescription('Gewünschte Sprache')
          .setRequired(true)
          .addChoices(...languageChoices)
      ),

    new SlashCommandBuilder()
      .setName('security_check_now')
      .setDescription('Startet sofort eine KI-Prüfung der gesammelten Nachrichten (nur Admins)')
      .setDescriptionLocalizations(pick('descCheckNow'))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption((o) =>
        o
          .setName('user')
          .setDescription('Nutzer, der bei dieser Prüfung zwangsmoderiert werden soll (optional)')
          .setDescriptionLocalizations(pick('descCheckNowUser'))
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Zeigt alle Befehle und wie die KI-Moderation funktioniert (nur Admins)')
      .setDescriptionLocalizations(pick('descHelp'))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map((cmd) =>
    cmd
      .setContexts(InteractionContextType.Guild)
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  );
}

function guildCommandJson() {
  return defineCommands().map((c) => {
    const json = c.toJSON();
    // `contexts` und `integration_types` sind Felder globaler Commands. Ein
    // Guild-Command ist durch seine REST-Route bereits eindeutig auf Guild
    // Install + Guild Context begrenzt. Ohne diese global-only Felder bleibt
    // der Bulk-Guild-Payload mit Discord-Versionen strikt kompatibel.
    delete json.contexts;
    delete json.integration_types;
    delete json.dm_permission;
    return json;
  });
}

/** Der globale Bulk-Overwrite ist die Quelle der Wahrheit. */
function allCommandJson() {
  return defineCommands().map((c) => c.toJSON());
}

function idsFromDiscord(list) {
  return Object.fromEntries((Array.isArray(list) ? list : []).map((c) => [c.name, c.id]));
}

function hasCommandNames(ids, names) {
  return Boolean(ids) && names.every((name) => Boolean(ids[name]));
}

function normalizeGuildId(value) {
  if (value == null) return null;
  const id = String(value).trim().replace(/^<@!?(\d+)>$/, '$1');
  return id || null;
}

function isSnowflake(value) {
  return /^\d{17,20}$/.test(String(value || ''));
}

function getRest(ctx, restFactory) {
  if (restFactory) return restFactory(ctx.token);
  return ctx.rest || new REST({ version: '10' }).setToken(ctx.token);
}

function cachedGuildIds(ctx) {
  const ids = new Set();
  const cache = ctx.client?.guilds?.cache;
  if (cache?.values) {
    for (const guild of cache.values()) {
      const id = normalizeGuildId(guild?.id);
      if (id) ids.add(id);
    }
  } else if (cache instanceof Map) {
    for (const [cacheId, guild] of cache.entries()) {
      const id = normalizeGuildId(guild?.id || cacheId);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function rememberGlobalIds(ctx, ids) {
  ctx.commandIds = ids;
  ctx.store?.setCommandIds?.(ids);
}

function rememberGuildIds(ctx, guildId, ids) {
  const id = normalizeGuildId(guildId);
  if (!id) return;
  ctx.guildCommandIds = ctx.guildCommandIds instanceof Map ? ctx.guildCommandIds : new Map();
  ctx.guildCommandIds.set(id, ids);
  ctx.store?.setGuildCommandIds?.(id, ids);
}

function errorDetail(err) {
  if (!err) return 'message="Unbekannter Fehler" status=n/a code=n/a rawError=n/a';
  const safeMessage = String(err.message || err).replace(/\s+/g, ' ').slice(0, 1000);
  const status = err.status ?? err.httpStatus ?? err.response?.status ?? 'n/a';
  const code = err.code ?? err.rawError?.code ?? 'n/a';
  let rawError = 'n/a';
  if (err.rawError != null) {
    try {
      rawError = JSON.stringify(err.rawError).slice(0, 2000);
    } catch {
      rawError = '[nicht serialisierbar]';
    }
  }
  // Never serialize the complete REST error: request headers can contain the token.
  return `message=${JSON.stringify(safeMessage)} status=${status} code=${code} rawError=${rawError}`;
}

function commandList(response) {
  return (Array.isArray(response) ? response : [])
    .map((command) => `/${command.name} (${command.id || 'keine ID'})`)
    .join(', ');
}

function logRoute(ctx, method, route, scope, body = null) {
  const names = Array.isArray(body) ? body.map((command) => `/${command.name}`).join(', ') : 'n/a';
  ctx.logger?.info?.(
    `[security-bot] Discord REST ${method} ${route} | Application-ID=${ctx.client?.application?.id || ctx.client?.user?.id || 'unbekannt'} ` +
      `Scope=${scope} | Payload=${names || '(leer)'}`
  );
}

function logRegistration(ctx, scope, response) {
  ctx.logger?.info?.(
    `[security-bot] Discord hat Commands angenommen (${scope}): ${commandList(response) || '(leer)'}`
  );
}

function configuredImmediateGuild(ctx) {
  const id = normalizeGuildId(ctx.devGuildId);
  if (!id) return null;
  if (!isSnowflake(id)) {
    ctx.logger?.error?.(
      `[security-bot] SECURITY_BOT_GUILD_ID=${JSON.stringify(id)} ist keine gültige Discord-Snowflake; ` +
        'die globale Registrierung läuft trotzdem weiter.'
    );
    return null;
  }
  if (!cachedGuildIds(ctx).includes(id)) {
    ctx.logger?.warn?.(
      `[security-bot] SECURITY_BOT_GUILD_ID=${id}, aber der Bot ist laut Guild-Cache dort nicht installiert; ` +
        'Guild-PUT wird übersprungen, globale Commands bleiben aktiv.'
    );
    return null;
  }
  return id;
}

async function putAndValidate(ctx, rest, route, body, expectedNames, scope) {
  logRoute(ctx, 'PUT', route, scope, body);
  const response = await rest.put(route, { body });
  const ids = idsFromDiscord(response);
  if (!hasCommandNames(ids, expectedNames)) {
    const missing = expectedNames.filter((name) => !ids[name]);
    throw new Error(
      `Discord hat einen unvollständigen ${scope}-Command-Satz zurückgegeben ` +
        `(fehlt: ${missing.map((name) => `/${name}`).join(', ')})`
    );
  }
  logRegistration(ctx, scope, response);
  return { ids, response };
}

async function registerGuildCommands(ctx, guildId, { rest } = {}) {
  const clientId = ctx.client?.application?.id || ctx.client?.user?.id;
  const id = normalizeGuildId(guildId);
  if (!clientId || !id) return null;

  const api = rest || getRest(ctx);
  const route = Routes.applicationGuildCommands(clientId, id);
  const { ids } = await putAndValidate(
    ctx,
    api,
    route,
    guildCommandJson(),
    GUILD_COMMAND_NAMES,
    `Guild ${id}`
  );
  rememberGuildIds(ctx, id, ids);
  return ids;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Writes the complete global command set first. A configured Guild receives an
 * optional immediate copy afterwards. Guild failures can therefore never erase
 * or block the global fallback. Stale Guild overwrites are deleted only after
 * Discord has returned and validated the successful global bulk overwrite.
 */
async function registerCommands(ctx, { restFactory, retryDelays } = {}) {
  const rest = getRest(ctx, restFactory);
  const clientId = ctx.client?.application?.id || ctx.client?.user?.id;
  if (!clientId) {
    ctx.commandsRegistered = false;
    ctx.logger?.error?.('[security-bot] Registrierung abgebrochen: Keine Application-ID.');
    return false;
  }

  const userId = ctx.client?.user?.id || 'unbekannt';
  const guildIds = cachedGuildIds(ctx);
  const configuredGuild = normalizeGuildId(ctx.devGuildId);
  ctx.logger?.info?.(
    `[security-bot] Command-Sync Start | Application-ID=${clientId} Bot-User-ID=${userId} ` +
      `Scope=global+applications.commands Guild-ID=${configuredGuild || '(keine, nur global)'} ` +
      `Guild-Cache=${guildIds.join(',') || '(leer)'} Deploy-Commit=${ctx.deployCommit || 'unbekannt'}`
  );

  const delays = Array.isArray(retryDelays) && retryDelays.length
    ? retryDelays
    : [0, 5_000, 15_000, 30_000];
  const globalRoute = Routes.applicationCommands(clientId);
  let globalIds = null;

  for (let attempt = 0; attempt < delays.length && !globalIds; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      const result = await putAndValidate(
        ctx,
        rest,
        globalRoute,
        allCommandJson(),
        GLOBAL_COMMAND_NAMES,
        'global'
      );
      globalIds = result.ids;
    } catch (err) {
      ctx.logger?.error?.(
        `[security-bot] Globale Registrierung fehlgeschlagen (Versuch ${attempt + 1}/${delays.length}): ` +
          errorDetail(err)
      );
    }
  }

  if (!globalIds) {
    // Critical safety property: no Guild set is touched after a failed global PUT.
    ctx.commandsRegistered = false;
    ctx.logger?.error?.(
      '[security-bot] Command-Registrierung abgebrochen: globaler PUT wurde nicht bestätigt; ' +
        'bestehende Guild-Commands bleiben unverändert.'
    );
    return false;
  }

  rememberGlobalIds(ctx, globalIds);
  ctx.commandsRegistered = true;
  const immediateGuild = configuredImmediateGuild(ctx);

  if (immediateGuild) {
    try {
      await registerGuildCommands(ctx, immediateGuild, { rest });
      ctx.logger?.info?.(
        `[security-bot] Optionale Sofort-Registrierung für Guild ${immediateGuild} erfolgreich.`
      );
    } catch (err) {
      ctx.logger?.warn?.(
        `[security-bot] Optionale Guild-Registrierung für ${immediateGuild} fehlgeschlagen; ` +
          `globale Commands bleiben aktiv: ${errorDetail(err)}`
      );
    }
  }

  // Alte Guild-Overwrites würden die globalen Commands verschatten; erst nach
  // dem bestätigten globalen PUT aufräumen.
  for (const guildId of guildIds) {
    if (guildId === immediateGuild) continue;
    const route = Routes.applicationGuildCommands(clientId, guildId);
    try {
      logRoute(ctx, 'PUT', route, `Guild ${guildId} cleanup`, []);
      const removed = await rest.put(route, { body: [] });
      if (!Array.isArray(removed) || removed.length !== 0) {
        throw new Error('Discord hat beim Guild-Cleanup keinen leeren Satz zurückgegeben.');
      }
      rememberGuildIds(ctx, guildId, {});
      ctx.logger?.info?.(`[security-bot] Alte Guild-Commands auf ${guildId} nach globalem Erfolg gelöscht.`);
    } catch (err) {
      ctx.logger?.warn?.(
        `[security-bot] Guild-Cleanup für ${guildId} fehlgeschlagen; globaler Fallback bleibt aktiv: ` +
          errorDetail(err)
      );
    }
  }

  ctx.logger?.info?.(
    `[security-bot] Globaler Command-Satz vollständig bestätigt: ${GLOBAL_COMMAND_NAMES.length}/${GLOBAL_COMMAND_NAMES.length} ` +
      `Commands | ${Object.entries(globalIds).map(([name, id]) => `/${name} (${id})`).join(', ')}`
  );
  return true;
}

/** Read the authoritative global set back from Discord and repair it if needed. */
async function verifyCommandsLive(ctx) {
  const clientId = ctx.client?.application?.id || ctx.client?.user?.id;
  if (!clientId || !ctx.token) {
    ctx.commandsRegistered = false;
    return false;
  }

  const rest = getRest(ctx);
  const route = Routes.applicationCommands(clientId);
  try {
    logRoute(ctx, 'GET', route, 'global verification');
    let live = await rest.get(route);
    let ids = idsFromDiscord(live);
    ctx.logger?.info?.(
      `[security-bot] Discord GET global zurückgegeben: ${commandList(live) || '(leer)'}`
    );
    if (!hasCommandNames(ids, GLOBAL_COMMAND_NAMES)) {
      const missing = GLOBAL_COMMAND_NAMES.filter((name) => !ids[name]);
      ctx.logger?.warn?.(
        `[security-bot] Globale Verifikation: ${missing.map((name) => `/${name}`).join(', ')} fehlen; repariere.`
      );
      const result = await putAndValidate(
        ctx,
        rest,
        route,
        allCommandJson(),
        GLOBAL_COMMAND_NAMES,
        'global repair'
      );
      live = result.response;
      ids = result.ids;
    }
    rememberGlobalIds(ctx, ids);
    ctx.commandsRegistered = true;
    ctx.logger?.info?.(
      `[security-bot] Command-Verifikation OK: Discord liefert global ${GLOBAL_COMMAND_NAMES.length} Commands: ` +
        commandList(live)
    );
    return true;
  } catch (err) {
    ctx.commandsRegistered = false;
    ctx.logger?.error?.(`[security-bot] Globale Command-Verifikation fehlgeschlagen: ${errorDetail(err)}`);
    return false;
  }
}

async function ensureCommandIds(ctx, guildId = null) {
  const gid = normalizeGuildId(guildId);
  const guildIds = gid && ctx.guildCommandIds instanceof Map ? ctx.guildCommandIds.get(gid) : null;
  if (hasCommandNames(guildIds, GUILD_COMMAND_NAMES)) return guildIds;
  if (hasCommandNames(ctx.commandIds, GLOBAL_COMMAND_NAMES)) return ctx.commandIds;

  const clientId = ctx.client?.application?.id || ctx.client?.user?.id;
  if (!clientId || !ctx.token) return ctx.commandIds || {};
  try {
    const rest = getRest(ctx);
    const route = Routes.applicationCommands(clientId);
    logRoute(ctx, 'GET', route, 'global command IDs');
    const fetched = await rest.get(route);
    const ids = idsFromDiscord(fetched);
    if (hasCommandNames(ids, GLOBAL_COMMAND_NAMES)) rememberGlobalIds(ctx, ids);
    return ids;
  } catch (err) {
    ctx.logger?.warn?.(
      `[security-bot] Globale Command-IDs konnten nicht geladen werden: ${errorDetail(err)}`
    );
    return ctx.commandIds || {};
  }
}

function commandMention(ctx, name, guildId = null) {
  let id = null;
  if (guildId && ctx.guildCommandIds instanceof Map) {
    id = ctx.guildCommandIds.get(String(guildId))?.[name] || null;
  }
  if (!id) id = ctx.commandIds?.[name] || null;
  return id ? `</${name}:${id}>` : `/${name}`;
}

// ----------------- Guards & Helpers -----------------

function isAdminInteraction(interaction) {
  const perms = interaction.memberPermissions ?? interaction.member?.permissions;
  return Boolean(perms?.has?.(PermissionFlagsBits.Administrator));
}

function guildLang(ctx, interaction) {
  const cfg = ctx.store.ensureGuild(interaction.guildId);
  return cfg.lang || langFromDiscord(interaction.locale);
}

function denyMissingPermission(ctx, interaction, lang) {
  return interaction.reply(
    componentsV2Payload([smallContainer(null, t('errNoPermission', lang))], { ephemeral: true })
  );
}

const REMOVE_KEYWORDS = new Set(['remove', 'delete', 'löschen', 'loeschen', 'entfernen', 'reset']);

// ----------------- Command Handlers -----------------

async function handleSetGeminiApiKey(ctx, interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply(
      componentsV2Payload([smallContainer(null, t('errGuildOnly', 'en'))], { ephemeral: true })
    );
  }
  const lang = guildLang(ctx, interaction);
  if (!isAdminInteraction(interaction)) return denyMissingPermission(ctx, interaction, lang);

  const cfg = ctx.store.ensureGuild(interaction.guildId);
  const rawKey = String(interaction.options.getString('key') || '').trim();

  // Entfernen (Keyword) – der Key selbst ist nie per Modal maskiert, deshalb
  // reicht das simple Keyword-Protokoll.
  if (REMOVE_KEYWORDS.has(rawKey.toLowerCase())) {
    cfg.geminiApiKey = null;
    ctx.store.setGuild(cfg);
    await ctx.store.flush();
    return interaction.reply(
      componentsV2Payload([smallContainer(null, t('apiKeyRemoved', lang))], { ephemeral: true })
    );
  }

  if (!rawKey || rawKey.length < 20) {
    return interaction.reply(
      componentsV2Payload(
        [smallContainer(null, t('apiKeyInvalid', lang, { error: 'Key zu kurz/leer' }))],
        { ephemeral: true }
      )
    );
  }

  // Wenn maskierter Key unverändert eingereicht wurde -> nichts tun
  if (cfg.geminiApiKey && rawKey === maskApiKey(cfg.geminiApiKey)) {
    return interaction.reply(
      componentsV2Payload([smallContainer(null, t('apiKeyKept', lang))], { ephemeral: true })
    );
  }

  await interaction.deferReply({ ephemeral: true });

  // Live-Verifikation beim Google Models-Endpunkt (tanzt keine Tippfehler durch)
  const check = await validateApiKey({ apiKey: rawKey, model: undefined, fetchFn: ctx.geminiFetch });

  if (!check.ok && check.fatal) {
    return interaction.editReply(
      componentsV2Payload([smallContainer(null, t('apiKeyInvalid', lang, { error: check.error }))])
    );
  }

  cfg.geminiApiKey = rawKey;
  ctx.store.setGuild(cfg);
  await ctx.store.flush();

  const masked = maskApiKey(rawKey);
  if (!check.ok) {
    return interaction.editReply(
      componentsV2Payload([smallContainer(null, t('apiKeyUnverified', lang, { key: masked, error: check.error }))])
    );
  }
  return interaction.editReply(
    componentsV2Payload([smallContainer(null, t('apiKeySet', lang, { key: masked }))])
  );
}

async function handleSetPrompt(ctx, interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply(
      componentsV2Payload([smallContainer(null, t('errGuildOnly', 'en'))], { ephemeral: true })
    );
  }
  const lang = guildLang(ctx, interaction);
  if (!isAdminInteraction(interaction)) return denyMissingPermission(ctx, interaction, lang);

  const cfg = ctx.store.ensureGuild(interaction.guildId);
  // Standardtext oder der letzte eingestellte Prompt ist bereits vorausgefüllt.
  const current = cfg.prompt || t('defaultPrompt', lang);

  const modal = new ModalBuilder()
    .setCustomId('secgem_modal_prompt')
    .setTitle(t('promptModalTitle', lang).slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('secgem_input_prompt')
          .setLabel(t('promptModalLabel', lang).slice(0, 45))
          .setStyle(TextInputStyle.Paragraph)
          .setValue(current.slice(0, 4000))
          .setMaxLength(4000)
          .setRequired(false)
      )
    );

  return interaction.showModal(modal);
}

async function handleSetLogChannel(ctx, interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply(
      componentsV2Payload([smallContainer(null, t('errGuildOnly', 'en'))], { ephemeral: true })
    );
  }
  const lang = guildLang(ctx, interaction);
  if (!isAdminInteraction(interaction)) return denyMissingPermission(ctx, interaction, lang);

  const cfg = ctx.store.ensureGuild(interaction.guildId);
  const channel = interaction.options.getChannel('channel');

  if (!channel) {
    cfg.logChannelId = null;
    ctx.store.setGuild(cfg);
    await ctx.store.flush();
    return interaction.reply(
      componentsV2Payload([smallContainer(null, t('logChannelRemoved', lang))], { ephemeral: true })
    );
  }

  cfg.logChannelId = channel.id;
  ctx.store.setGuild(cfg);
  await ctx.store.flush();

  return interaction.reply(
    componentsV2Payload(
      [smallContainer(null, t('logChannelSet', lang, { channel: `<#${channel.id}>` }))],
      { ephemeral: true }
    )
  );
}

async function handleSetLanguage(ctx, interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply(
      componentsV2Payload([smallContainer(null, t('errGuildOnly', 'en'))], { ephemeral: true })
    );
  }
  const currentLang = guildLang(ctx, interaction);
  if (!isAdminInteraction(interaction)) return denyMissingPermission(ctx, interaction, currentLang);

  const newLang = interaction.options.getString('language');
  if (!isValidLang(newLang)) {
    return interaction.reply(
      componentsV2Payload([smallContainer(null, 'Ungültige Sprache.')], { ephemeral: true })
    );
  }

  const cfg = ctx.store.ensureGuild(interaction.guildId);
  cfg.lang = newLang;
  ctx.store.setGuild(cfg);
  await ctx.store.flush();

  const msg = t('langChanged', newLang, { name: `${LANGS[newLang].flag} ${LANGS[newLang].name}` });
  return interaction.reply(
    componentsV2Payload([smallContainer(null, msg)], { ephemeral: true })
  );
}

async function handleHelp(ctx, interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply(
      componentsV2Payload([smallContainer(null, t('errGuildOnly', 'en'))], { ephemeral: true })
    );
  }
  const lang = guildLang(ctx, interaction);
  if (!isAdminInteraction(interaction)) return denyMissingPermission(ctx, interaction, lang);

  await ensureCommandIds(ctx, interaction.guildId);
  const commands = {
    set_gemini_api_key: commandMention(ctx, 'set_gemini_api_key', interaction.guildId),
    set_prompt: commandMention(ctx, 'set_prompt', interaction.guildId),
    set_log_channel: commandMention(ctx, 'set_log_channel', interaction.guildId),
    set_anti_delete_messages: commandMention(ctx, 'set_anti_delete_messages', interaction.guildId),
    set_language: commandMention(ctx, 'set_language', interaction.guildId),
    security_check_now: commandMention(ctx, 'security_check_now', interaction.guildId),
    help: commandMention(ctx, 'help', interaction.guildId),
  };
  const container = buildHelpContainer({ lang, commands });
  return interaction.reply(componentsV2Payload([container], { ephemeral: false }));
}

/**
 * /set_anti_delete_messages [enabled:true|false] – schaltet Anti-Delete für
 * diesen Server ein oder aus. Aktiv: Löscht ein echter Nutzer (kein Bot/
 * Webhook) seine eigene letzte Nachricht eines Kanals, wird sie per Webhook
 * mit exakter Profil-Kopie erneut gesendet (siehe anti-delete.js).
 */
async function handleSetAntiDeleteMessages(ctx, interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply(
      componentsV2Payload([smallContainer(null, t('errGuildOnly', 'en'))], { ephemeral: true })
    );
  }
  const lang = guildLang(ctx, interaction);
  if (!isAdminInteraction(interaction)) return denyMissingPermission(ctx, interaction, lang);

  const enabled = Boolean(interaction.options?.getBoolean?.('enabled'));
  ctx.store.setAntiDeleteEnabled(interaction.guildId, enabled);
  await ctx.store.flush();

  return interaction.reply(
    componentsV2Payload(
      [smallContainer(null, t(enabled ? 'antiDeleteEnabled' : 'antiDeleteDisabled', lang))],
      { ephemeral: true }
    )
  );
}

/**
 * /security_check_now [user] – wertet die aktuell gesammelten Nachrichten
 * SOFORT aus (Buffer + evtl. hängende Retry-Batches), ohne auf das Token-Limit
 * oder den nächsten 2-Stunden-Flush zu warten. Praktisch, um nach einer
 * Konfigurationsänderung (z. B. neuer API-Key oder Modell) sofort zu testen,
 * ob die Analyse wieder funktioniert.
 *
 * Option `user`: Ein Nutzer, der bei DIESER Prüfung zwingend moderiert werden
 * soll. Die Anordnung wandert als verbindliche Direktive in den System-Prompt
 * (buildSystemPrompt → "ZWINGENDE MODERATION"). Bots, der Bot selbst und
 * Administratoren (doppelt geschützte Immunität) können nicht gewählt werden.
 */
async function handleCheckNow(ctx, interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply(
      componentsV2Payload([smallContainer(null, t('errGuildOnly', 'en'))], { ephemeral: true })
    );
  }
  const lang = guildLang(ctx, interaction);
  if (!isAdminInteraction(interaction)) return denyMissingPermission(ctx, interaction, lang);

  const cfg = ctx.store.ensureGuild(interaction.guildId);
  if (!cfg.geminiApiKey) {
    return interaction.reply(
      componentsV2Payload([smallContainer(null, t('checkNowNoKey', lang))], { ephemeral: true })
    );
  }

  // Optionaler Zwangsmoderations-Zielnutzer (Option `user`).
  const targetUser =
    typeof interaction.options?.getUser === 'function'
      ? interaction.options.getUser('user')
      : null;
  let forcedTarget = null;
  if (targetUser) {
    const ownId = ctx.client?.user?.id || interaction.client?.user?.id || null;
    let targetMember = null;
    try {
      targetMember = interaction.guild?.members?.cache?.get?.(targetUser.id) || null;
      if (!targetMember && typeof interaction.guild?.members?.fetch === 'function') {
        targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
      }
    } catch {
      targetMember = null;
    }
    const isImmune =
      Boolean(targetUser.bot) ||
      (ownId && String(targetUser.id) === String(ownId)) ||
      Boolean(targetMember?.permissions?.has?.(PermissionFlagsBits.Administrator));
    if (isImmune) {
      return interaction.reply(
        componentsV2Payload(
          [smallContainer(null, t('checkNowForcedInvalid', lang, { user: `<@${targetUser.id}>` }))],
          { ephemeral: true }
        )
      );
    }
    forcedTarget = {
      id: String(targetUser.id),
      name: String(
        targetMember?.displayName || targetUser.globalName || targetUser.username || targetUser.id
      ),
    };
  }

  await interaction.deferReply({ ephemeral: true });

  // Lazy require: vermeidet einen zyklischen Require zwischen commands.js
  // und moderator.js (moderator.js benötigt commands.js nicht, aber so
  // bleibt die Abhängigkeitsrichtung eindeutig und Tests können den
  // Moderator weiterhin per require.cache austauschen).
  const { runCheckNow } = require('./moderator');
  const result = await runCheckNow(ctx, interaction.guildId, { forceUser: forcedTarget });

  // Hinweis zur Zwangsmoderation an die Antwort anhängen (falls gewählt).
  let forcedNote = '';
  if (forcedTarget) {
    const mention = `<@${forcedTarget.id}>`;
    forcedNote =
      result.empty || !result.forcedSeen
        ? t('checkNowForcedNoMsgs', lang, { user: mention })
        : t('checkNowForcedActive', lang, { user: mention });
  }
  const withNote = (text) => (forcedNote ? `${text}\n${forcedNote}` : text);

  if (result.empty) {
    return interaction.editReply(
      componentsV2Payload([smallContainer(null, withNote(t('checkNowEmpty', lang)))])
    );
  }

  if (result.remaining > 0) {
    return interaction.editReply(
      componentsV2Payload([
        smallContainer(
          null,
          withNote(
            t('checkNowPartial', lang, {
              count: result.analyzed + result.remaining,
              remaining: result.remaining,
            })
          )
        ),
      ])
    );
  }

  return interaction.editReply(
    componentsV2Payload([
      smallContainer(null, withNote(t('checkNowDone', lang, { count: result.analyzed }))),
    ])
  );
}

/**
 * Chat-Input-Router für Slash-Commands.
 */
async function handleChatInput(ctx, interaction) {
  switch (interaction.commandName) {
    case 'set_gemini_api_key':
      return handleSetGeminiApiKey(ctx, interaction);
    case 'set_prompt':
      return handleSetPrompt(ctx, interaction);
    case 'set_log_channel':
      return handleSetLogChannel(ctx, interaction);
    case 'set_anti_delete_messages':
      return handleSetAntiDeleteMessages(ctx, interaction);
    case 'set_language':
      return handleSetLanguage(ctx, interaction);
    case 'security_check_now':
      return handleCheckNow(ctx, interaction);
    case 'help':
      return handleHelp(ctx, interaction);
    default:
      return interaction.reply(
        componentsV2Payload([smallContainer(null, 'Unbekannter Befehl.')], { ephemeral: true })
      );
  }
}

module.exports = {
  defineCommands,
  guildCommandJson,
  allCommandJson,
  registerCommands,
  registerGuildCommands,
  verifyCommandsLive,
  ensureCommandIds,
  handleChatInput,
  pick,
  commandMention,
  DISCORD_LOCALE,
  ALL_COMMAND_NAMES,
  GLOBAL_COMMAND_NAMES,
  GUILD_COMMAND_NAMES,
  DM_ONLY_COMMAND_NAMES,
  formatDiscordError: errorDetail,
};
