/**
 * Tests für den komplett neu gebauten Security-Bot (Gemini-Pipeline):
 * Commands, Sprachen, Store (Buffer/Batches/Strafenregister), Collector
 * (Discord-Formate → Klartext), Gemini-Client, Prompt-Bau, Moderator-Pipeline
 * (Aktionen, Retries, Immunität), Scheduler (0-Uhr-Flush) & Interactions.
 * Läuft komplett ohne externe Discord- oder Gemini-Verbindung.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits, ChannelType, MessageFlags, GatewayIntentBits } = require('discord.js');

const {
  defineCommands,
  allCommandJson,
  guildCommandJson,
  handleChatInput,
  commandMention,
  ALL_COMMAND_NAMES,
} = require('../bots/security-bot/src/commands');
const { handleInteraction } = require('../bots/security-bot/src/interactions');
const { LANGS, t, langFromDiscord, tzFor, isValidLang } = require('../bots/security-bot/src/languages');
const { createSecurityStore, MAX_BUFFER_MESSAGES } = require('../bots/security-bot/src/store');
const {
  estimateTokens,
  callGemini,
  validateApiKey,
  parseModerationJson,
  extractResponseText,
  modelFromEnv,
  DEFAULT_GEMINI_MODEL,
  RESPONSE_SCHEMA,
} = require('../bots/security-bot/src/gemini');
const {
  buildSystemPrompt,
  buildUserPrompt,
  buildChatLog,
  DURATION_SECONDS,
} = require('../bots/security-bot/src/prompts');
const {
  handleIncoming,
  shouldCollect,
  classifyMessage,
  humanizeContent,
  escapeDiscordMarkdown,
  maxInputTokens,
} = require('../bots/security-bot/src/collector');
const {
  processGuild,
  flushBuffer,
  runCheckNow,
  personalMessageText,
  nextRetryDelay,
  BACKOFF_SCHEDULE_MS,
} = require('../bots/security-bot/src/moderator');
const {
  tickOnce,
  dayKeyInTz,
  hourInTz,
  slotKeyInTz,
  oldestBufferedAt,
  FLUSH_INTERVAL_HOURS,
} = require('../bots/security-bot/src/scheduler');
const {
  shouldFlushBuffer,
  riskSignalsForMessage,
  mentionPressureSignal,
} = require('../bots/security-bot/src/batch-policy');
const {
  reserveGeminiSlot,
  noteGemini429,
  rateLimitConfig,
} = require('../bots/security-bot/src/rate-limit');
const {
  handleMessageDelete,
  wasLastChannelMessage,
  clearWebhookCache,
} = require('../bots/security-bot/src/anti-delete');
const { maskApiKey } = require('../bots/security-bot/src/mask');

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeStore() {
  const store = createSecurityStore({
    env: (k) => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : ''),
  });
  return store.init().then(() => store);
}

// ============================================================================
// 1. Bot-Modul
// ============================================================================

test('Security Bot: Modul-Export & Intents', () => {
  const bot = require('../bots/security-bot/index.js');
  assert.equal(bot.id, 'security-bot');
  assert.equal(bot.name, 'Security Bot');
  assert.equal(bot.tokenEnv, 'SECURITY_BOT_TOKEN');
  assert.equal(typeof bot.create, 'function');
  assert.ok(Array.isArray(bot.intents));
  assert.ok(bot.intents.includes(GatewayIntentBits.MessageContent));
  assert.ok(bot.intents.includes(GatewayIntentBits.GuildMembers));
});

// ============================================================================
// 2. Commands
// ============================================================================

test('Security Bot: genau 7 Commands, alle nur für Admins', () => {
  const cmds = defineCommands().map((c) => c.toJSON());
  assert.equal(cmds.length, 7);

  const names = cmds.map((c) => c.name);
  assert.deepEqual([...names].sort(), [
    'help',
    'security_check_now',
    'set_anti_delete_messages',
    'set_gemini_api_key',
    'set_language',
    'set_log_channel',
    'set_prompt',
  ]);
  assert.deepEqual(ALL_COMMAND_NAMES, names);

  for (const cmd of cmds) {
    assert.equal(cmd.default_member_permissions, '8', `/${cmd.name} ist Admin-only`);
    assert.deepEqual(cmd.contexts, [0], `/${cmd.name} ist Guild-only`);
    assert.deepEqual(cmd.integration_types, [0]);
    // Discord-Limits: Beschreibungen ≤ 100 Zeichen (auch lokalisiert)
    assert.ok(cmd.description.length <= 100, `/${cmd.name} Beschreibung ≤ 100`);
    for (const loc of Object.values(cmd.description_localizations || {})) {
      assert.ok(loc.length <= 100, `/${cmd.name} lokalisierte Beschreibung ≤ 100`);
    }
  }

  // /set_gemini_api_key hat einen Pflicht-String-Parameter "key"
  const keyCmd = cmds.find((c) => c.name === 'set_gemini_api_key');
  assert.equal(keyCmd.options[0].name, 'key');
  assert.equal(keyCmd.options[0].type, 3); // STRING
  assert.equal(keyCmd.options[0].required, true);

  // /set_prompt hat KEINE Optionen (öffnet ein Formular/Modal)
  const promptCmd = cmds.find((c) => c.name === 'set_prompt');
  assert.equal(promptCmd.options.length, 0);

  // /set_log_channel hat einen optionalen Kanal-Parameter
  const logCmd = cmds.find((c) => c.name === 'set_log_channel');
  assert.equal(logCmd.options[0].name, 'channel');
  assert.equal(logCmd.options[0].required, false);
  assert.deepEqual(logCmd.options[0].channel_types, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);

  // /set_language hat 10 Sprach-Auswahlen
  const langCmd = cmds.find((c) => c.name === 'set_language');
  assert.equal(langCmd.options[0].choices.length, 10, '10 Sprachen stehen zur Auswahl');

  // /security_check_now hat eine OPTIONALE User-Option (Zwangsmoderation)
  const checkNowCmd = cmds.find((c) => c.name === 'security_check_now');
  assert.ok(checkNowCmd, '/security_check_now existiert');
  assert.equal(checkNowCmd.options.length, 1, 'eine optionale user-Option');
  assert.equal(checkNowCmd.options[0].name, 'user');
  assert.equal(checkNowCmd.options[0].type, 6); // USER
  assert.equal(checkNowCmd.options[0].required, false);

  // /set_anti_delete_messages hat eine Pflicht-Boolean-Option (Auswahl true/false)
  const antiCmd = cmds.find((c) => c.name === 'set_anti_delete_messages');
  assert.ok(antiCmd, '/set_anti_delete_messages existiert');
  assert.equal(antiCmd.options.length, 1);
  assert.equal(antiCmd.options[0].name, 'enabled');
  assert.equal(antiCmd.options[0].type, 5); // BOOLEAN
  assert.equal(antiCmd.options[0].required, true);

  // Guild-Payload identisch (kein DM-Command mehr)
  assert.deepEqual(guildCommandJson().map((c) => c.name), ALL_COMMAND_NAMES);
});

// ============================================================================
// 3. Sprachen
// ============================================================================

test('Security Bot: 10 Sprachen, vollständige & limit-konforme Texte', () => {
  const expectedLangs = ['de', 'en', 'fr', 'es', 'pt', 'ru', 'ja', 'ko', 'zh', 'it'];
  assert.deepEqual(Object.keys(LANGS), expectedLangs);

  for (const lang of expectedLangs) {
    assert.ok(LANGS[lang].name, `Sprachname für ${lang}`);
    assert.ok(LANGS[lang].tz, `Zeitzone für ${lang}`);
    // Alle deutschen Keys müssen in jeder Sprache existieren (keine Lücken)
    for (const key of Object.keys(LANGS.de)) {
      assert.ok(LANGS[lang][key] !== undefined, `Key ${key} fehlt in ${lang}`);
    }
    // Short-Descriptions (Discord-Limit)
    for (const key of ['descApiKey', 'descPrompt', 'descLogChannel', 'descLanguage', 'descHelp']) {
      assert.ok(t(key, lang).length > 0 && t(key, lang).length <= 100, `${key} (${lang}) ≤ 100`);
    }
    assert.ok(t('defaultPrompt', lang).length > 200, `defaultPrompt für ${lang} ist substantiell`);
    assert.ok(t('defaultPrompt', lang).includes('{USER}'.replace('{USER}', 'WARN')) === false);
  }

  assert.equal(langFromDiscord('de'), 'de');
  assert.equal(langFromDiscord('en-US'), 'en');
  assert.equal(langFromDiscord('fr'), 'fr');
  assert.equal(langFromDiscord('ja'), 'ja');
  assert.equal(langFromDiscord('xx'), 'de');
  assert.equal(isValidLang('it'), true);
  assert.equal(isValidLang('xx'), false);
  assert.equal(tzFor('de'), 'Europe/Berlin');
  assert.equal(tzFor('en'), 'America/New_York');
});

// ============================================================================
// 4. Store: Konfiguration, Buffer, Batches, Strafenregister
// ============================================================================

test('Security Bot: Store CRUD (Key, Prompt, Log-Kanal, Sprache)', async () => {
  const store = await makeStore();

  const cfg = store.ensureGuild('g1');
  assert.equal(cfg.lang, 'de');
  assert.equal(cfg.geminiApiKey, null);
  assert.equal(cfg.prompt, null);
  assert.equal(cfg.logChannelId, null);

  store.setApiKey('g1', 'AIza-test-key-1234567890');
  assert.equal(store.getApiKey('g1'), 'AIza-test-key-1234567890');
  store.setApiKey('g1', null);
  assert.equal(store.getApiKey('g1'), null);
  store.setApiKey('g1', 'AIza-final-key-9876543210');

  store.setPrompt('g1', 'Sei streng bei Beleidigungen');
  assert.equal(store.getPrompt('g1'), 'Sei streng bei Beleidigungen');
  store.setPrompt('g1', null);
  assert.equal(store.getPrompt('g1'), null, 'null = Standardtext');
  store.setPrompt('g1', 'x'.repeat(5000));
  assert.ok(store.getPrompt('g1').length <= 4000, 'Prompt wird auf 4000 Zeichen gekürzt');

  store.setLogChannelId('g1', 'c-log');
  assert.equal(store.getLogChannelId('g1'), 'c-log');

  // Anti-Delete-Flag (Standard: aus)
  assert.equal(store.getAntiDeleteEnabled('g1'), false, 'Anti-Delete standardmäßig deaktiviert');
  store.setAntiDeleteEnabled('g1', true);
  assert.equal(store.getAntiDeleteEnabled('g1'), true);
  store.setAntiDeleteEnabled('g1', false);
  assert.equal(store.getAntiDeleteEnabled('g1'), false);
  // Flag überlebt andere Config-Updates (normalizeGuildConfig beim Speichern)
  store.setAntiDeleteEnabled('g1', true);
  store.setLogChannelId('g1', 'c-log2');
  assert.equal(store.getAntiDeleteEnabled('g1'), true, 'Anti-Delete bleibt bei anderem Update erhalten');

  store.setLanguage('g1', 'en');
  assert.equal(store.getLanguage('g1'), 'en');
  store.setLanguage('g1', 'invalid');
  assert.equal(store.getLanguage('g1'), 'invalid'); // roher Wert wird beim Speichern akzeptiert, Auswahl regelt der Command

  assert.equal(maskApiKey('AIzaSyD-1234567890abcdefghijklmnopqrstuv'), 'AIzaSyD...stuv');
});

test('Security Bot: Buffer → Batch (IDs ab 1, chronologisch, Limits)', async () => {
  const store = await makeStore();
  const base = Date.now() - 60_000;

  for (let i = 1; i <= 3; i++) {
    const rec = store.addBufferMessage('g1', {
      channelId: 'c1',
      channelName: 'allgemein',
      authorId: `u${i}`,
      authorName: `Nutzer${i}`,
      content: `Nachricht ${i}`,
      discordMessageId: `d${i}`,
      sentAt: base + i * 1000,
    });
    assert.ok(rec, `Nachricht ${i} im Buffer`);
  }
  assert.equal(store.getBuffer('g1').length, 3);
  assert.equal(store.countPendingMessages('g1'), 3);

  const batch = store.buildBatchFromBuffer('g1');
  assert.ok(batch);
  assert.equal(batch.size, 3);
  assert.equal(store.getBuffer('g1').length, 0, 'Buffer danach leer');

  const msgs = store.getBatchMessages('g1', batch.id);
  assert.deepEqual(
    msgs.map((m) => m.seq),
    [1, 2, 3],
    'IDs zählen von 1 an aufwärts'
  );
  assert.deepEqual(
    msgs.map((m) => m.content),
    ['Nachricht 1', 'Nachricht 2', 'Nachricht 3'],
    'chronologische Reihenfolge'
  );
  assert.ok(msgs.every((m) => m.batchId === batch.id));

  // Batch löschen räumt Nachrichten weg
  store.deleteBatch('g1', batch.id);
  assert.equal(store.getBatchMessages('g1', batch.id).length, 0);
  assert.equal(store.countPendingMessages('g1'), 0);
  assert.equal(store.getBatches('g1').length, 0);

  // Buffer-Obergrenze
  for (let i = 0; i < MAX_BUFFER_MESSAGES; i++) {
    assert.ok(store.addBufferMessage('g1', { channelId: 'c1', authorId: 'u1', authorName: 'x', content: 'spam' }));
  }
  assert.equal(store.addBufferMessage('g1', { channelId: 'c1', authorId: 'u1', authorName: 'x', content: 'überlauf' }), null);
});

test('Security Bot: Store übernimmt Rich-Context-Metadaten in Batch-Nachrichten', async () => {
  const store = await makeStore();
  store.addBufferMessage('g1', {
    channelId: 'c1',
    channelName: 'allgemein',
    authorId: 'u1',
    authorName: 'PaySafe',
    authorMeta: { id: 'u1', displayName: 'PaySafe', serverNickname: 'PaySafe | Merta', globalName: 'Pay', username: 'paysafePrivat' },
    mentionsMeta: [{ id: 'u2', displayName: '[Lvl 1] 𝔣', serverNickname: '[Lvl 1] 𝔣', globalName: '𝔣', username: 'ykkfat1' }],
    replyMeta: { messageId: 'r1', channelId: 'c1', author: { id: 'u2', displayName: '[Lvl 1] 𝔣', username: 'ykkfat1' }, content: 'hör bitte auf' },
    content: 'antwort bitte',
    discordMessageId: 'm1',
  });

  const tokenEstimate = store.getBufferTokenEstimate('g1', estimateTokens);
  assert.ok(tokenEstimate > estimateTokens('antwort bitte'), 'Rich-Context fließt in die Token-Schätzung ein');
  const batch = store.buildBatchFromBuffer('g1');
  const [msg] = store.getBatchMessages('g1', batch.id);
  assert.equal(msg.authorMeta.serverNickname, 'PaySafe | Merta');
  assert.equal(msg.mentionsMeta[0].username, 'ykkfat1');
  assert.equal(msg.replyMeta.messageId, 'r1');
});

test('Security Bot: Strafenregister (20-Tage-Fenster) & Prune & Guild-Delete', async () => {
  const store = await makeStore();
  const now = Date.now();

  store.addPenalty({ guildId: 'g1', userId: 'u1', userName: 'Max', action: 'warn', reason: 'Beleidigung', createdAt: now - 5 * 86400e3 });
  store.addPenalty({ guildId: 'g1', userId: 'u1', userName: 'Max', action: 'timeout', duration: '1h', durationSeconds: 3600, reason: 'Spam', isPrimary: true, createdAt: now - 2 * 86400e3 });
  store.addPenalty({ guildId: 'g1', userId: 'u1', userName: 'Max', action: 'warn', reason: 'alt', createdAt: now - 25 * 86400e3 }); // außerhalb 20 Tage
  store.addPenalty({ guildId: 'g2', userId: 'u1', userName: 'Max', action: 'warn', reason: 'anderer Server', createdAt: now });

  const summary = store.getPenaltySummary('g1', { days: 20, now });
  assert.equal(summary.get('u1').count, 2);
  assert.equal(summary.get('u1').lastAction, 'timeout');
  assert.equal(store.countPenaltiesSince('g1', 'u1', 20, now), 2);
  assert.equal(store.countPenaltiesSince('g1', 'u2', 20, now), 0);

  // Prune: Strafen > 30 Tage weg; alte Batches werden verworfen & gemeldet
  store.addPenalty({ guildId: 'g1', userId: 'u9', userName: 'Alt', action: 'warn', createdAt: now - 40 * 86400e3 });
  const batch = store.buildBatchFromBuffer('g1') || { id: 'b_none', createdAt: now - 40 * 86400e3 };
  const { prunedPenalties, dropped } = store.prune(now);
  assert.ok(prunedPenalties >= 1, 'alte Strafen wurden entfernt');
  assert.ok(Array.isArray(dropped));

  // Guild-Delete räumt ALLES der Gilde weg
  store.setLogChannelId('g2', 'c2');
  store.deleteGuild('g1');
  assert.equal(store.getGuild('g1'), null);
  assert.equal(store.countPendingMessages('g1'), 0);
  assert.equal(store.getPenaltySummary('g1', { days: 365, now }).size, 0);
  assert.ok(store.getGuild('g2'), 'andere Gilde unberührt');
});

test('Security Bot: Persistenz über Datei-Fallback (RAM-first Roundtrip)', async () => {
  const localFile = path.join(__dirname, '..', 'bots', 'security-bot', 'security-gemini-data.json');
  const sharedFile = path.join(__dirname, '..', 'data', 'security-gemini-store.json');
  for (const f of [localFile, sharedFile]) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
  try {
    const storeA = createSecurityStore({ env: () => '', logger: noopLogger });
    await storeA.init();
    storeA.setApiKey('gX', 'AIza-roundtrip-key-123456');
    storeA.setPrompt('gX', 'Regel: nett sein');
    storeA.setLogChannelId('gX', 'c-log');
    storeA.setAntiDeleteEnabled('gX', true);
    storeA.addBufferMessage('gX', { channelId: 'c1', authorId: 'u1', authorName: 'Max', content: 'Hallo Welt' });
    const batch = storeA.buildBatchFromBuffer('gX');
    storeA.addPenalty({ guildId: 'gX', userId: 'u1', userName: 'Max', action: 'warn', reason: 'test' });
    await storeA.flush({ force: true });

    const storeB = createSecurityStore({ env: () => '', logger: noopLogger });
    await storeB.init();
    assert.equal(storeB.getApiKey('gX'), 'AIza-roundtrip-key-123456');
    assert.equal(storeB.getPrompt('gX'), 'Regel: nett sein');
    assert.equal(storeB.getLogChannelId('gX'), 'c-log');
    assert.equal(storeB.getAntiDeleteEnabled('gX'), true, 'Anti-Delete-Flag überlebt Neustarts');
    assert.equal(storeB.getBuffer('gX').length, 0);
    assert.equal(storeB.getBatchMessages('gX', batch.id).length, 1);
    assert.equal(storeB.getBatchMessages('gX', batch.id)[0].seq, 1, 'IDs überleben Neustarts');
    assert.equal(storeB.getBatches('gX').length, 1);
    assert.equal(storeB.countPenaltiesSince('gX', 'u1', 20), 1);
  } finally {
    for (const f of [localFile, sharedFile]) {
      try { fs.rmSync(f, { force: true }); } catch {}
    }
  }
});

// ============================================================================
// 5. Collector: Sammel-Regeln & Discord-Formate → Klartext
// ============================================================================

function makeWorld() {
  const membersCache = new Map();
  const channelsCache = new Map();
  const messageMocks = new Map();
  const replies = [];

  const member = (id, { admin = false, name } = {}) => ({
    id,
    displayName: name || `Name${id}`,
    user: { username: `user${id}` },
    moderatable: true,
    timeouts: [],
    permissions: { has: (p) => admin && p === PermissionFlagsBits.Administrator },
    timeout: async function (ms, reason) {
      this.timeouts.push({ ms, reason });
    },
  });

  const guild = {
    id: 'g1',
    name: 'Test Server',
    members: {
      cache: membersCache,
      fetch: async (id) => {
        const m = membersCache.get(String(id));
        if (!m) throw new Error('Unbekanntes Mitglied');
        return m;
      },
    },
    channels: { cache: channelsCache },
    roles: { cache: new Map([['555555555555555555', { id: '555555555555555555', name: 'Moderator' }]]) },
  };

  const channel = {
    id: 'c1',
    name: 'allgemein',
    type: ChannelType.GuildText,
    guildId: 'g1',
    sent: [],
    messages: {
      fetch: async (id) => {
        const m = messageMocks.get(String(id));
        if (!m) throw new Error('Nachricht nicht gefunden');
        return m;
      },
    },
    send: async (p) => {
      channel.sent.push(p);
      return { id: `sent${channel.sent.length}` };
    },
  };
  channelsCache.set('c1', channel);
  channelsCache.set('444444444444444444', { id: '444444444444444444', name: 'allgemein', type: ChannelType.GuildText });

  const logChannel = {
    id: 'clog',
    name: 'sicherheit',
    type: ChannelType.GuildText,
    sent: [],
    send: async (p) => {
      logChannel.sent.push(p);
      return { id: `log${logChannel.sent.length}` };
    },
  };
  channelsCache.set('clog', logChannel);

  membersCache.set('111111111111111111', member('111111111111111111', { name: 'Max' }));
  membersCache.set('222222222222222222', member('222222222222222222', { name: 'Anna' }));
  membersCache.set('333333333333333333', member('333333333333333333', { admin: true, name: 'Admin' }));

  for (const id of ['m1', 'm2', 'm3', 'm4']) {
    messageMocks.set(id, {
      id,
      reply: async (p) => {
        replies.push({ target: id, payload: p });
      },
    });
  }

  const msg = (over = {}) => ({
    id: 'm1',
    guild,
    guildId: 'g1',
    channelId: 'c1',
    channel,
    author: { id: '111111111111111111', bot: false, username: 'user111' },
    member: membersCache.get('111111111111111111'),
    content: 'Hallo Welt',
    attachments: new Map(),
    createdTimestamp: Date.now(),
    webhookId: null,
    system: false,
    ...over,
  });

  return { guild, channel, logChannel, membersCache, messageMocks, replies, msg, member };
}

test('Security Bot: Sammel-Regeln (echte User, Admin-Immunität, nur Text)', async () => {
  const w = makeWorld();
  const ctx = { store: await makeStore(), logger: noopLogger, client: { user: { id: 'bot1' } } };

  assert.equal(await shouldCollect({ ctx, msg: w.msg({ content: 'hi' }) }), true, 'normale Nachricht');
  assert.equal(await shouldCollect({ ctx, msg: w.msg({ author: { id: 'u9', bot: true } }) }), false, 'Bot-Nachricht');
  assert.equal(await shouldCollect({ ctx, msg: w.msg({ webhookId: 'wh1' }) }), false, 'Webhook');
  assert.equal(await shouldCollect({ ctx, msg: w.msg({ content: '   ' }) }), false, 'ohne Text');
  // Admins werden als KONTEXT gesammelt, aber als isAdmin markiert (→ keine ID, nie moderierbar)
  const adminMsg = w.msg({ member: w.membersCache.get('333333333333333333'), author: { id: '333333333333333333' } });
  assert.equal(await shouldCollect({ ctx, msg: adminMsg }), true, 'Admin wird als Kontext gesammelt');
  assert.deepEqual(await classifyMessage({ ctx, msg: adminMsg }), { collect: true, isAdmin: true }, 'Admin als immun markiert');
  assert.deepEqual(await classifyMessage({ ctx, msg: w.msg({ content: 'hi' }) }), { collect: true, isAdmin: false }, 'normaler User');
  assert.equal(await shouldCollect({ ctx, msg: { ...w.msg(), guild: null } }), false, 'DMs werden ignoriert');
  assert.equal(await shouldCollect({ ctx, msg: w.msg({ author: { id: 'bot1', bot: false } }) }), false, 'eigene Nachrichten');
});

test('Security Bot: Discord-Formate werden für die KI aufgelöst', async () => {
  const w = makeWorld();
  const text = await humanizeContent(
    { guild: w.guild, attachments: new Map() },
    'Hey <@222222222222222222> und <@!111111111111111111>! Rolle: <@&555555555555555555> Kanal: <#444444444444444444> Emoji: <:pog:123456789012345678> Zeit: <t:1700000000:F>'
  );

  assert.ok(text.includes('Hey Anna und Max'), 'User-Mentions → Anzeigenamen');
  assert.ok(text.includes('Rolle: @Moderator'), 'Rollen-Mention → Rollenname');
  assert.ok(text.includes('Kanal: #allgemein'), 'Kanal-Mention → Kanalname');
  assert.ok(text.includes('Emoji: :pog:'), 'Custom-Emoji → Kurzname');
  assert.ok(text.includes('Zeit: 2023-11-14 22:13 UTC'), 'Timestamp → lesbares Datum');
  assert.ok(!text.includes('<@'), 'keine Discord-Mention-Syntax übrig');

  // Markdown wird escaped, damit Gemini Rohtext sieht
  const escaped = escapeDiscordMarkdown('**fett** _kursiv_ `code` ~~strike~~ | zitat\n> zeile');
  assert.ok(escaped.includes('\\*\\*fett\\*\\*'));
  assert.ok(escaped.includes('\\`code\\`'));
  assert.ok(escaped.includes('\\> zeile'), 'führendes > escaped (kein Schein-Zitat)');

  // Anhänge: Text bleibt, Hinweis wird angehängt
  const attachments = new Map([['a1', { contentType: 'image/png' }]]);
  const withAtt = await humanizeContent({ guild: w.guild, attachments }, 'Schau mal');
  assert.ok(withAtt.includes('Schau mal'));
  assert.ok(withAtt.includes('[Anhang war beigelegt'), 'Anhang-Hinweis vorhanden');
});

test('Security Bot: Collector speichert Nicknames, Mentions und Reply-Verlauf für Gemini', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-rich-context-123456');

  const target = w.membersCache.get('222222222222222222');
  target.displayName = '[Lvl 1] 𝔣';
  target.nickname = '[Lvl 1] 𝔣';
  target.user.globalName = '𝔣';
  target.user.username = 'ykkfat1';

  const author = w.membersCache.get('111111111111111111');
  author.displayName = 'PaySafe';
  author.nickname = 'PaySafe | Merta';
  author.user.globalName = 'Pay';
  author.user.username = 'paysafePrivat';

  w.messageMocks.set('orig', {
    id: 'orig',
    guild: w.guild,
    guildId: 'g1',
    channelId: 'c1',
    channel: w.channel,
    author: { id: '222222222222222222', bot: false, username: 'ykkfat1', globalName: '𝔣' },
    member: target,
    content: 'Bitte hört auf mich zu pingen',
    attachments: new Map(),
    createdTimestamp: Date.now() - 1000,
  });

  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };

  await handleIncoming({
    ctx,
    msg: w.msg({
      id: 'm-rich',
      author: { id: '111111111111111111', bot: false, username: 'paysafePrivat', globalName: 'Pay' },
      member: author,
      content: 'Kannst du bitte antworten <@222222222222222222>?',
      mentions: {
        users: new Map([['222222222222222222', { id: '222222222222222222', username: 'ykkfat1', globalName: '𝔣' }]]),
        members: new Map([['222222222222222222', target]]),
      },
      reference: { messageId: 'orig', channelId: 'c1', guildId: 'g1' },
    }),
  });

  const rec = store.getBuffer('g1')[0];
  assert.equal(rec.authorName, 'PaySafe');
  assert.equal(rec.authorMeta.serverNickname, 'PaySafe | Merta');
  assert.equal(rec.authorMeta.globalName, 'Pay');
  assert.equal(rec.authorMeta.username, 'paysafePrivat');
  assert.equal(rec.mentionsMeta[0].id, '222222222222222222');
  assert.equal(rec.mentionsMeta[0].serverNickname, '[Lvl 1] 𝔣');
  assert.equal(rec.mentionsMeta[0].username, 'ykkfat1');
  assert.equal(rec.replyMeta.messageId, 'orig');
  assert.equal(rec.replyMeta.author.username, 'ykkfat1');
  assert.ok(rec.replyMeta.content.includes('Bitte hört auf'), 'Reply-Text wurde gespeichert');
});

test('Security Bot: handleIncoming sammelt nur mit Key & stößt Batch bei Token-Limit aus', async () => {
  const w = makeWorld();
  const store = await makeStore();
  const dispatches = [];
  const moderatorPath = require.resolve('../bots/security-bot/src/moderator');
  const realModerator = require(moderatorPath);
  require.cache[moderatorPath] = {
    id: moderatorPath,
    filename: moderatorPath,
    loaded: true,
    exports: { ...realModerator, processGuild: async (ctx, gid) => dispatches.push(gid) },
  };

  try {
    const ctx = {
      store,
      logger: noopLogger,
      env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
      client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
    };

    // Ohne API-Key: nichts sammeln
    await handleIncoming({ ctx, msg: w.msg() });
    assert.equal(store.getBuffer('g1').length, 0, 'ohne Key wird nichts gespeichert');

    // Mit Key: Nachricht landet im Buffer, noch kein Batch
    store.setApiKey('g1', 'AIza-key-1234567890abcdef');
    await handleIncoming({ ctx, msg: w.msg({ id: 'm1', content: 'Erste Nachricht' }) });
    assert.equal(store.getBuffer('g1').length, 1);
    assert.equal(dispatches.length, 0);

    // Token-Limit klein stellen (min. 2000) -> genug lange Nachrichten sammeln
    const origEnv = ctx.env;
    ctx.env = (k, fb = '') => (k === 'SECURITY_GEMINI_MAX_INPUT_TOKENS' ? '2000' : origEnv(k, fb));

    // 4 weitere Nachrichten à ~1500 Zeichen → über 2000 Tokens (3 Zeichen/Token)
    for (let i = 0; i < 4; i++) {
      await handleIncoming({
        ctx,
        msg: w.msg({ id: `mx${i}`, content: 'x'.repeat(1500), author: { id: '222222222222222222', bot: false } }),
      });
    }
    assert.equal(dispatches.length, 1, 'Token-Limit hat genau einen Batch ausgelöst');
    assert.equal(store.getBuffer('g1').length, 0, 'Buffer in den Batch umgezogen');
    assert.equal(store.getBatches('g1').length, 1);
    const batch = store.getBatches('g1')[0];
    const msgs = store.getBatchMessages('g1', batch.id);
    assert.equal(msgs.length, 5);
    assert.equal(msgs[0].seq, 1, 'Batch-IDs starten bei 1');
  } finally {
    require.cache[moderatorPath] = {
      id: moderatorPath,
      filename: moderatorPath,
      loaded: true,
      exports: realModerator,
    };
  }
});

// ============================================================================
// 6. Gemini-Client
// ============================================================================

test('Security Bot: Gemini-Request (Struktur, Header, günstigstes Modell)', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"moderations":[]}' }] } }] }),
    };
  };

  const res = await callGemini({
    apiKey: 'AIza-test',
    systemPrompt: 'SYSTEM',
    userPrompt: 'USER',
    env: () => '',
    fetchFn,
    sleepFn: async () => {},
  });

  assert.equal(res.ok, true);
  assert.equal(res.model, DEFAULT_GEMINI_MODEL);
  assert.ok(
    calls[0].url.includes(`/models/${DEFAULT_GEMINI_MODEL}:generateContent`),
    'URL nutzt das Standard-Modell'
  );
  assert.equal(calls[0].options.headers['x-goog-api-key'], 'AIza-test');
  assert.equal(calls[0].body.systemInstruction.parts[0].text, 'SYSTEM');
  assert.equal(calls[0].body.contents[0].role, 'user');
  assert.equal(calls[0].body.contents[0].parts[0].text, 'USER');
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
  assert.ok(calls[0].body.generationConfig.responseSchema, 'responseSchema erzwingt JSON-Struktur');
  assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.ok(
    calls[0].body.safetySettings.every((s) => s.threshold === 'BLOCK_NONE'),
    'Safety-Filter sind aus – der Moderator muss Toxizität lesen können'
  );
  assert.equal(estimateTokens('a'.repeat(30)), 10, 'Grobe Schätzung: 3 Zeichen/Token');
  assert.equal(modelFromEnv(() => 'gemini-2.0-flash'), 'gemini-2.0-flash');
  assert.equal(modelFromEnv(() => ''), DEFAULT_GEMINI_MODEL);

  // 429 → kurzer Sofort-Retry
  let n = 0;
  const retryFetch = async () => {
    n++;
    if (n === 1) return { ok: false, status: 429, text: async () => '{"error":{"message":"rate limited"}}' };
    return geminiJsonResponse({ moderations: [] });
  };
  const retryRes = await callGemini({ apiKey: 'k', systemPrompt: 's', userPrompt: 'u', fetchFn: retryFetch, sleepFn: async () => {} });
  assert.equal(retryRes.ok, true);
  assert.equal(n, 2, '429 wird sofort einmal wiederholt');

  // 400 mit optionalen Feldern → Fallback-Kaskade ohne responseSchema/thinking/safety
  let bodies = [];
  const fallbackFetch = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) return { ok: false, status: 400, text: async () => '{"error":{"message":"Unknown name thinkingConfig"}}' };
    return geminiJsonResponse({ moderations: [] });
  };
  const fallbackRes = await callGemini({ apiKey: 'k', systemPrompt: 's', userPrompt: 'u', fetchFn: fallbackFetch, sleepFn: async () => {} });
  assert.equal(fallbackRes.ok, true);
  assert.equal(bodies[1].generationConfig.responseSchema, undefined);
  assert.equal(bodies[1].generationConfig.thinkingConfig, undefined);
  assert.equal(bodies[1].safetySettings, undefined);

  // Fatale Keys werden klar gemeldet
  assert.deepEqual(await callGemini({ systemPrompt: 's', userPrompt: 'u' }), { ok: false, error: 'missing_api_key' });
});

test('Security Bot: validateApiKey & JSON-Parsing der Modell-Antwort', async () => {
  const okFetch = async () => ({ ok: true, json: async () => ({ models: [] }) });
  assert.deepEqual(await validateApiKey({ apiKey: 'gut', fetchFn: okFetch }), { ok: true });

  const badFetch = async () => ({ ok: false, status: 400, text: async () => '{"error":{"message":"API key not valid"}}' });
  const bad = await validateApiKey({ apiKey: 'schlecht', fetchFn: badFetch });
  assert.equal(bad.ok, false);
  assert.equal(bad.fatal, true);
  assert.match(bad.error, /API key not valid/);

  // Parsing: normal, fenced, array, invalide Dauern
  const parsed = parseModerationJson('{"moderations":[{"message_id":3,"action":"timeout","duration":"7x","primary":true,"reason":"r","personal_message":"m"},{"message_id":"4","action":"warn","duration":"1h","primary":false,"reason":"r2","personal_message":"m2"}],"chat_reply":"Nice chat"}');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.moderations.length, 2);
  assert.equal(parsed.moderations[0].duration, '1h', 'ungültige Dauer fällt auf 1h zurück');
  assert.equal(parsed.moderations[1].action, 'warn');
  assert.equal(parsed.moderations[1].duration, null, 'warn hat keine Dauer');
  assert.equal(parsed.chat_reply, undefined, 'chat_reply existiert nicht mehr und wird ignoriert');

  const fenced = parseModerationJson('```json\n{"moderations":[]}\n```');
  assert.equal(fenced.ok, true);
  const arr = parseModerationJson('[{"message_id":1,"action":"warn","reason":"r","personal_message":"m"}]');
  assert.equal(arr.ok, true);
  assert.equal(arr.moderations.length, 1);

  assert.equal(parseModerationJson('kein json').ok, false);
  assert.equal(parseModerationJson('{"foo":1}').ok, false);
  assert.equal(parseModerationJson('').ok, false);

  assert.equal(
    extractResponseText({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }),
    'ab'
  );
});

// ============================================================================
// 7. Prompts: System-Prompt, User-Prompt & Chat-Verlauf-Format
// ============================================================================

test('Security Bot: System-Prompt enthält Register, Format & {USER}-Regel', () => {
  const penaltyByUser = new Map([['u1', { count: 2, lastAt: Date.now() - 86400e3, lastAction: 'timeout' }]]);
  const sp = buildSystemPrompt({
    guildName: 'Kekse Server',
    lang: 'de',
    participants: [
      { authorId: 'u1', authorName: 'Max' },
      { authorId: 'u2', authorName: 'Anna' },
    ],
    penaltyByUser,
  });

  assert.ok(sp.includes('Kekse Server'));
  assert.ok(sp.includes('Max (user_id=u1): 2 Moderation(en)'), 'Strafenregister sichtbar');
  assert.ok(sp.includes('Anna (user_id=u2): sauber'), 'saubere Nutzer sichtbar');
  assert.ok(sp.includes('{USER}'), 'Platzhalter-Regel erklärt');
  assert.ok(sp.includes('primary'), 'Primary-Regel erklärt');
  assert.ok(sp.includes('1m'), 'Timeout-Stufen erklärt');
  assert.ok(sp.includes('Administratoren'), 'Admin-Immunität erklärt');
  assert.ok(sp.includes('moderations'), 'JSON-Format erklärt');
  assert.ok(sp.includes('Deutsch'), 'Antwortsprache vorgegeben');
  assert.ok(sp.includes('MOBBING, DOGPILING'), 'Mobbing/Dogpiling wird explizit geprüft');
  assert.ok(sp.includes('Witze unter Freunden'), 'Joke-/Sarkasmus-Schutz bleibt erhalten');
  assert.ok(/wiederholte[ms]? (Anpingen|Pingen)/i.test(sp), 'wiederholte Mentions/Pings werden als Kontext genannt');
  assert.ok(sp.includes('server_nick'), 'Nickname-/Namensfelder werden erklärt');
  assert.ok(sp.includes('AUSFÜHRLICH'), 'personal_message muss ausführlich begründet werden');
  assert.ok(!sp.includes('ZWINGENDE MODERATION'), 'ohne forceUser keine Zwangsdirektive');
});

test('Security Bot: System-Prompt mit forceUser enthält die Zwangsmoderations-Direktive', () => {
  const sp = buildSystemPrompt({
    guildName: 'Knödel Server',
    lang: 'de',
    participants: [{ authorId: 'u9', authorName: 'Wega' }],
    penaltyByUser: new Map(),
    forceUser: { id: 'u9', name: 'Wega "Böse"\nZeile2' },
  });

  assert.ok(sp.includes('ZWINGENDE MODERATION'), 'Direktive vorhanden');
  assert.ok(sp.includes('user_id=u9'), 'Ziel-user_id im Prompt');
  assert.ok(sp.includes('MUSS'), 'verbindliche Formulierung');
  // Prompt-Injection über den Anzeigenamen wird entschärft: keine neue Zeile aus dem Namen
  assert.ok(!sp.split('\n').some((l) => l.startsWith('Zeile2')), 'Zeilenumbrüche im Namen werden entschärft');
  assert.ok(sp.includes('{USER}'), 'Format-Regeln bleiben erhalten');
  // Warnhinweis, dass milde Grenzfälle genügen & Befehl nicht erwähnt werden darf
  assert.ok(sp.includes('Grenzfälle'), 'milde Grenzfälle ausreichend');
  assert.ok(sp.includes('NICHT, dass die Moderation angeordnet wurde'), 'Anordnung bleibt intern');
});

test('Security Bot: Chat-Verlauf ist nach Kanälen gruppiert mit IDs ab 1', () => {
  const base = Date.now();
  const log = buildChatLog([
    { seq: 2, ord: base + 2, channelId: 'c1', channelName: 'allgemein', sentAt: base + 2, authorName: 'Max', authorId: 'u1', content: 'Zweite' },
    { seq: 1, ord: base + 1, channelId: 'c2', channelName: 'spam', sentAt: base + 1, authorName: 'Anna', authorId: 'u2', content: 'Erste' },
    { seq: 3, ord: base + 3, channelId: 'c1', channelName: 'allgemein', sentAt: base + 3, authorName: 'Max', authorId: 'u1', content: 'Zeile 1\nZeile 2' },
  ]);

  assert.ok(log.includes('KANAL: #allgemein'));
  assert.ok(log.includes('KANAL: #spam'));
  const c1Block = log.slice(log.indexOf('#allgemein'));
  assert.ok(c1Block.indexOf('[2]') < c1Block.indexOf('[3]'), 'innerhalb Kanals chronologisch');
  assert.ok(/\[1\] .* Anna \(user_id=u2\):\n\| Erste/.test(log), 'Header-Format mit ID, Zeit, Name, user_id');
  assert.ok(log.includes('| Zeile 1\n| Zeile 2'), 'mehrzeilige Nachrichten mit | -Präfix');

  const up = buildUserPrompt({ adminPrompt: 'SEI STRENG', logText: log });
  assert.ok(up.includes('SEI STRENG'), 'Admin-Prompt ist enthalten');
  assert.ok(up.includes('AUFGABE'), 'Arbeitsauftrag am Ende');
});

test('Security Bot: Chat-Verlauf enthält Reply-Kontext, Zielpersonen und echte Namensfelder', () => {
  const base = Date.parse('2026-09-16T18:00:00Z');
  const log = buildChatLog([
    {
      seq: 1,
      ord: base,
      channelId: 'c1',
      channelName: 'allgemein',
      sentAt: base,
      authorName: 'PaySafe',
      authorId: 'u-pay',
      authorMeta: { id: 'u-pay', displayName: 'PaySafe', serverNickname: 'PaySafe | Merta', globalName: 'Pay', username: 'paysafePrivat' },
      mentionsMeta: [{ id: 'u-target', displayName: '[Lvl 1] 𝔣', serverNickname: '[Lvl 1] 𝔣', globalName: '𝔣', username: 'ykkfat1' }],
      replyMeta: {
        messageId: 'orig-1',
        channelId: 'c1',
        author: { id: 'u-target', displayName: '[Lvl 1] 𝔣', serverNickname: '[Lvl 1] 𝔣', globalName: '𝔣', username: 'ykkfat1' },
        content: 'Bitte nicht weiter pingen.',
        createdAt: base - 1000,
      },
      content: '@[Lvl 1] 𝔣 antwort bitte',
    },
  ]);

  assert.ok(log.includes('Namen/Aliase'), 'Alias-Zeile vorhanden');
  assert.ok(log.includes('server_nick="PaySafe | Merta"'), 'Server-Nickname des Autors');
  assert.ok(log.includes('global_name="Pay"'), 'globaler Anzeigename des Autors');
  assert.ok(log.includes('username="paysafePrivat"'), 'Username des Autors');
  assert.ok(log.includes('Antwort auf: message_id=orig-1'), 'Reply-Referenz wird gesendet');
  assert.ok(log.includes('text="Bitte nicht weiter pingen."'), 'Reply-Textauszug wird gesendet');
  assert.ok(log.includes('Erwähnt/Zielpersonen: [Lvl 1] 𝔣 (user_id=u-target'), 'Mention-Ziel mit user_id sichtbar');
  assert.ok(log.includes('username="ykkfat1"'), 'private/globale Namensdaten des Ziels sichtbar');
});

// ============================================================================
// 8. Moderator-Pipeline: Aktionen, Antwort auf Hauptverstoß, Retries
// ============================================================================

function geminiJsonResponse(json) {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }),
  };
}

test('Security Bot: Pipeline wendet Timeout & Warnung an und antwortet auf den Hauptverstoß', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-pipeline-key-123456');
  store.setLogChannelId('g1', 'clog');
  store.setPrompt('g1', 'Keine Beleidigungen. Schwere Verstöße: Timeout.');

  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '222222222222222222', authorName: 'Anna', content: 'leichte Stichelei', discordMessageId: 'm1', sentAt: Date.now() - 2000 });
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '111111111111111111', authorName: 'Max', content: 'harte Beleidigung', discordMessageId: 'm2', sentAt: Date.now() - 1000 });
  const batch = store.buildBatchFromBuffer('g1');

  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };

  const apiCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    apiCalls.push({ url, body: JSON.parse(options.body) });
    return geminiJsonResponse({
      moderations: [
        { message_id: 1, action: 'warn', primary: false, reason: 'Leichte Stichelei', personal_message: 'Hey {USER}, bittebleib freundlich.' },
        { message_id: 2, action: 'timeout', duration: '5m', primary: true, reason: 'Schwere Beleidigung', personal_message: '{USER}, das war eine Beleidigung – 5 Minuten Pause.' },
      ],
      chat_reply: '',
    });
  };

  try {
    const ok = await processGuild(ctx, 'g1');
    assert.equal(ok, true);
    assert.equal(apiCalls.length, 1);

    // Request-Struktur: System-Prompt + Admin-Prompt + Verlauf mit IDs
    const body = apiCalls[0].body;
    assert.ok(body.systemInstruction.parts[0].text.includes('Test Server'));
    assert.ok(body.contents[0].parts[0].text.includes('Keine Beleidigungen'), 'Admin-Prompt gesendet');
    assert.ok(body.contents[0].parts[0].text.includes('[2]'), 'Verlauf mit IDs gesendet');

    // Timeout angewendet: 5 Minuten auf Max (message_id 2 → Max)
    const max = w.membersCache.get('111111111111111111');
    assert.equal(max.timeouts.length, 1, 'Timeout wurde angewendet');
    assert.equal(max.timeouts[0].ms, 5 * 60 * 1000);
    assert.match(max.timeouts[0].reason, /Schwere Beleidigung/);
    assert.equal(w.membersCache.get('222222222222222222').timeouts.length, 0, 'Warnung ohne Timeout');

    // Antworten: Primary zuerst, dann die Warnung – mit echter Erwähnung statt {USER}
    assert.equal(w.replies.length, 2);
    assert.equal(w.replies[0].target, 'm2', 'Primary-Antwort zuerst');
    assert.ok(w.replies[0].payload.content.includes('<@111111111111111111>'), '{USER} → echte Mention');
    assert.ok(!w.replies[0].payload.content.includes('{USER}'), 'kein Platzhalter übrig');
    assert.equal(w.replies[1].target, 'm1');
    assert.deepEqual(w.replies[1].payload.allowedMentions, { users: ['222222222222222222'], repliedUser: true });

    // Strafenregister: beide Verstöße gezählt
    assert.equal(store.countPenaltiesSince('g1', '111111111111111111', 20), 1);
    assert.equal(store.countPenaltiesSince('g1', '222222222222222222', 20), 1);

    // Batch komplett abgeräumt
    assert.equal(store.getBatches('g1').length, 0);
    assert.equal(store.countPendingMessages('g1'), 0);

    // Log-Kanal: 2 Moderations-Hinweise
    assert.equal(w.logChannel.sent.length, 2);
    for (const payload of w.logChannel.sent) {
      assert.equal(payload.flags & MessageFlags.IsComponentsV2, MessageFlags.IsComponentsV2);
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Security Bot: maximal 1 Timeout pro Person – weitere Timeouts werden zu Warnungen', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-pipeline-key-123456');
  store.setLogChannelId('g1', 'clog');

  // Zwei Verstöße DERSELBEN Person (Max) – Gemini will beide als Timeout.
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '111111111111111111', authorName: 'Max', content: 'Beleidigung A', discordMessageId: 'm1', sentAt: Date.now() - 2000 });
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '111111111111111111', authorName: 'Max', content: 'Beleidigung B', discordMessageId: 'm2', sentAt: Date.now() - 1000 });
  store.buildBatchFromBuffer('g1');

  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    geminiJsonResponse({
      moderations: [
        { message_id: 1, action: 'timeout', duration: '1h', primary: true, reason: 'Schwerer Verstoß', personal_message: '{USER}, 1 Stunde Pause.' },
        { message_id: 2, action: 'timeout', duration: '5m', primary: false, reason: 'Zweiter Verstoß', personal_message: '{USER}, nochmal aufgefallen.' },
      ],
      chat_reply: '',
    });
  try {
    assert.equal(await processGuild(ctx, 'g1'), true);

    const max = w.membersCache.get('111111111111111111');
    assert.equal(max.timeouts.length, 1, 'nur EIN Timeout trotz zwei Timeout-Wünschen');
    assert.equal(max.timeouts[0].ms, 1 * 60 * 60 * 1000, 'der schwerwiegendste (primary) Timeout bleibt');

    // Beide Nachrichten werden beantwortet (Timeout + herabgestufte Warnung)
    assert.equal(w.replies.length, 2, 'Timeout und herabgestufte Warnung antworten');

    // Strafenregister: 1 Timeout + 1 Warnung für dieselbe Person
    const pens = [...store._penalties.values()].filter((p) => p.userId === '111111111111111111');
    assert.equal(pens.length, 2, 'beide Verstöße im Register');
    assert.deepEqual(pens.map((p) => p.action).sort(), ['timeout', 'warn']);
    assert.ok(pens.some((p) => p.action === 'warn' && p.duration === null), 'zweiter Verstoß als Warnung ohne Dauer');

    assert.equal(w.logChannel.sent.length, 2, 'beide Moderationen im Log-Kanal');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Security Bot: ohne Verstoß bleibt der Bot komplett still (kein Small-Talk)', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-pipeline-key-123456');
  store.setLogChannelId('g1', 'clog');
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '111111111111111111', authorName: 'Max', content: 'Tschüss Leute!', discordMessageId: 'm1', sentAt: Date.now() });
  store.buildBatchFromBuffer('g1');

  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };

  // Selbst wenn das Modell (entgegen Schema & Prompt) Small-Talk liefert,
  // darf davon NICHTS im Chat landen – ein Sicherheitsbot moderiert nur.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    geminiJsonResponse({
      moderations: [],
      chat_reply: 'Hey zusammen! Hier ist alles entspannt, genießt euren Tag auf dem Server! 👋',
    });
  try {
    assert.equal(await processGuild(ctx, 'g1'), true);
    assert.equal(w.channel.sent.length, 0, 'kein einziger Post im Kanal');
    assert.equal(w.replies.length, 0, 'keine Antwort auf eine Nachricht');
    assert.equal(w.logChannel.sent.length, 0, 'auch nichts im Log-Kanal');
    assert.equal(store.countPenaltiesSince('g1', '111111111111111111', 20), 0, 'keine Strafe vermerkt');
    assert.equal(store.getBatches('g1').length, 0, 'Batch trotzdem sauber abgeschlossen');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Security Bot: RESPONSE_SCHEMA & Prompt lassen gar keine Chat-Antwort mehr zu', () => {
  // Das Schema kennt nur noch "moderations" – Gemini kann strukturell keinen
  // Small-Talk mehr zurückgeben.
  assert.deepEqual(Object.keys(RESPONSE_SCHEMA.properties), ['moderations']);
  assert.equal(RESPONSE_SCHEMA.properties.chat_reply, undefined);

  const sp = buildSystemPrompt({
    guildName: 'Kekse Server',
    lang: 'de',
    participants: [{ authorId: 'u1', authorName: 'Max' }],
    penaltyByUser: new Map(),
  });
  assert.ok(!sp.includes('chat_reply'), 'System-Prompt erwähnt chat_reply nicht mehr');
  assert.ok(sp.includes('MODERIEREN, NICHT CHATTEN'), 'klare Ansage: kein Chatten');
  assert.ok(sp.includes('{"moderations":[]}'), 'leeres Array als Nichts-zu-tun-Antwort');

  const up = buildUserPrompt({ adminPrompt: 'Regeln', logText: 'Verlauf' });
  assert.ok(!up.includes('chat_reply'));
  assert.ok(up.includes('{"moderations":[]}'), 'User-Prompt wiederholt die Stille-Regel');

  // Auch die Standard-Prompts aller Sprachen dürfen nicht mehr zum Plaudern einladen
  for (const lang of Object.keys(LANGS)) {
    assert.ok(
      !/locker im Chat antworten|casually in chat|brièvement dans le chat|brevemente en el chat|de boa no chat|ответить в чате|チャットで軽く短く返信|채팅으로 답하기|聊天中轻松地简短回复|leggerezza in chat/.test(
        t('defaultPrompt', lang)
      ),
      `defaultPrompt (${lang}) lädt nicht mehr zum Chatten ein`
    );
  }
});

test('Security Bot: Admin-Immunität greift auch beim Anwenden (Doppelabsicherung)', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-pipeline-key-123456');
  store.setLogChannelId('g1', 'clog');
  // Admin-Nachricht ohne isAdmin-Flag (z.B. Nutzer wurde NACH dem Sammeln Admin) –
  // hier wird der Live-Schutz im Moderator geprüft:
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '333333333333333333', authorName: 'Admin', content: 'admin text', discordMessageId: 'm1', sentAt: Date.now() });
  store.buildBatchFromBuffer('g1');

  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    geminiJsonResponse({
      moderations: [{ message_id: 1, action: 'timeout', duration: '1w', primary: true, reason: 'Verstoß', personal_message: '{USER} test' }],
    });
  try {
    assert.equal(await processGuild(ctx, 'g1'), true);
    assert.equal(w.membersCache.get('333333333333333333').timeouts.length, 0, 'Admin bekommt KEINEN Timeout');
    assert.equal(w.replies.length, 0, 'Admin wird nicht angesprochen');
    assert.equal(store.countPenaltiesSince('g1', '333333333333333333', 20), 0);
    assert.equal(w.logChannel.sent.length, 1, 'Übersprungen-Hinweis im Log');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Security Bot: Admin-Nachrichten sind Kontext ohne ID – im Batch, Log & Register, nie moderierbar', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-pipeline-key-123456');
  store.setLogChannelId('g1', 'clog');
  const base = Date.now();
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '333333333333333333', authorName: 'Admin', content: 'Wer ist dieser Idiot?', discordMessageId: 'a1', sentAt: base, isAdmin: true });
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '111111111111111111', authorName: 'Max', content: 'Der Idiot bin wohl ich', discordMessageId: 'm1', sentAt: base + 1 });
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '333333333333333333', authorName: 'Admin', content: 'Ruhe jetzt', discordMessageId: 'a2', sentAt: base + 2, isAdmin: true });
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '222222222222222222', authorName: 'Anna', content: 'ok', discordMessageId: 'm2', sentAt: base + 3 });
  const batch = store.buildBatchFromBuffer('g1');
  assert.equal(batch.size, 4);
  assert.equal(batch.moderatable, 2, 'nur 2 Nachrichten bekommen IDs');

  const msgs = store.getBatchMessages('g1', batch.id);
  assert.deepEqual(msgs.map((m) => m.seq), [null, 1, null, 2], 'IDs überspringen Admins, Reihenfolge bleibt chronologisch');

  const log = buildChatLog(msgs);
  assert.ok(log.includes('[ADMIN – immun]'), 'Admin ohne ID markiert');
  assert.ok(!/\[\d+\] .*Admin \(user_id=333333333333333333\)/.test(log), 'Admin hat keine numerische ID');
  assert.ok(log.indexOf('Wer ist dieser Idiot') < log.indexOf('[1]'), 'Admin-Kontext steht vor der Antwort');

  const sp = buildSystemPrompt({
    guildName: 'X', lang: 'de',
    participants: [{ authorId: '333333333333333333', authorName: 'Admin', isAdmin: true }, { authorId: '111111111111111111', authorName: 'Max' }],
    penaltyByUser: new Map(),
  });
  assert.ok(sp.includes('Admin (user_id=333333333333333333): IMMUN (Administrator)'), 'Register zeigt Admin als immun');
  assert.ok(sp.includes('Max (user_id=111111111111111111): sauber'));

  // Gemini versucht trotzdem, "message_id 3" (gibt es nicht) und ID 1 (Max) zu moderieren
  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };
  const origFetch = globalThis.fetch;
  let sentPrompt = '';
  globalThis.fetch = async (url, init) => {
    sentPrompt = JSON.parse(init.body).contents[0].parts[0].text;
    return geminiJsonResponse({
      moderations: [
        { message_id: 3, action: 'timeout', duration: '1d', primary: false, reason: 'x', personal_message: '{USER} x' },
        { message_id: 1, action: 'warn', primary: true, reason: 'Beleidigung', personal_message: '{USER} bitte nicht' },
      ],
    });
  };
  try {
    assert.equal(await processGuild(ctx, 'g1'), true);
    assert.ok(sentPrompt.includes('[ADMIN – immun]'), 'Admin-Kontext wurde an Gemini gesendet');
    assert.equal(w.membersCache.get('333333333333333333').timeouts.length, 0, 'Admin bekommt keinen Timeout');
    assert.equal(w.replies.length, 1, 'nur Max wird angesprochen');
    assert.ok(w.replies[0].payload.content.includes('<@111111111111111111>'));
    assert.equal(store.countPenaltiesSince('g1', '333333333333333333', 20), 0);
    assert.equal(store.countPenaltiesSince('g1', '111111111111111111', 20), 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Security Bot: Batch nur mit Admin-Nachrichten wird ohne API-Aufruf verworfen', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-pipeline-key-123456');
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '333333333333333333', authorName: 'Admin', content: 'nur admin', discordMessageId: 'a1', sentAt: Date.now(), isAdmin: true });
  store.buildBatchFromBuffer('g1');
  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };
  const origFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; return geminiJsonResponse({ moderations: [] }); };
  try {
    assert.equal(await processGuild(ctx, 'g1'), true);
    assert.equal(called, 0, 'kein Gemini-Aufruf');
    assert.equal(store.getBatches('g1').length, 0, 'Batch aufgeräumt');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Security Bot: API-Fehler verwirft NICHTS – Backoff, Retry, dann Erfolg', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-pipeline-key-123456');
  store.setLogChannelId('g1', 'clog');
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '111111111111111111', authorName: 'Max', content: 'Nachricht', discordMessageId: 'm1', sentAt: Date.now() });
  const batch = store.buildBatchFromBuffer('g1');

  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };

  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls <= 4) return { ok: false, status: 429, text: async () => '{"error":{"message":"Resource has been exhausted"}}' };
    return geminiJsonResponse({
      moderations: [{ message_id: 1, action: 'warn', primary: true, reason: 'Spam', personal_message: '{USER} bitte weniger spammen.' }],
    });
  };

  try {
    // Versuch 1: schlägt fehl
    assert.equal(await processGuild(ctx, 'g1'), false);
    let meta = store.getBatches('g1')[0];
    assert.equal(meta.id, batch.id, 'Batch bleibt erhalten');
    assert.equal(meta.retryCount, 1);
    assert.ok(meta.nextRetryAt > Date.now(), 'Backoff gesetzt');
    assert.equal(store.getBatchMessages('g1', batch.id).length, 1, 'Nachrichten NICHT verworfen');
    assert.equal(w.logChannel.sent.length, 1, 'Fehler im Log-Kanal gemeldet');

    // Währenddessen sammeln sich neue Nachrichten ganz normal im Buffer
    store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '222222222222222222', authorName: 'Anna', content: 'neue Nachricht während des Fehlers', discordMessageId: 'm2', sentAt: Date.now() });
    assert.equal(store.getBuffer('g1').length, 1);

    // Versuch 2 vor Ablauf des Backoffs: wird übersprungen (interne Sofort-Retries haben schon 2 Calls gemacht)
    assert.equal(await processGuild(ctx, 'g1'), false);
    assert.equal(calls, 2, 'kein API-Call vor nextRetryAt');

    // Backoff ablaufen lassen → Versuch 2 schlägt wieder fehl → zweiter Log-Eintrag
    meta.nextRetryAt = Date.now() - 1;
    store.setBatches('g1', store.getBatches('g1'));
    assert.equal(await processGuild(ctx, 'g1'), false);
    assert.equal(calls, 4);
    assert.equal(store.getBatches('g1')[0].retryCount, 2);

    // Backoff ablaufen lassen → Versuch 3 klappt → Batch abgeschlossen
    store.getBatches('g1')[0].nextRetryAt = Date.now() - 1;
    store.setBatches('g1', store.getBatches('g1'));
    assert.equal(await processGuild(ctx, 'g1'), true);
    assert.equal(w.replies.length, 1);
    assert.equal(store.getBatches('g1').length, 0, 'erfolgreicher Batch ist weg');
    // Der Buffer mit der neuen Nachricht ist unberührt geblieben:
    assert.equal(store.getBuffer('g1').length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Security Bot: Kaputte Modell-Antwort wird wie ein API-Fehler wiederholt', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-pipeline-key-123456');
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '111111111111111111', authorName: 'Max', content: 'hi', discordMessageId: 'm1', sentAt: Date.now() });
  store.buildBatchFromBuffer('g1');

  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };

  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Ich bin kein JSON' }] } }] }) };
  };
  try {
    assert.equal(await processGuild(ctx, 'g1'), false);
    assert.equal(store.getBatches('g1')[0].retryCount, 1);
    assert.match(store.getBatches('g1')[0].lastError, /invalid_model_response/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Security Bot: Ohne Key wartet der Batch geduldig (kein Verwerfen)', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '111111111111111111', authorName: 'Max', content: 'hi', discordMessageId: 'm1', sentAt: Date.now() });
  store.buildBatchFromBuffer('g1');

  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };

  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('darf nicht aufgerufen werden');
  };
  try {
    assert.equal(await processGuild(ctx, 'g1'), false);
    assert.equal(calls, 0, 'kein API-Call ohne Key');
    assert.equal(store.getBatches('g1').length, 1, 'Batch bleibt liegen');
    assert.equal(store.getBatches('g1')[0].keyNoticeSent, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Security Bot: Backoff-Plan & personal_message-Platzhalter', () => {
  assert.equal(BACKOFF_SCHEDULE_MS[0], 2 * 60_000, 'erster Retry nach 2 Minuten');
  assert.equal(nextRetryDelay(1), 2 * 60_000);
  assert.equal(nextRetryDelay(2), 5 * 60_000);
  assert.equal(nextRetryDelay(4), 30 * 60_000);
  assert.equal(nextRetryDelay(99), 6 * 60 * 60_000, 'maximal 6 Stunden');

  const mod = { personal_message: 'Hey {USER}, [USER] und @user, denk an die Regeln! Grüße, {NAME}' };
  const text = personalMessageText(mod, 'u42', 'Max');
  assert.ok(text.includes('<@u42>'));
  assert.ok(!/\{\s*USER\s*\}/i.test(text));
  assert.ok(text.includes('Max'));

  const without = personalMessageText({ personal_message: 'Bitte benimm dich.' }, 'u42', 'Max');
  assert.ok(without.startsWith('<@u42>'), 'fehlende Erwähnung wird ergänzt');
});

test('Security Bot: flushBuffer baut Batch und startet Analyse', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-flushbuffer-key-123456');
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '111111111111111111', authorName: 'Max', content: 'hi', discordMessageId: 'm1', sentAt: Date.now() });

  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => geminiJsonResponse({ moderations: [] });
  try {
    const batch = flushBuffer(ctx, 'g1');
    assert.ok(batch, 'Batch wurde gebaut');
    assert.equal(store.getBuffer('g1').length, 0);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.getBatches('g1').length, 0, 'Batch wurde direkt verarbeitet');
    assert.equal(flushBuffer(ctx, 'g2'), null, 'leerer Buffer -> kein Batch');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ============================================================================
// 9. Scheduler: 2-Stunden-Flush & Retry-Tick
// ============================================================================

test('Security Bot: Adaptive Batch-Policy erkennt Risiko, Dogpiling und kurze Wartezeiten', () => {
  const now = Date.parse('2026-09-16T18:00:00Z');
  const env = (k, fb = '') => ({
    SECURITY_GEMINI_SOFT_MAX_MESSAGES: '50',
    SECURITY_GEMINI_SOFT_INPUT_TOKENS: '999999',
    SECURITY_GEMINI_MAX_BUFFER_AGE_MS: '300000',
    SECURITY_GEMINI_QUIET_FLUSH_MS: '60000',
    SECURITY_GEMINI_QUIET_MIN_MESSAGES: '3',
  }[k] || fb);

  assert.ok(riskSignalsForMessage({ content: 'Fatima.rip' }).includes('death_or_rip_language'));
  assert.equal(shouldFlushBuffer({ buffer: [{ content: 'harmloser Witz', sentAt: now }], env, now }).flush, false, 'ein harmloser Joke triggert nicht sofort');
  assert.equal(shouldFlushBuffer({ buffer: [{ content: 'Fatima.rip', sentAt: now }], env, now }).urgent, true, 'RIP/Todessprache triggert schnelle Analyse');

  const dogpile = [
    { authorId: 'u1', sentAt: now - 20_000, content: 'ping 1', mentionsMeta: [{ id: 'victim', displayName: 'Ziel' }] },
    { authorId: 'u2', sentAt: now - 10_000, content: 'ping 2', mentionsMeta: [{ id: 'victim', displayName: 'Ziel' }] },
  ];
  assert.equal(mentionPressureSignal(dogpile, now, { mentionWindowMs: 600_000, mentionRepeatLimit: 3, multiAuthorMentionLimit: 2 })?.reason, 'multi_author_mentions');
  assert.equal(shouldFlushBuffer({ buffer: dogpile, env, now }).urgent, true, 'mehrere Autoren gegen dasselbe Ziel flushen sofort');

  const quiet = [
    { content: 'a', sentAt: now - 120_000 },
    { content: 'b', sentAt: now - 110_000 },
    { content: 'c', sentAt: now - 100_000 },
  ];
  assert.match(shouldFlushBuffer({ buffer: quiet, env, now }).reason, /quiet_window/, 'kleine ruhige Verläufe warten nicht stundenlang');
});

test('Security Bot: Lokaler Gemini-Rate-Limiter respektiert RPM und Retry-After', () => {
  const now = Date.parse('2026-09-16T18:00:00Z');
  const ctx = { env: (k, fb = '') => ({ SECURITY_GEMINI_RPM_LIMIT: '2', SECURITY_GEMINI_RPD_LIMIT: '100', SECURITY_GEMINI_RPD_RESERVE: '0' }[k] || fb) };
  const key = 'AIza-rate-limit-key';

  assert.equal(rateLimitConfig(ctx.env).rpmLimit, 2);
  assert.equal(reserveGeminiSlot({ ctx, apiKey: key, now }).allowed, true);
  assert.equal(reserveGeminiSlot({ ctx, apiKey: key, now: now + 1 }).allowed, true);
  const denied = reserveGeminiSlot({ ctx, apiKey: key, now: now + 2 });
  assert.equal(denied.allowed, false, 'dritter Request innerhalb einer Minute wird lokal zurückgestellt');
  assert.ok(denied.waitMs > 0 && denied.waitMs <= 60_000);

  const ctxTpm = { env: (k, fb = '') => ({ SECURITY_GEMINI_RPM_LIMIT: '99', SECURITY_GEMINI_TPM_LIMIT: '1000', SECURITY_GEMINI_RPD_LIMIT: '1000', SECURITY_GEMINI_RPD_RESERVE: '0' }[k] || fb) };
  assert.equal(reserveGeminiSlot({ ctx: ctxTpm, apiKey: key, now, estimatedTokens: 800 }).allowed, true);
  const tpmDenied = reserveGeminiSlot({ ctx: ctxTpm, apiKey: key, now: now + 1, estimatedTokens: 300 });
  assert.equal(tpmDenied.allowed, false, 'TPM-Budget wird lokal respektiert');
  assert.ok(tpmDenied.waitMs > 0 && tpmDenied.waitMs <= 60_000);

  const ctx429 = { env: (k, fb = '') => ({ SECURITY_GEMINI_RPM_LIMIT: '99', SECURITY_GEMINI_RPD_LIMIT: '1000', SECURITY_GEMINI_RPD_RESERVE: '0' }[k] || fb) };
  assert.equal(reserveGeminiSlot({ ctx: ctx429, apiKey: key, now }).allowed, true);
  noteGemini429({ ctx: ctx429, apiKey: key, now, retryAfterMs: 12_000 });
  const after429 = reserveGeminiSlot({ ctx: ctx429, apiKey: key, now: now + 1000 });
  assert.equal(after429.allowed, false, 'Retry-After erzeugt lokalen Cooldown');
  assert.ok(after429.waitMs >= 10_000);
});

test('Security Bot: Scheduler flusht kleine Verläufe adaptiv vor dem 2-Stunden-Slot', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-scheduler-fast-123456');
  const now = Date.now();
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '111111111111111111', authorName: 'Max', content: 'erste Nachricht', discordMessageId: 'm1', sentAt: now - 120_000 });
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '222222222222222222', authorName: 'Anna', content: 'zweite Nachricht', discordMessageId: 'm2', sentAt: now - 110_000 });

  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => ({
      SECURITY_STORE_DISABLE_FILE_BACKUP: 'true',
      SECURITY_GEMINI_QUIET_FLUSH_MS: '60000',
      SECURITY_GEMINI_QUIET_MIN_MESSAGES: '2',
      SECURITY_GEMINI_SOFT_MAX_MESSAGES: '50',
      SECURITY_GEMINI_SOFT_INPUT_TOKENS: '999999',
    }[k] || fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
    schedulerState: { lastSlotByGuild: new Map([['g1', slotKeyInTz(new Date(now), 'Europe/Berlin')]]), lastPrune: now },
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => geminiJsonResponse({ moderations: [] });
  try {
    const flushed = tickOnce(ctx, now);
    assert.equal(flushed, 1, 'adaptiver Flush trotz gleichem 2-Stunden-Slot');
    assert.equal(store.getBuffer('g1').length, 0, 'Buffer wurde geleert');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.getBatches('g1').length, 0, 'Batch wurde analysiert und abgeschlossen');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Security Bot: 2-Stunden-Flush bleibt als Sicherheitsnetz erhalten', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-scheduler-key-123456');
  store.addBufferMessage('g1', { channelId: 'c1', channelName: 'allgemein', authorId: '111111111111111111', authorName: 'Max', content: 'kurz vor dem Flush', discordMessageId: 'm1', sentAt: Date.now() });

  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
    // Der zuletzt gesehene Slot liegt in der Vergangenheit -> neuer Slot angebrochen
    schedulerState: { lastSlotByGuild: new Map([['g1', '2000-01-01#0']]), lastPrune: Date.now() },
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => geminiJsonResponse({ moderations: [] });
  try {
    const flushed = tickOnce(ctx);
    assert.equal(flushed, 1, 'genau ein 2-Stunden-Flush');
    assert.equal(store.getBuffer('g1').length, 0, 'Buffer wurde im neuen Slot geleert');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.getBatches('g1').length, 0, 'kleiner Verlauf wurde analysiert');

    // Zweiter Tick im selben Slot: kein erneuter Flush
    const flushedAgain = tickOnce(ctx);
    assert.equal(flushedAgain, 0);

    // Zeitzonen-Umschaltung: 23:59 UTC ist in Berlin schon der nächste Tag
    assert.equal(dayKeyInTz(new Date('2026-09-10T23:59:00Z'), 'Europe/Berlin'), '2026-09-11');
    assert.equal(dayKeyInTz(new Date('2026-09-10T12:00:00Z'), 'Europe/Berlin'), '2026-09-10');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Security Bot: Slot-Raster deckt 0 Uhr und jede zweite Stunde ab', () => {
  assert.equal(FLUSH_INTERVAL_HOURS, 2, 'Flush-Intervall beträgt 2 Stunden');

  // Stunden korrekt in der Gilden-Zeitzone (Berlin = UTC+2 im September)
  assert.equal(hourInTz(new Date('2026-09-11T00:30:00Z'), 'Europe/Berlin'), 2);
  assert.equal(hourInTz(new Date('2026-09-10T22:30:00Z'), 'Europe/Berlin'), 0, 'Mitternacht ist Stunde 0');

  const tz = 'Europe/Berlin';
  // Mitternacht Berlin = Slot 0 des neuen Tages -> der alte 0-Uhr-Flush bleibt erhalten
  assert.equal(slotKeyInTz(new Date('2026-09-10T22:05:00Z'), tz), '2026-09-11#0');
  // 23:59 Berlin (= 21:59 UTC) liegt noch im letzten Slot des Vortags
  assert.equal(slotKeyInTz(new Date('2026-09-10T21:59:00Z'), tz), '2026-09-10#11');

  // Über 24 Stunden entstehen genau 12 Slots, und der Schlüssel wechselt
  // spätestens alle 2 Stunden.
  const slots = new Set();
  for (let h = 0; h < 24; h++) {
    slots.add(slotKeyInTz(new Date(Date.UTC(2026, 0, 15, h) - 60 * 60 * 1000), tz));
  }
  assert.equal(slots.size, 12, '12 Auswertungen pro Tag statt nur einer');
});

test('Security Bot: verpasster Slot nach Neustart wird sofort nachgeholt', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-scheduler-restart-123456');

  const now = Date.now();
  // Nachricht liegt schon 3 Stunden im Buffer – der Slot-Wechsel wurde also
  // während eines Neustarts/Deploys verpasst.
  store.addBufferMessage('g1', {
    channelId: 'c1',
    channelName: 'allgemein',
    authorId: '111111111111111111',
    authorName: 'Max',
    content: 'liegt schon ewig im Buffer',
    discordMessageId: 'm1',
    sentAt: now - 3 * 60 * 60 * 1000,
  });

  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
    // Frischer Prozess: schedulerState ist leer, es gibt keinen "letzten Slot"
    schedulerState: null,
  };

  assert.equal(oldestBufferedAt(ctx, 'g1'), now - 3 * 60 * 60 * 1000);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => geminiJsonResponse({ moderations: [] });
  try {
    assert.equal(tickOnce(ctx, now), 1, 'überfälliger Buffer wird sofort ausgewertet');
    assert.equal(store.getBuffer('g1').length, 0);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.getBatches('g1').length, 0);

    // Frische Nachricht im selben Slot -> kein sofortiger Flush mehr
    store.addBufferMessage('g1', {
      channelId: 'c1', channelName: 'allgemein', authorId: '111111111111111111',
      authorName: 'Max', content: 'ganz frisch', discordMessageId: 'm2', sentAt: now,
    });
    assert.equal(tickOnce(ctx, now), 0, 'frischer Buffer wartet auf seinen Slot');
    assert.equal(store.getBuffer('g1').length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ============================================================================
// 10. Interactions & Command-Handler
// ============================================================================

function adminInteraction(over = {}) {
  return {
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    inGuild: () => true,
    guildId: 'g1',
    locale: 'de',
    user: { id: 'admin1' },
    memberPermissions: { has: (p) => p === PermissionFlagsBits.Administrator },
    options: { getString: () => null, getChannel: () => null },
    deferReply: async () => {},
    editReply: async (p) => p,
    reply: async (p) => p,
    showModal: async (m) => m,
    ...over,
  };
}

test('Security Bot: /set_gemini_api_key (setzen, ungültig, remove, unverändert)', async () => {
  const store = await makeStore();
  const ctx = { store, logger: noopLogger, env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb) };

  const origFetch = globalThis.fetch;
  try {
    // 1) Gültiger Key wird gespeichert
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [] }) });
    await handleChatInput(ctx, adminInteraction({
      commandName: 'set_gemini_api_key',
      options: { getString: () => 'AIzaSyD-new-valid-key-1234567890' },
    }));
    assert.equal(store.getApiKey('g1'), 'AIzaSyD-new-valid-key-1234567890');

    // 2) Ungültiger Key (Google lehnt ab) wird NICHT gespeichert
    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => '{"error":{"message":"API key not valid"}}' });
    await handleChatInput(ctx, adminInteraction({
      commandName: 'set_gemini_api_key',
      options: { getString: () => 'AIzaSyD-invalid-key-000000000000000' },
    }));
    assert.equal(store.getApiKey('g1'), 'AIzaSyD-new-valid-key-1234567890');

    // 3) Maskierter unveränderter Key -> beibehalten
    const masked = maskApiKey(store.getApiKey('g1'));
    await handleChatInput(ctx, adminInteraction({
      commandName: 'set_gemini_api_key',
      options: { getString: () => masked },
    }));
    assert.equal(store.getApiKey('g1'), 'AIzaSyD-new-valid-key-1234567890');

    // 4) "remove" löscht
    await handleChatInput(ctx, adminInteraction({
      commandName: 'set_gemini_api_key',
      options: { getString: () => 'remove' },
    }));
    assert.equal(store.getApiKey('g1'), null);
  } finally {
    globalThis.fetch = origFetch;
  }

  // Nicht-Admin wird abgewiesen
  const denied = await handleChatInput(ctx, adminInteraction({
    commandName: 'set_gemini_api_key',
    memberPermissions: { has: () => false },
    options: { getString: () => 'AIzaSyD-some-key-123456789012345' },
  }));
  assert.ok(denied);
});

test('Security Bot: /set_prompt öffnet Formular mit letztem/Standard-Prompt', async () => {
  const store = await makeStore();
  const ctx = { store, logger: noopLogger, env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb) };

  // 1) Ohne gespeicherten Prompt: Standardtext vorbelegt
  let shownModal = null;
  await handleChatInput(ctx, adminInteraction({
    commandName: 'set_prompt',
    showModal: async (m) => { shownModal = m; },
  }));
  assert.ok(shownModal, 'Modal wurde geöffnet');
  assert.equal(shownModal.data.custom_id, 'secgem_modal_prompt');
  const presetJson = shownModal.toJSON();
  assert.equal(presetJson.components[0].components[0].value, t('defaultPrompt', 'de'), 'Standardtext ist eingetragen');
  assert.equal(presetJson.components[0].components[0].custom_id, 'secgem_input_prompt');

  // 2) Modal absenden: Prompt wird gespeichert
  await handleInteraction(ctx, adminInteraction({
    isModalSubmit: () => true,
    customId: 'secgem_modal_prompt',
    fields: { getTextInputValue: () => '  Sei gnadenlos streng bei Hate.  ' },
  }));
  assert.equal(store.getPrompt('g1'), 'Sei gnadenlos streng bei Hate.');

  // 3) Nochmal öffnen: letzter Prompt ist vorbelegt
  shownModal = null;
  await handleChatInput(ctx, adminInteraction({
    commandName: 'set_prompt',
    showModal: async (m) => { shownModal = m; },
  }));
  assert.equal(shownModal.toJSON().components[0].components[0].value, 'Sei gnadenlos streng bei Hate.');

  // 4) Leeres Formular -> Zurücksetzen auf Standard
  await handleInteraction(ctx, adminInteraction({
    isModalSubmit: () => true,
    customId: 'secgem_modal_prompt',
    fields: { getTextInputValue: () => '   ' },
  }));
  assert.equal(store.getPrompt('g1'), null);

  // Nicht-Admin darf das Formular nicht öffnen
  let opened = false;
  await handleChatInput(ctx, adminInteraction({
    commandName: 'set_prompt',
    memberPermissions: { has: () => false },
    showModal: async () => { opened = true; },
  }));
  assert.equal(opened, false);
});

test('Security Bot: /set_log_channel & /set_language & /help', async () => {
  const store = await makeStore();
  const ctx = { store, logger: noopLogger, env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb), commandIds: {}, guildCommandIds: new Map() };

  // Log-Kanal setzen
  await handleChatInput(ctx, adminInteraction({
    commandName: 'set_log_channel',
    options: { getChannel: () => ({ id: 'c99' }) },
  }));
  assert.equal(store.getLogChannelId('g1'), 'c99');

  // Ohne Kanal -> entfernen
  await handleChatInput(ctx, adminInteraction({ commandName: 'set_log_channel' }));
  assert.equal(store.getLogChannelId('g1'), null);

  // Sprache setzen
  await handleChatInput(ctx, adminInteraction({
    commandName: 'set_language',
    options: { getString: () => 'en' },
  }));
  assert.equal(store.getLanguage('g1'), 'en');

  // /help antwortet mit Container & klickbaren Mentions
  let helpPayload = null;
  await handleChatInput(ctx, adminInteraction({
    commandName: 'set_help_x', // fällt in default -> würde unbekannt antworten; stattdessen korrekt:
  })).catch(() => {});
  const helpInteraction = adminInteraction({
    commandName: 'help',
    reply: async (p) => { helpPayload = p; },
  });
  ctx.commandIds = { set_gemini_api_key: '1', set_prompt: '2', set_log_channel: '3', set_language: '4', help: '5' };
  await handleChatInput(ctx, helpInteraction);
  assert.ok(helpPayload);
  assert.ok(JSON.stringify(helpPayload).includes('set_prompt'), 'help nennt /set_prompt');

  // Unbekannter Command -> freundliche Antwort, kein Crash
  const unknownReply = await handleChatInput(ctx, adminInteraction({ commandName: 'does_not_exist' }));
  assert.ok(unknownReply);

  // commandMention-Fallback ohne IDs
  assert.equal(commandMention({ commandIds: {} }, 'help'), '/help');
  assert.equal(commandMention({ commandIds: { help: '42' } }, 'help'), '</help:42>');

  // /help nennt auch den Anti-Delete-Command
  assert.ok(JSON.stringify(helpPayload).includes('set_anti_delete_messages'), 'help nennt /set_anti_delete_messages');
});

test('Security Bot: /set_anti_delete_messages schaltet den Modus (nur Admins)', async () => {
  const store = await makeStore();
  const ctx = { store, logger: noopLogger, env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb) };

  // Aktivieren (Auswahl true)
  let onPayload = null;
  await handleChatInput(ctx, adminInteraction({
    commandName: 'set_anti_delete_messages',
    options: { getBoolean: () => true },
    reply: async (p) => { onPayload = p; },
  }));
  assert.equal(store.getAntiDeleteEnabled('g1'), true, 'Flag gespeichert');
  assert.ok(JSON.stringify(onPayload).includes('Anti-Delete aktiviert'), 'Bestätigung: aktiviert');

  // Deaktivieren (Auswahl false)
  let offPayload = null;
  await handleChatInput(ctx, adminInteraction({
    commandName: 'set_anti_delete_messages',
    options: { getBoolean: () => false },
    reply: async (p) => { offPayload = p; },
  }));
  assert.equal(store.getAntiDeleteEnabled('g1'), false, 'Flag zurückgesetzt');
  assert.ok(JSON.stringify(offPayload).includes('Anti-Delete deaktiviert'), 'Bestätigung: deaktiviert');

  // Nicht-Admin: Abfuhr, kein Schreibzugriff
  let deniedPayload = null;
  await handleChatInput(ctx, adminInteraction({
    commandName: 'set_anti_delete_messages',
    memberPermissions: { has: () => false },
    options: { getBoolean: () => true },
    reply: async (p) => { deniedPayload = p; },
  }));
  assert.ok(deniedPayload);
  assert.equal(store.getAntiDeleteEnabled('g1'), false, 'kein Schreibzugriff ohne Rechte');
});

// ============================================================================
// 8. /security_check_now – Sofort-Prüfung
// ============================================================================

test('Security Bot: runCheckNow meldet "leer" ohne wartende Nachrichten', async () => {
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-checknow-key-123456');
  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map() } },
  };

  const result = await runCheckNow(ctx, 'g1');
  assert.deepEqual(result, { empty: true, analyzed: 0, remaining: 0, forcedSeen: false });
});

test('Security Bot: runCheckNow flusht den Buffer sofort und stellt Retry-Batches sofort fällig', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-checknow-key-654321');
  store.setLogChannelId('g1', 'clog');

  // Ein offener Buffer UNTERHALB des Token-Limits: würde ohne /security_check_now
  // noch lange nicht automatisch analysiert werden.
  store.addBufferMessage('g1', {
    channelId: 'c1',
    channelName: 'allgemein',
    authorId: '111111111111111111',
    authorName: 'Max',
    content: 'kurze Testnachricht',
    discordMessageId: 'm1',
    sentAt: Date.now(),
  });

  // Zusätzlich ein bereits fehlgeschlagener Batch mit fernem nextRetryAt
  // (z. B. wegen eines vorherigen "Modell nicht verfügbar"-Fehlers) –
  // /security_check_now muss ihn SOFORT erneut versuchen, nicht erst in Stunden.
  store.addBufferMessage('g1', {
    channelId: 'c1',
    channelName: 'allgemein',
    authorId: '222222222222222222',
    authorName: 'Anna',
    content: 'wartende Nachricht aus fehlgeschlagenem Batch',
    discordMessageId: 'm2',
    sentAt: Date.now() - 5000,
  });
  const stuckBatch = store.buildBatchFromBuffer('g1');
  stuckBatch.retryCount = 3;
  stuckBatch.nextRetryAt = Date.now() + 6 * 60 * 60 * 1000; // 6h in der Zukunft
  store.setBatches('g1', [stuckBatch]);

  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };

  const apiCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    apiCalls.push({ url, body: JSON.parse(options.body) });
    return geminiJsonResponse({ moderations: [], chat_reply: '' });
  };

  try {
    const result = await runCheckNow(ctx, 'g1');
    assert.equal(result.empty, false);
    assert.equal(result.remaining, 0, 'nichts bleibt hängen');
    assert.equal(result.analyzed, 2, 'beide Nachrichten wurden ausgewertet');
    assert.equal(apiCalls.length, 1, 'genau eine Gemini-Analyse für den kombinierten Batch');
    assert.equal(store.getBatches('g1').length, 0, 'Batch ist abgeschlossen');
    assert.equal(store.getBuffer('g1').length, 0, 'Buffer wurde geleert');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Security Bot: /security_check_now – kein Key, leer & erfolgreicher Lauf', async () => {
  const w = makeWorld();
  const store = await makeStore();
  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };

  // Ohne API-Key -> sofortige ephemere Fehlermeldung, kein Gemini-Aufruf
  let noKeyPayload = null;
  await handleChatInput(ctx, adminInteraction({
    commandName: 'security_check_now',
    reply: async (p) => { noKeyPayload = p; },
  }));
  assert.ok(JSON.stringify(noKeyPayload).includes('set_gemini_api_key'));

  store.setApiKey('g1', 'AIza-checknow-cmd-123456');

  // Mit Key, aber ohne gesammelte Nachrichten -> "nichts zu prüfen"
  let emptyPayload = null;
  await handleChatInput(ctx, adminInteraction({
    commandName: 'security_check_now',
    deferReply: async () => {},
    editReply: async (p) => { emptyPayload = p; },
  }));
  assert.ok(JSON.stringify(emptyPayload).toLowerCase().includes('ℹ️') || JSON.stringify(emptyPayload).includes('nichts zu prüfen'));

  // Mit gesammelten Nachrichten -> Analyse läuft synchron durch, Erfolg gemeldet
  store.addBufferMessage('g1', {
    channelId: 'c1',
    channelName: 'allgemein',
    authorId: '111111111111111111',
    authorName: 'Max',
    content: 'ganz normale Nachricht',
    discordMessageId: 'm1',
    sentAt: Date.now(),
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => geminiJsonResponse({ moderations: [], chat_reply: '' });

  let donePayload = null;
  try {
    await handleChatInput(ctx, adminInteraction({
      commandName: 'security_check_now',
      deferReply: async () => {},
      editReply: async (p) => { donePayload = p; },
    }));
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(JSON.stringify(donePayload).includes('✅'), 'Erfolgsmeldung enthält Häkchen');
  assert.equal(store.getBatches('g1').length, 0);
});

test('Security Bot: runCheckNow mit Zwangs-Nutzer hängt die Moderations-Direktive an den System-Prompt', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-forced-key-123456');

  store.addBufferMessage('g1', {
    channelId: 'c1', channelName: 'allgemein',
    authorId: '111111111111111111', authorName: 'Max',
    content: 'max sagt was', discordMessageId: 'm1', sentAt: Date.now() - 1000,
  });
  store.addBufferMessage('g1', {
    channelId: 'c1', channelName: 'allgemein',
    authorId: '222222222222222222', authorName: 'Anna',
    content: 'anna sagt was', discordMessageId: 'm2', sentAt: Date.now(),
  });

  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };

  const systemPrompts = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    systemPrompts.push(JSON.parse(options.body).systemInstruction.parts[0].text);
    return geminiJsonResponse({ moderations: [] });
  };
  try {
    // 1) Ohne Ziel-Nutzer: keine Direktive im System-Prompt
    const plain = await runCheckNow(ctx, 'g1');
    assert.equal(plain.forcedSeen, false);
    assert.ok(!systemPrompts[0].includes('ZWINGENDE MODERATION'), 'ohne Option keine Direktive');

    // 2) Mit Ziel-Nutzer, der im Verlauf vorkommt: Direktive + forcedSeen
    store.addBufferMessage('g1', {
      channelId: 'c1', channelName: 'allgemein',
      authorId: '222222222222222222', authorName: 'Anna',
      content: 'anna nochmal', discordMessageId: 'm3', sentAt: Date.now(),
    });
    const forced = await runCheckNow(ctx, 'g1', {
      forceUser: { id: '222222222222222222', name: 'Anna' },
    });
    assert.equal(forced.forcedSeen, true, 'Ziel kommt im Verlauf vor');
    assert.equal(forced.remaining, 0);
    assert.ok(systemPrompts[1].includes('ZWINGENDE MODERATION'), 'Direktive im System-Prompt');
    assert.ok(systemPrompts[1].includes('user_id=222222222222222222'), 'Ziel-ID im System-Prompt');

    // 3) Ziel-Nutzer OHNE gesammelte Nachrichten: keine Direktive möglich
    store.addBufferMessage('g1', {
      channelId: 'c1', channelName: 'allgemein',
      authorId: '111111111111111111', authorName: 'Max',
      content: 'nur max', discordMessageId: 'm4', sentAt: Date.now(),
    });
    const missing = await runCheckNow(ctx, 'g1', {
      forceUser: { id: '999999999999999999', name: 'Unbekannt' },
    });
    assert.equal(missing.forcedSeen, false, 'Ziel kam nirgends vor');
    assert.ok(!systemPrompts[2].includes('ZWINGENDE MODERATION'), 'keine Direktive ohne Vorkommen');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Security Bot: /security_check_now mit user-Option (erlaubt, Bot/Admin abgelehnt, ohne Vorkommen)', async () => {
  const w = makeWorld();
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-forced-cmd-key-123');
  const ctx = {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', w.guild]]) } },
  };

  // 1) Bot als Ziel: sofortige, ephemere Ablehnung – keine Analyse
  let rejectedBot = null;
  await handleChatInput(ctx, adminInteraction({
    commandName: 'security_check_now',
    options: { getUser: () => ({ id: '555555555555555555', bot: true, username: 'boeserbot' }) },
    reply: async (p) => { rejectedBot = p; },
  }));
  assert.ok(JSON.stringify(rejectedBot).includes('kann nicht moderiert werden'), 'Bot-Ziel abgelehnt');

  // 2) Administrator als Ziel: Immunität gewinnt auch hier
  let rejectedAdmin = null;
  await handleChatInput(ctx, adminInteraction({
    commandName: 'security_check_now',
    guild: w.guild,
    options: { getUser: () => ({ id: '333333333333333333', bot: false, username: 'boss' }) },
    reply: async (p) => { rejectedAdmin = p; },
  }));
  assert.ok(JSON.stringify(rejectedAdmin).includes('kann nicht moderiert werden'), 'Admin-Ziel abgelehnt');

  // 3) Regulärer Nutzer ohne gesammelte Nachrichten: "leer" + Warnhinweis
  let emptyForced = null;
  await handleChatInput(ctx, adminInteraction({
    commandName: 'security_check_now',
    guild: w.guild,
    options: { getUser: () => ({ id: '111111111111111111', bot: false, username: 'max', globalName: 'Max' }) },
    deferReply: async () => {},
    editReply: async (p) => { emptyForced = p; },
  }));
  const emptyStr = JSON.stringify(emptyForced);
  assert.ok(emptyStr.includes('nichts zu prüfen'), 'Basis: nichts vorhanden');
  assert.ok(emptyStr.includes('⚠️'), 'Hinweis: Ziel ohne gesammelte Nachrichten');

  // 4) Regulärer Nutzer MIT gesammelter Nachricht: Direktive + 🎯-Notiz
  store.addBufferMessage('g1', {
    channelId: 'c1', channelName: 'allgemein',
    authorId: '111111111111111111', authorName: 'Max',
    content: 'max ist verhaltensauffällig', discordMessageId: 'm1', sentAt: Date.now(),
  });
  const promptsSeen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    promptsSeen.push(JSON.parse(options.body).systemInstruction.parts[0].text);
    return geminiJsonResponse({ moderations: [] });
  };
  let doneForced = null;
  try {
    await handleChatInput(ctx, adminInteraction({
      commandName: 'security_check_now',
      guild: w.guild,
      options: { getUser: () => ({ id: '111111111111111111', bot: false, username: 'max', globalName: 'Max' }) },
      deferReply: async () => {},
      editReply: async (p) => { doneForced = p; },
    }));
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(JSON.stringify(doneForced).includes('🎯'), 'Zwangsmoderations-Notiz in der Antwort');
  assert.ok(promptsSeen.some((text) => text.includes('ZWINGENDE MODERATION')), 'Direktive erreicht Gemini');
});

// ============================================================================
// 9. Gemini-Modell-Fallback (404 "no longer available")
// ============================================================================

test('Security Bot: callGemini springt bei 404 automatisch zum nächsten Modell', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes('/models/gemini-2.5-flash-lite:generateContent')) {
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({
          error: { message: 'This model models/gemini-2.5-flash-lite is no longer available to new users.' },
        }),
      };
    }
    return geminiJsonResponse({ moderations: [] });
  };

  const res = await callGemini({
    apiKey: 'AIza-fallback-test',
    systemPrompt: 'SYSTEM',
    userPrompt: 'USER',
    model: 'gemini-2.5-flash-lite',
    fetchFn,
    sleepFn: async () => {},
  });

  assert.equal(res.ok, true, 'Fallback-Modell liefert Erfolg');
  assert.notEqual(res.model, 'gemini-2.5-flash-lite');
  assert.equal(res.fallbackFrom, 'gemini-2.5-flash-lite');
  assert.ok(Array.isArray(res.triedModels) && res.triedModels.length >= 2);
  assert.ok(calls.some((u) => u.includes('/models/gemini-2.5-flash-lite:generateContent')));
});

test('Security Bot: callGemini gibt bei 429/5xx/Netzwerkfehlern NICHT auf ein anderes Modell aus', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return {
      ok: false,
      status: 429,
      headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? '3' : null) },
      text: async () => '{"error":{"message":"rate limited"}}',
    };
  };

  const res = await callGemini({
    apiKey: 'AIza-no-fallback-test',
    systemPrompt: 'SYSTEM',
    userPrompt: 'USER',
    model: 'gemini-flash-lite-latest',
    fetchFn,
    sleepFn: async () => {},
    maxQuickRetries: 0,
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 429);
  assert.equal(res.retryAfterMs, 3000, 'Retry-After wird für den lokalen Cooldown ausgelesen');
  // Nur EIN Modell wurde angefragt – 429 ist kein Grund, das Modell zu wechseln.
  assert.ok(calls.every((u) => u.includes('/models/gemini-flash-lite-latest:generateContent')));
});

// ============================================================================
// 11. Anti-Delete: gelöschte letzte Nachricht per Webhook (Profil-Kopie) erneut senden
// ============================================================================

function makeAntiDeleteWorld() {
  const webhookCalls = [];
  const webhook = {
    send: async (p) => {
      webhookCalls.push(p);
      return { id: 'wm1' };
    },
  };
  const state = {
    // Snowflake-IDs sind chronologisch sortierbar: diese bleibende Nachricht
    // ist ÄLTER als die gelöschte (Standardfall: gelöschte war die Letzte).
    remaining: { id: '1400000000000000000' },
  };
  const channel = {
    id: 'c1',
    name: 'allgemein',
    isThread: () => false,
    parent: null,
    messages: {
      fetch: async (arg) => {
        if (arg && arg.limit) return { first: () => state.remaining };
        throw new Error('unexpected messages.fetch');
      },
    },
    fetchWebhooks: async () => new Map(),
    createWebhook: async () => webhook,
  };
  const guild = { id: 'g1', name: 'AntiDelete Test' };
  const deletedMessage = (over = {}) => ({
    id: '1500000000000000000',
    guild,
    guildId: 'g1',
    channelId: 'c1',
    channel,
    author: {
      id: '111111111111111111',
      bot: false,
      username: 'maxmustermann',
      globalName: 'Max M.',
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/111/aaa.png',
    },
    member: {
      displayName: 'Max',
      displayAvatarURL: () => 'https://cdn.discordapp.com/guilds/g1/users/111/bbb.png',
    },
    content: 'Das war meine letzte Nachricht',
    attachments: new Map(),
    webhookId: null,
    system: false,
    ...over,
  });
  return { webhookCalls, webhook, channel, guild, deletedMessage, state };
}

test('Security Bot: Anti-Delete sendet gelöschte letzte Nachricht mit exakter Profil-Kopie erneut', async () => {
  clearWebhookCache();
  const w = makeAntiDeleteWorld();
  const store = await makeStore();
  store.setAntiDeleteEnabled('g1', true);
  const ctx = { store, logger: noopLogger, client: { user: { id: 'bot1' } } };

  await handleMessageDelete({ ctx, message: w.deletedMessage() });
  assert.equal(w.webhookCalls.length, 1, 'genau ein Webhook-Versand');
  const p = w.webhookCalls[0];
  assert.equal(p.username, 'Max', 'Server-Anzeigename als Webhook-Name');
  assert.equal(p.avatarURL, 'https://cdn.discordapp.com/guilds/g1/users/111/bbb.png', 'Server-Avatar des Mitglieds');
  assert.equal(p.content, 'Das war meine letzte Nachricht', 'Inhalt unverändert');
  assert.deepEqual(p.allowedMentions, { parse: [] }, 'keine Pings beim erneuten Senden');

  // Zweite Löschung eines anderen Nutzers (ohne Member-Objekt): Fallback globalName
  clearWebhookCache();
  const w2 = makeAntiDeleteWorld();
  await handleMessageDelete({
    ctx,
    message: w2.deletedMessage({ member: null }),
  });
  // Hinweis: gleicher Kanal -> selber Webhook-Cache, aber eigener World-Zähler
  assert.equal(w2.webhookCalls.length, 1);
  assert.equal(w2.webhookCalls[0].username, 'Max M.', 'Fallback: globalName ohne Member');
  assert.equal(
    w2.webhookCalls[0].avatarURL,
    'https://cdn.discordapp.com/avatars/111/aaa.png',
    'Fallback: User-Avatar ohne Member'
  );
});

test('Security Bot: Anti-Delete ignoriert Bots, Webhooks, Leere/ältere/gelöschte-Nicht-Letzte & DMs', async () => {
  clearWebhookCache();
  const w = makeAntiDeleteWorld();
  const store = await makeStore();
  const ctx = { store, logger: noopLogger, client: { user: { id: 'bot1' } } };

  // Modus AUS -> garantiert nichts
  await handleMessageDelete({ ctx, message: w.deletedMessage() });
  assert.equal(w.webhookCalls.length, 0, 'deaktiviert = still');

  store.setAntiDeleteEnabled('g1', true);

  // Bot-Nachricht
  await handleMessageDelete({ ctx, message: w.deletedMessage({ author: { id: 'x1', bot: true } }) });
  // Webhook-Nachricht
  await handleMessageDelete({ ctx, message: w.deletedMessage({ webhookId: 'wh123' }) });
  // Eigene Nachricht des Bots
  await handleMessageDelete({ ctx, message: w.deletedMessage({ author: { id: 'bot1', bot: false } }) });
  // Leere/Sticker-Nachricht ohne Text & Anhänge
  await handleMessageDelete({ ctx, message: w.deletedMessage({ content: '   ', attachments: new Map() }) });
  // Nicht die letzte Nachricht: es existiert eine NEUER verbleibende Nachricht
  w.state.remaining = { id: '1600000000000000000' };
  await handleMessageDelete({ ctx, message: w.deletedMessage() });
  // DM (keine Gilde)
  await handleMessageDelete({ ctx, message: { ...w.deletedMessage(), guild: null } });

  assert.equal(w.webhookCalls.length, 0, 'nichts davon wird erneut gesendet');
});

test('Security Bot: Anti-Delete – Nachfolger existiert, Kanal jetzt leer, Anhänge & Webhook-Fehler', async () => {
  clearWebhookCache();
  const w = makeAntiDeleteWorld();
  const store = await makeStore();
  store.setAntiDeleteEnabled('g1', true);
  const ctx = { store, logger: noopLogger, client: { user: { id: 'bot1' } } };

  // wasLastChannelMessage: leerer Kanal nach Löschung -> gelöschte war letzte
  w.state.remaining = null;
  assert.equal(await wasLastChannelMessage(w.deletedMessage()), true, 'leerer Kanal = war letzte');
  w.state.remaining = { id: '1400000000000000000' };
  assert.equal(await wasLastChannelMessage(w.deletedMessage()), true, 'ältere Restnachricht = war letzte');
  w.state.remaining = { id: '1700000000000000000' };
  assert.equal(await wasLastChannelMessage(w.deletedMessage()), false, 'neuere Restnachricht = nicht letzte');

  // Nur-Anhang-Nachricht: Inhalt leer, Anhang wird mitgesendet
  w.state.remaining = { id: '1400000000000000000' };
  const withFile = w.deletedMessage({
    content: '',
    attachments: new Map([['a1', { url: 'https://cdn.discordapp.com/attachments/c/m/datei.png' }]]),
  });
  await handleMessageDelete({ ctx, message: withFile });
  assert.equal(w.webhookCalls.length, 1);
  assert.deepEqual(w.webhookCalls[0].files, ['https://cdn.discordapp.com/attachments/c/m/datei.png']);
  assert.equal(w.webhookCalls[0].content, undefined, 'kein Text -> content bleibt weg');

  // Webhook nicht anlegbar (fehlende Rechte) -> Warnung, kein Crash, kein Send
  clearWebhookCache();
  w.channel.fetchWebhooks = async () => { throw new Error('Missing Permissions'); };
  await handleMessageDelete({ ctx, message: w.deletedMessage() });
  assert.equal(w.webhookCalls.length, 1, 'ohne nutzbaren Webhook wird nichts gesendet');
});
