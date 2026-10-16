/**
 * Pipeline: Nachricht kommt an → Puffer → Urteil → Maßnahme.
 * Dazu: Limit-Schonung (nichts geht verloren) und Prompt-Aufbau.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { handleIncoming, tickGuild, pickBatch, MAX_TRANSCRIPT_TOKENS } = require('../bots/security-bot/src/pipeline');
const { createBudgetSet } = require('../bots/security-bot/src/budget');
const { buildSystemPrompt, buildUserPrompt, verdictSchema, measuresFor } = require('../bots/security-bot/src/prompts');
const { buildRulesBlock } = require('../bots/security-bot/src/rules');
const {
  makeGuild,
  makeChannel,
  makeMember,
  makeMessage,
  makeCtx,
  textsOf,
} = require('./security-fakes');

function verdictFetch(verstoesse = [], extra = {}) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        model: body.model,
        choices: [{ message: { content: JSON.stringify({ verstoesse, ...extra }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1500, completion_tokens: 200, total_tokens: 1700 },
      }),
      text: async () => '',
    };
  };
}

function pipelineScenario({ allow = { timeout: true, kick: false, ban: false } } = {}) {
  const channel = makeChannel({ id: 'c1', name: 'chat' });
  const guild = makeGuild({ id: 'g1', name: 'Testserver', channels: [channel] });
  const author = makeMember({ id: 'u2', displayName: 'Ben' });
  guild.memberCache.set(author.id, author);

  const ctx = makeCtx({ guilds: [guild] });
  ctx.budget = createBudgetSet((k, d) => d);
  ctx.store.updateGuild('g1', { allow, rules: '1. Seid nett zueinander', groqKey: 'gsk_test' });
  return { ctx, guild, channel, author };
}

test('Nachricht annehmen → Puffer, Urteil, Maßnahme, Puffer leer', async () => {
  const { ctx, guild, channel, author } = pipelineScenario();
  ctx.fetchFn = verdictFetch([
    { nachricht_id: 1, regel_id: 'C1', massnahme: 'timeout', dauer: '10m', begruendung: 'Beleidigt', nutzer_nachricht: 'Zehn Minuten Pause, Ben.', konfidenz: 88 },
  ]);

  const message = makeMessage({
    id: 'm1',
    content: 'Das war echt unnötig von dir, ehrlich',
    channel,
    guild,
    author: { id: 'u2', username: 'Ben' },
    member: author,
  });
  channel.messages.cache.set('m1', message);

  await handleIncoming({ ctx, message });
  assert.equal(ctx.store.pendingCount('g1'), 1);

  const result = await tickGuild(ctx, 'g1', { force: true });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1);
  assert.equal(author.timeouts.length, 1);
  assert.equal(author.timeouts[0].ms, 600 * 1000);
  assert.equal(ctx.store.pendingCount('g1'), 0, 'geprüfte Nachrichten verlassen den Puffer');
  assert.match(textsOf(message.replies.at(-1)), /Zehn Minuten Pause/);
});

test('Team-Nachrichten werden gesammelt, aber nie bestraft', async () => {
  const { ctx, guild, channel } = pipelineScenario();
  const admin = makeMember({ id: 'admin1', displayName: 'Admin', administrator: true });
  guild.memberCache.set(admin.id, admin);

  const message = makeMessage({
    id: 'm2',
    content: 'Jetzt reißt euch zusammen',
    channel,
    guild,
    author: { id: 'admin1', username: 'Admin' },
    member: admin,
  });

  await handleIncoming({ ctx, message });
  assert.equal(ctx.store.getBuffer('g1')[0].immune, true);
});

test('Ohne Administrator-Rechte passiert gar nichts', async () => {
  const { ctx, guild, channel } = pipelineScenario();
  guild.members.me.permissions = { has: () => false };

  await handleIncoming({ ctx, message: makeMessage({ id: 'm3', content: 'Hallo', channel, guild }) });
  assert.equal(ctx.store.pendingCount('g1'), 0);
  assert.equal((await tickGuild(ctx, 'g1', { force: true })).error, 'no_admin');
});

test('Nicht überwachter Kanal wird ignoriert', async () => {
  const { ctx, guild, channel } = pipelineScenario();
  ctx.store.updateGuild('g1', { channels: ['anderer'] });

  await handleIncoming({ ctx, message: makeMessage({ id: 'm4', content: 'Hallo', channel, guild }) });
  assert.equal(ctx.store.pendingCount('g1'), 0);
});

test('Bei erreichtem Groq-Budget bleibt der Puffer unangetastet', async () => {
  const { ctx, guild, channel, author } = pipelineScenario();
  // Mini-Budget: das Tageslimit ist kleiner als eine Anfrage
  ctx.budget = createBudgetSet((k, d) => (k === 'SECURITY_GROQ_TPD' ? '1500' : k === 'SECURITY_GROQ_RESERVE' ? '0' : d));
  let calls = 0;
  ctx.fetchFn = async () => {
    calls += 1;
    return verdictFetch([])();
  };

  const message = makeMessage({ id: 'm5', content: 'Hallo zusammen', channel, guild, author: { id: 'u2', username: 'Ben' }, member: author });
  await handleIncoming({ ctx, message });

  const result = await tickGuild(ctx, 'g1', { force: true });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'rate_limited');
  assert.equal(ctx.store.pendingCount('g1'), 1, 'Nachrichten bleiben erhalten');
  assert.equal(calls, 0, 'kein API-Aufruf bei gesperrtem Budget');
});

test('Batches bleiben im Token-Budget (die neuesten Nachrichten zählen)', () => {
  const records = Array.from({ length: 60 }, (_, i) => ({
    key: `k${i}`,
    content: 'x'.repeat(400),
    createdAt: Date.now() - (60 - i) * 1000,
  }));
  const picked = pickBatch(records, { maxTokens: MAX_TRANSCRIPT_TOKENS });
  assert.ok(picked.length >= 4 && picked.length < records.length);
  assert.equal(picked.at(-1).key, 'k59', 'die neuesten sind dabei');
});

test('Prompt-Aufbau: Systemregeln, Serverregeln, Anweisungen, Maßnahmen, Sicherheit', () => {
  const system = buildSystemPrompt({
    guildName: 'Testserver',
    lang: 'de',
    rules: '1. Keine Beleidigungen',
    instructions: 'Bei Werbung sofort 1 Tag Timeout.',
    allow: { timeout: true, kick: false, ban: false },
    register: 'Ben (user_id=u2): 1 Eintrag',
  });

  assert.match(system, /SYSTEMREGELN/);
  assert.match(system, /S1 \[Beleidigung & Belästigung\]/);
  assert.match(system, /SERVERREGELN/);
  assert.match(system, /C1 \[Keine Beleidigungen\]/);
  assert.match(system, /Bei Werbung sofort 1 Tag Timeout/);
  assert.match(system, /Erlaubt sind: warn \(Verwarnung – immer erlaubt\), timeout\./);
  assert.ok(!system.includes('ban'), 'nicht erlaubte Maßnahmen stehen nicht im Prompt');
  assert.match(system, /Ben \(user_id=u2\): 1 Eintrag/);
  assert.match(system, /DATEN/);
  assert.match(system, /Deutsch/);

  const user = buildUserPrompt({ transcript: '[1] 10:00 Ben: "hallo"' });
  assert.match(user, /CHATVERLAUF/);
  assert.match(user, /\[1\] 10:00 Ben/);

  assert.deepEqual(measuresFor({ timeout: true, kick: false, ban: false }), ['warn', 'timeout']);
  const schema = verdictSchema({ allow: { timeout: true } });
  assert.deepEqual(schema.properties.verstoesse.items.properties.massnahme.enum, ['warn', 'timeout']);
  assert.equal(schema.additionalProperties, false);
  const orderSchema = verdictSchema({ allow: { timeout: true }, withOrder: true });
  assert.ok(orderSchema.required.includes('verstanden'));
  assert.match(buildRulesBlock(''), /S11/);
});
