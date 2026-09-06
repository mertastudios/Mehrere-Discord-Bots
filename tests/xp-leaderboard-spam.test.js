/**
 * Regressionstests für den gemeldeten Bug im kombinierten Modus
 * (Level-Chat == Leaderboard-Kanal):
 *
 *   „Ständig wird das Leaderboard neu gesendet und lauter Leute gepingt.
 *    Eine Stunde offline → 200 Erwähnungen im Leveling-Kanal.
 *    Beim Chatten kamen alle 10 Sekunden Leaderboard-Pings.“
 *
 * Ursachen:
 *  1. Jede Board-Nachricht enthielt <@id>-Mentions der Top 15 OHNE
 *     allowedMentions – Discord pingt in Components-V2-TextDisplays jede
 *     Mention beim Neu-Senden. → 15 Pings pro Neu-Senden.
 *  2. Neu gesendet wurde bei JEDER fremden Chat-Nachricht im Kanal, bei jedem
 *     XP-Gewinn aus JEDEM Kanal und bei jeder Voice-Minute – mit nur 5 s
 *     Throttle. → Neu-Senden im 5–10-Sekunden-Takt.
 *
 * Erwartetes Verhalten nach dem Fix:
 *  - Leaderboard-Payloads (send + edit) tragen IMMER allowedMentions.parse = [].
 *  - Fremde Nachrichten und reine XP-Gewinne lösen NIE ein Neu-Senden aus,
 *    sondern höchstens einen stillen Edit (10-Min-Throttle).
 *  - Neu gesendet wird nur nach einer eigenen Bot-Ankündigung im Board-Kanal,
 *    höchstens alle 10 Minuten; mehrere Auslöser im Fenster werden zu genau
 *    EINEM nachgeholten Repin zusammengefasst.
 *
 * Ausführen mit: npm test
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');

// Store-Modul VOR dem Bot-Modul patchen (index.js destrukturiert createXpStore
// beim Laden): So bekommen die E2E-Tests die echte Store-Instanz des Bots in
// die Hand, ohne Produktionscode für Tests zu verändern.
const storePath = require.resolve('../bots/xp-level-bot/src/store');
const realStoreModule = require(storePath);
const capturedStores = [];
require.cache[storePath].exports = {
  ...realStoreModule,
  createXpStore: (...args) => {
    const store = realStoreModule.createXpStore(...args);
    capturedStores.push(store);
    return store;
  },
};

const scheduler = require('../bots/xp-level-bot/src/scheduler');
const {
  repinLeaderboard,
  refreshLeaderboard,
  refreshLeaderboardAfterActivity,
  isCombinedLeaderboardChannel,
  isLeaderboardChannel,
  resetRepinState,
  LEADERBOARD_ALLOWED_MENTIONS,
  REPIN_MIN_INTERVAL_MS,
  LEADERBOARD_MIN_REFRESH_MS,
  _lastLeaderboardRefresh,
  _lastHourlyRefresh,
} = scheduler;
const { sendLevelAnnouncement, sendOwnerXpAnnouncement } = require('../bots/xp-level-bot/src/level-announcements');
const { createXpStore } = require('../bots/xp-level-bot/src/store');

const TOP15 = Array.from({ length: 15 }, (_, i) => ({ userId: `user-${i + 1}`, level: 20 - i, xp: 10 }));

function noopLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

/**
 * Fake-Kanal, der alle send()/edit()-Payloads mitschreibt und – wie discord.js –
 * die ID der zuletzt gesendeten Nachricht in `lastMessageId` führt.
 */
