/**
 * Boot-Verdrahtung des Security-Bots (index.js):
 * /setup wird global UND auf allen Servern registriert, der Log-Kanal wird
 * hergestellt, gelöschte Rollen/Kanäle werden aufgeräumt, Server-Daten gelöscht,
 * beim Beitritt wird der Owner informiert.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Collection, Events } = require('discord.js');

const bot = require('../bots/security-bot/index.js');
const { SETUP_COMMAND } = require('../bots/security-bot/src/register');
const { makeGuild, makeChannel, makeRole, textsOf, silent } = require('./security-fakes');

function makeClient(guilds) {
  const cache = new Collection();
  for (const guild of guilds) cache.set(guild.id, guild);
  const handlers = new Map();
  const client = {
    user: { id: 'bot1', username: 'Sentinel', setPresence: () => ({}) },
    guilds: { cache },
    destroyed: false,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
      return client;
    },
    once(event, handler) {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
      return client;
    },
    async emit(event, ...args) {
      const results = [];
      for (const handler of handlers.get(event) || []) results.push(await handler(...args));
      return results;
    },
    destroy() {
      client.destroyed = true;
      return Promise.resolve();
    },
  };
  return client;
}

/** Schreibt eine vorbereitete Konfiguration in die Datei, die der Bot beim Start liest. */
function seedFile(guildsConfig) {
  const file = path.join(os.tmpdir(), `sec-boot-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), guilds: guildsConfig, penalties: [], buffer: [] }));
  return file;
}

async function boot({ guilds, file }) {
  const client = makeClient(guilds);
  const puts = [];
  const rest = {
    put: async (route, options) => {
      puts.push({ route, body: options?.body });
      return options?.body || [];
    },
  };

  await bot.create({
    client,
    token: 'test-token',
    logger: silent(),
    env: (key, fallback) => (key === 'SECURITY_BOT_DATA_FILE' ? file : fallback),
    rest,
  });

  return { client, puts };
}

test('Beim Start: /setup global und auf jedem Server registrieren', async () => {
  const guildA = makeGuild({ id: 'gA', name: 'A', channels: [makeChannel({ id: 'cA', name: 'chat' })] });
  const guildB = makeGuild({ id: 'gB', name: 'B', channels: [makeChannel({ id: 'cB', name: 'chat' })] });
  const { client, puts } = await boot({ guilds: [guildA, guildB], file: seedFile([]) });

  await client.emit(Events.ClientReady);
  console.log('PUTS', JSON.stringify(puts.map((p) => p.route)));

  const global = puts.find((p) => p.route.endsWith('/commands'));
  assert.ok(global, 'globale Registrierung vorhanden');
  assert.deepEqual(global.body, [SETUP_COMMAND]);
  assert.equal(global.body[0].name, 'setup');
  assert.equal(global.body[0].options.length, 0);

  const guildRoutes = puts.filter((p) => p.route.includes('/guilds/'));
  assert.equal(guildRoutes.length, 2, 'jeder bestehende Server bekommt /setup sofort');
});

test('Nach dem Setup legt der Start den Log-Kanal an und begrüßt', async () => {
  const channel = makeChannel({ id: 'c1', name: 'chat' });
  const guild = makeGuild({ id: 'g1', name: 'Testserver', channels: [channel] });
  const file = seedFile([
    {
      guildId: 'g1',
      lang: 'de',
      channels: ['c1'],
      immuneRoles: [],
      rulesMode: 'skip',
      rules: '',
      instructions: '',
      allow: { ban: false, kick: false, timeout: true },
      logChannelId: 'gone1',
      logAuto: true,
      groqKey: 'gsk_test',
      setup: { step: 7, furthest: 7, done: true, completedAt: Date.now() },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]);
  const { client } = await boot({ guilds: [guild], file });

  await client.emit(Events.ClientReady);

  assert.equal(guild.created.length, 1, 'gelöschter Log-Kanal wurde neu angelegt');
  const logChannel = guild.created[0];
  assert.ok(logChannel.sent.length >= 1, 'Der Bot kündigt den neuen Kanal an');
  assert.match(textsOf(logChannel.sent[0]), /neu angelegt/i);
  assert.ok(Array.isArray(logChannel.overwrites), 'Rechte wurden gesetzt');
  fs.unlinkSync(file);
});

test('Wartung im Betrieb: Kanal weg, Rolle weg, Server weg, Beitritt', async () => {
  const channel = makeChannel({ id: 'c1', name: 'chat' });
  const guild = makeGuild({ id: 'g1', name: 'A', channels: [channel] });
  const team = makeRole({ id: 'r1', name: 'Team', position: 1 });
  guild.roles.cache.set(team.id, team);
  const { client } = await boot({ guilds: [guild], file: seedFile([]) });
  await client.emit(Events.ClientReady);

  await client.emit('channelDelete', channel);
  await client.emit('roleDelete', team);
  await client.emit('guildDelete', guild);

  // Beim Beitritt: Owner anschreiben + Befehl sofort registrieren
  const guildC = makeGuild({ id: 'gC', name: 'C', channels: [makeChannel({ id: 'cC', name: 'chat' })] });
  client.guilds.cache.set(guildC.id, guildC);
  await client.emit('guildCreate', guildC);

  assert.equal(guildC.ownerDms.length, 1);
  assert.match(textsOf(guildC.ownerDms[0]), /setup/i);
  assert.match(textsOf(guildC.ownerDms[0]), /Administrator/);
});

test('Der Bot exportiert nur den setup-Befehl', () => {
  assert.equal(bot.id, 'security-bot');
  assert.equal(bot.tokenEnv, 'SECURITY_BOT_TOKEN');
  assert.equal(bot.name, 'Security Bot');
  assert.deepEqual(Object.keys(bot).sort(), ['create', 'id', 'intents', 'name', 'tokenEnv']);
});