function makeBoardHarness(entry, { slowSend = false, lastMessageId = 'someone-elses-message' } = {}) {
  const sends = [];
  const edits = [];
  const deleted = [];
  let counter = 0;
  const messages = new Map();

  const makeMessage = (id) => {
    const m = {
      id,
      edit: async (payload) => { edits.push(payload); return m; },
      delete: async () => { deleted.push(id); messages.delete(id); },
    };
    messages.set(id, m);
    return m;
  };
  if (entry.leaderboardMessageId) makeMessage(entry.leaderboardMessageId);

  const channel = {
    id: entry.leaderboardChannelId,
    lastMessageId,
    isTextBased: () => true,
    messages: { fetch: async (id) => messages.get(id) || null },
    send: async (payload) => {
      if (slowSend) await new Promise((r) => setTimeout(r, 20));
      sends.push(payload);
      counter += 1;
      const m = makeMessage(`board-${counter}`);
      channel.lastMessageId = m.id;
      return m;
    },
  };
  const guild = {
    id: entry.guildId,
    name: 'Ping-Test',
    channels: { cache: new Map([[entry.leaderboardChannelId, channel]]), fetch: async () => channel },
  };
  const store = {
    getLeaderboard: () => TOP15,
    setGuild: () => {},
    flush: async () => {},
    findLeaderboardMessage: async () => null,
  };
  const client = {
    guilds: { cache: new Map([[entry.guildId, guild]]), fetch: async () => guild },
    channels: { fetch: async () => channel },
    user: { id: 'bot' },
  };
  return { ctx: { client, store, logger: noopLogger() }, guild, channel, sends, edits, deleted };
}

function combinedEntry(guildId) {
  return {
    guildId,
    leaderboardChannelId: 'combined',
    mainChannelId: 'combined',
    leaderboardMessageId: 'board-old',
    lang: 'de',
  };
}

function resetThrottles(guildId) {
  resetRepinState(guildId);
  _lastLeaderboardRefresh.delete(guildId);
  _lastHourlyRefresh.delete(guildId);
}

afterEach(() => resetRepinState());

// ---------------------------------------------------------------------------
// 1) Keine Pings mehr – weder beim Neu-Senden noch beim Editieren
// ---------------------------------------------------------------------------

test('LEADERBOARD_ALLOWED_MENTIONS unterdrückt jede Benachrichtigung (parse: [])', () => {
  assert.deepEqual(LEADERBOARD_ALLOWED_MENTIONS, { parse: [] });
  assert.ok(Object.isFrozen(LEADERBOARD_ALLOWED_MENTIONS), 'Konstante darf nicht versehentlich mutiert werden');
});

test('repinLeaderboard: neu gesendetes Board enthält die Top-15-Mentions, pingt aber niemanden', async () => {
  const entry = combinedEntry('ping-repin');
  resetThrottles(entry.guildId);
  const h = makeBoardHarness(entry);

  const ok = await repinLeaderboard(h.ctx, entry, h.guild, { throttle: false });

  assert.equal(ok, true);
  assert.equal(h.sends.length, 1, 'genau eine neue Board-Nachricht');
  const payload = h.sends[0];
  assert.deepEqual(payload.allowedMentions, { parse: [] }, 'Neu-Senden MUSS allowedMentions.parse=[] tragen');
  assert.ok(payload.flags & MessageFlags.IsComponentsV2, 'weiterhin Components V2');
  // Die Namen bleiben als Mention sichtbar (klickbar), nur die Benachrichtigung entfällt.
  const json = JSON.stringify(payload.components.map((c) => (c.toJSON ? c.toJSON() : c)));
  assert.ok(json.includes('<@user-1>') && json.includes('<@user-15>'), 'Top-15-Mentions bleiben im Text');
});

test('refreshLeaderboard: auch der stille Edit und der Ersatz-Send tragen allowedMentions.parse=[]', async () => {
  const entry = combinedEntry('ping-edit');
  resetThrottles(entry.guildId);
  const h = makeBoardHarness(entry);

  const ok = await refreshLeaderboard(h.ctx, entry, h.guild, new Date(), { isHourly: false });
  assert.equal(ok, true);
  assert.equal(h.edits.length, 1);
  assert.deepEqual(h.edits[0].allowedMentions, { parse: [] }, 'Edit ohne Pings');

  // Board-Nachricht ist weg → Ersatz wird gesendet, ebenfalls ohne Pings.
  const gone = { ...combinedEntry('ping-replace'), leaderboardMessageId: null };
  resetThrottles(gone.guildId);
  const h2 = makeBoardHarness(gone);
  const ok2 = await refreshLeaderboard(h2.ctx, gone, h2.guild, new Date(), { isHourly: true });
  assert.equal(ok2, true);
  assert.equal(h2.sends.length, 1);
  assert.deepEqual(h2.sends[0].allowedMentions, { parse: [] }, 'Ersatz-Send ohne Pings');
});

// ---------------------------------------------------------------------------
// 2) Kein Neu-Senden im Sekundentakt mehr
// ---------------------------------------------------------------------------

test('Repin-Mindestabstand ist 10 Minuten (früher 5 Sekunden)', () => {
  assert.equal(REPIN_MIN_INTERVAL_MS, 10 * 60 * 1000);
  assert.equal(REPIN_MIN_INTERVAL_MS, LEADERBOARD_MIN_REFRESH_MS);
});

test('Level-Up-Serie im kombinierten Kanal: 20 Auslöser → EIN Neu-Senden sofort, danach nichts mehr im Fenster', async () => {
  const entry = combinedEntry('burst');
  resetThrottles(entry.guildId);
  const h = makeBoardHarness(entry, { slowSend: true });

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      refreshLeaderboardAfterActivity(h.ctx, entry, h.guild, { announcedInBoardChannel: true })
    )
  );
  // Noch 10 Nachzügler nach Abschluss des ersten Sends (nicht mehr in-flight).
  for (let i = 0; i < 10; i++) {
    results.push(await refreshLeaderboardAfterActivity(h.ctx, entry, h.guild, { announcedInBoardChannel: true }));
  }

  assert.equal(results.filter(Boolean).length, 1, 'genau ein Repin ausgeführt');
  assert.equal(h.sends.length, 1, 'genau EINE neue Board-Nachricht für 30 Level-Ups');
  assert.deepEqual(h.deleted, ['board-old'], 'alte Board-Nachricht wurde genau einmal entfernt');
});

test('Nachzügler im 10-Minuten-Fenster werden zu genau EINEM nachgeholten Repin zusammengefasst', async (t) => {
  // Gemockte Uhr startet bei einem realistischen Zeitpunkt (nicht 0), damit
  // „noch nie neu gesendet“ (lastRepin = 0) korrekt als „lange her“ zählt.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const entry = combinedEntry('deferred');
  resetThrottles(entry.guildId);
  const h = makeBoardHarness(entry);

  assert.equal(await repinLeaderboard(h.ctx, entry, h.guild, { throttle: true }), true);
  assert.equal(h.sends.length, 1);

  // Drei weitere Level-Up-Ankündigungen kurz danach (jede landet als neue
  // Nachricht im Kanal): kein sofortiges Neu-Senden.
  t.mock.timers.tick(30_000);
  for (let i = 0; i < 3; i++) {
    h.channel.lastMessageId = `level-up-announcement-${i}`;
    assert.equal(await repinLeaderboard(h.ctx, entry, h.guild, { throttle: true }), false);
  }
  assert.equal(h.sends.length, 1, 'innerhalb des Fensters wird nicht neu gesendet');

  // Fensterende: genau EIN Nachhol-Repin – nicht drei.
  t.mock.timers.tick(REPIN_MIN_INTERVAL_MS);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sends.length, 2, 'genau ein nachgeholter Repin am Fensterende');
  assert.deepEqual(h.sends[1].allowedMentions, { parse: [] });
  assert.equal(h.edits.length, 0, 'kein zusätzlicher Edit nötig');

  // Nach dem Nachhol-Repin ohne weitere Ankündigung: Board ist die neueste
  // Nachricht → ein weiterer Auslöser führt höchstens zu einem stillen Edit.
  t.mock.timers.tick(REPIN_MIN_INTERVAL_MS + 1000);
  _lastLeaderboardRefresh.delete(entry.guildId);
  assert.equal(await repinLeaderboard(h.ctx, entry, h.guild, { throttle: true }), true);
  assert.equal(h.sends.length, 2, 'kein Neu-Senden, wenn das Board schon unten steht');
  assert.equal(h.edits.length, 1, 'stattdessen stiller Edit');
});

test('Board ist bereits die neueste Nachricht im Kanal → kein Neu-Senden, nur stiller Edit', async () => {
  const entry = combinedEntry('already-newest');
  resetThrottles(entry.guildId);
  // lastMessageId zeigt auf das Board selbst.
  const h = makeBoardHarness(entry, { lastMessageId: 'board-old' });

  const result = await repinLeaderboard(h.ctx, entry, h.guild, { throttle: false });

  assert.equal(result, true, 'stiller Edit gilt als Erfolg');
  assert.equal(h.sends.length, 0, 'keine neue Nachricht');
  assert.equal(h.edits.length, 1, 'stattdessen In-Place-Edit');
  assert.equal(h.deleted.length, 0);
  assert.equal(entry.leaderboardMessageId, 'board-old', 'Message-ID bleibt');
});

// ---------------------------------------------------------------------------
// 3) Reine XP-Gewinne / Fremdnachrichten senden NIE neu
// ---------------------------------------------------------------------------

test('refreshLeaderboardAfterActivity ohne Ankündigung: im kombinierten Kanal nur Edit, nie Neu-Senden', async () => {
  const entry = combinedEntry('xp-only');
  resetThrottles(entry.guildId);
  const h = makeBoardHarness(entry);

  // 50 XP-Gewinne (Chat aus anderen Kanälen, Voice-Minuten, erste XP …)
  let refreshed = 0;
  for (let i = 0; i < 50; i++) {
    if (await refreshLeaderboardAfterActivity(h.ctx, entry, h.guild)) refreshed += 1;
  }

  assert.equal(h.sends.length, 0, 'XP-only darf NIE neu senden');
  assert.equal(refreshed, 1, 'genau ein stiller Edit (10-Min-Throttle)');
  assert.equal(h.edits.length, 1);
  assert.deepEqual(h.edits[0].allowedMentions, { parse: [] });
});

test('Ankündigung in einem ANDEREN Kanal als dem Board-Kanal → kein Neu-Senden', async () => {
  const entry = combinedEntry('other-channel');
  resetThrottles(entry.guildId);
  const h = makeBoardHarness(entry);

  // z. B. Level-Up-Reply in #allgemein, Board liegt in #level
  const announced = isLeaderboardChannel(entry, 'allgemein');
  assert.equal(announced, false);
  await refreshLeaderboardAfterActivity(h.ctx, entry, h.guild, { announcedInBoardChannel: announced });

  assert.equal(h.sends.length, 0);
  assert.equal(h.edits.length, 1, 'nur stiller Edit');
});

test('Getrennte Kanäle: auch mit Ankündigung niemals Neu-Senden', async () => {
  const entry = { ...combinedEntry('separate'), mainChannelId: 'levelchat' };
  resetThrottles(entry.guildId);
  const h = makeBoardHarness(entry);
  assert.equal(isCombinedLeaderboardChannel(entry), false);

  await refreshLeaderboardAfterActivity(h.ctx, entry, h.guild, { announcedInBoardChannel: true });
  assert.equal(h.sends.length, 0);
  assert.equal(h.edits.length, 1);
});

test('isCombinedLeaderboardChannel / isLeaderboardChannel vergleichen robust als String', () => {
  assert.equal(isCombinedLeaderboardChannel({ mainChannelId: 123, leaderboardChannelId: '123' }), true);
  assert.equal(isCombinedLeaderboardChannel({ mainChannelId: '1', leaderboardChannelId: '2' }), false);
  assert.equal(isCombinedLeaderboardChannel({ leaderboardChannelId: '2' }), false);
  assert.equal(isCombinedLeaderboardChannel(null), false);
  assert.equal(isLeaderboardChannel({ leaderboardChannelId: 5 }, '5'), true);
  assert.equal(isLeaderboardChannel({ leaderboardChannelId: '5' }, null), false);
});

// ---------------------------------------------------------------------------
// 4) Ankündigungen melden den Zielkanal zurück
// ---------------------------------------------------------------------------

test('sendLevelAnnouncement liefert channelId des tatsächlichen Ziels (Reply, Level-Chat, Systemkanal)', async () => {
  const ctx = { logger: noopLogger() };
  const main = { id: 'main', isTextBased: () => true, send: async () => ({ id: 'm' }) };
  const system = { id: 'system', isTextBased: () => true, send: async () => ({ id: 's' }) };
  const guild = {
    id: 'g', name: 'G', systemChannel: system,
    channels: { cache: new Map([['main', main]]), fetch: async (id) => (id === 'main' ? main : null) },
  };
  const cfg = { guildId: 'g', mainChannelId: 'main', lang: 'de' };
  const res = { leveledUp: true, level: 2, xp: 0 };

  const reply = await sendLevelAnnouncement({
    ctx, guild, cfg, userId: 'u', res, source: 'text',
    sourceMsg: { channel: { id: 'random-chat', isTextBased: () => true, send: async () => ({}) }, reply: async () => ({}) },
  });
  assert.equal(reply.destination, 'source-reply');
  assert.equal(reply.channelId, 'random-chat');

  const viaMain = await sendLevelAnnouncement({ ctx, guild, cfg, userId: 'u', res, source: 'voice' });
  assert.equal(viaMain.destination, 'main-channel');
  assert.equal(viaMain.channelId, 'main');

  const noMain = await sendLevelAnnouncement({
    ctx, guild: { ...guild, channels: { cache: new Map(), fetch: async () => null } },
    cfg, userId: 'u', res, source: 'voice',
  });
  assert.equal(noMain.destination, 'system-channel');
  assert.equal(noMain.channelId, 'system');

  const failed = await sendLevelAnnouncement({
    ctx, guild: { id: 'g', name: 'G', systemChannel: null, channels: { cache: new Map(), fetch: async () => null } },
    cfg, userId: 'u', res, source: 'voice',
  });
  assert.equal(failed.sent, false);
  assert.equal(failed.channelId, null);
});

test('sendOwnerXpAnnouncement (/give_xp) liefert channelId des Level-Chats', async () => {
  const ctx = { logger: noopLogger() };
  const main = { id: 'main', isTextBased: () => true, send: async () => ({ id: 'm' }) };
  const guild = {
    id: 'g', name: 'G', systemChannel: null,
    channels: { cache: new Map([['main', main]]), fetch: async () => main },
  };
  const r = await sendOwnerXpAnnouncement({
    ctx, guild, cfg: { mainChannelId: 'main' }, ownerId: 'o', userId: 'u', amount: 10, beforeLevel: 1, afterLevel: 1,
  });
  assert.equal(r.sent, true);
  assert.equal(r.channelId, 'main');
});

// ---------------------------------------------------------------------------
// 5) End-to-End über den ECHTEN messageCreate-Handler des Bots
// ---------------------------------------------------------------------------

async function bootBot({ combined = true } = {}) {
  const bot = require('../bots/xp-level-bot/index.js');
  const handlers = { on: new Map(), once: new Map() };
  const sends = [];
  const edits = [];
  const boardMessage = {
    id: 'board-old',
    edit: async (p) => { edits.push(p); return boardMessage; },
    delete: async () => {},
  };
  const replies = [];
  const channel = {
    id: 'combined',
    lastMessageId: 'somebody',
    isTextBased: () => true,
    messages: { fetch: async (id) => (id === 'board-old' ? boardMessage : null) },
    send: async (p) => { sends.push(p); const m = { id: `board-${sends.length}`, delete: async () => {} }; channel.lastMessageId = m.id; return m; },
  };
  const otherChannel = { id: 'other', isTextBased: () => true, send: async () => ({ id: 'x' }) };
  const guild = {
    id: 'g1',
    name: 'E2E',
    ownerId: 'owner',
    systemChannel: null,
    channels: {
      cache: new Map([['combined', channel], ['other', otherChannel]]),
      fetch: async (id) => (id === 'combined' ? channel : id === 'other' ? otherChannel : null),
    },
    members: { fetch: async () => null, me: null },
  };
  const client = {
    user: { id: 'bot', tag: 'XP#0001', setPresence: () => ({}) },
    guilds: { cache: new Map([['g1', guild]]), fetch: async () => guild },
    channels: { fetch: async (id) => (id === 'combined' ? channel : null) },
    on: (ev, fn) => handlers.on.set(String(ev), fn),
    once: (ev, fn) => handlers.once.set(String(ev), fn),
    removeListener: () => {},
    destroy: () => {},
  };
  const env = (key, fallback = '') => (key === 'XP_STORE_DISABLE_FILE_BACKUP' ? 'true' : fallback);
  const sigBefore = { SIGTERM: process.listenerCount('SIGTERM'), SIGINT: process.listenerCount('SIGINT') };
  const storesBefore = capturedStores.length;
  await bot.create({ client, token: 'test-token-not-a-real-secret', logger: noopLogger(), env });

  const messageCreate = handlers.on.get('messageCreate');
  assert.equal(typeof messageCreate, 'function');

  // Die vom Bot erzeugte Store-Instanz (siehe Patch oben) direkt befüllen –
  // ohne Turso, ohne Datei. Entspricht dem Zustand nach /setup.
  const storeRef = capturedStores[storesBefore];
  assert.ok(storeRef, 'Store-Instanz des Bots wurde abgefangen');
  storeRef.flush = async () => {};
  storeRef.setGuild({
    guildId: 'g1',
    leaderboardChannelId: 'combined',
    mainChannelId: combined ? 'combined' : 'other',
    leaderboardMessageId: 'board-old',
    lang: 'de',
    lastLeaderboardRefresh: Date.now(),
    lastHourlyLeaderboardRefresh: Date.now(),
    nicknamesEnabled: false,
  });

  // Nur Board-Nachrichten zählen: Bonus-Drops (eigene Nachricht mit Button)
  // würden sonst als „send“ mitgezählt. Der Bot erkennt sie am Marker.
  const isBoardPayload = (p) => JSON.stringify((p?.components || []).map((c) => (c.toJSON ? c.toJSON() : c))).includes('Level Leaderboard');

  const cleanup = () => {
    client.destroy();
    for (const name of ['SIGTERM', 'SIGINT']) {
      for (const l of process.listeners(name).slice(sigBefore[name])) process.off(name, l);
    }
    resetRepinState('g1');
    _lastLeaderboardRefresh.delete('g1');
    _lastHourlyRefresh.delete('g1');
  };
  return {
    messageCreate,
    channel,
    otherChannel,
    sends,
    edits,
    replies,
    guild,
    store: storeRef,
    boardSends: () => sends.filter(isBoardPayload),
    cleanup,
  };
}

function fakeMessage(channel, guild, { authorId = 'human-1', content = 'hallo das ist eine ganz normale nachricht', bot = false } = {}) {
  // discord.js-Collections haben .some(); eine nackte Map nicht.
  const attachments = new Map();
  attachments.some = () => false;
  return {
    guild,
    channel,
    author: { id: authorId, bot },
    content,
    attachments,
    stickers: new Map(),
    flags: { has: () => false },
    system: false,
    webhookId: null,
    reply: async () => ({ id: 'reply' }),
  };
}

test('E2E: 30 fremde Nachrichten im kombinierten Kanal → KEIN einziges Neu-Senden des Boards', async () => {
  const h = await bootBot({ combined: true });
  try {
    for (let i = 0; i < 30; i++) {
      // 30 verschiedene Menschen (kein XP-Cooldown pro Person) UND andere Bots.
      await h.messageCreate(fakeMessage(h.channel, h.guild, { authorId: `human-${i}` }));
      await h.messageCreate(fakeMessage(h.channel, h.guild, { authorId: 'other-bot', bot: true }));
    }
    // fire-and-forget-Pfade abwarten
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.boardSends().length, 0, 'Fremdnachrichten dürfen das Board nicht neu senden');
    assert.ok(h.edits.length <= 1, 'höchstens ein stiller Edit (10-Min-Throttle)');
    for (const e of h.edits) assert.deepEqual(e.allowedMentions, { parse: [] });
  } finally {
    h.cleanup();
  }
});

test('E2E: Level-Up im kombinierten Kanal → Ankündigung + genau EIN Neu-Senden ohne Pings; Folge-Level-Ups warten', async () => {
  const h = await bootBot({ combined: true });
  try {
    // Nutzer kurz vor Level-Up (80 XP nötig für Lvl 1→2)
    for (let i = 0; i < 5; i++) {
      h.store.setUser({ guildId: 'g1', userId: `lvl-${i}`, level: 1, xp: 79, lastXpGain: 0, inactiveDays: 0, lastActivity: 0 });
    }
    for (let i = 0; i < 5; i++) {
      await h.messageCreate(fakeMessage(h.channel, h.guild, { authorId: `lvl-${i}`, content: 'noch ein wort mehr bitte' }));
    }
    await new Promise((r) => setTimeout(r, 50));

    const boards = h.boardSends();
    assert.equal(boards.length, 1, '5 Level-Ups → genau EIN neues Board');
    assert.deepEqual(boards[0].allowedMentions, { parse: [] }, 'Board pingt niemanden');
    assert.equal(h.store.getUser('g1', 'lvl-0').level, 2, 'Level-Up wurde verbucht');
  } finally {
    h.cleanup();
  }
});
