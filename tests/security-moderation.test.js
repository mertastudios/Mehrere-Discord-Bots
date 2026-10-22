/**
 * Moderation & Feedback:
 * Maßnahmen ausführen (warn/timeout/kick/ban), Immunität, Herabstufen,
 * eine Maßnahme pro Person, Strafregister, Log mit 👍/👎 (unsichtbarer Zähler),
 * Feedback-Formular inkl. Entfernen aus dem Strafregister und Aufträge.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyModerations, measureText, fallbackUserMessage } = require('../bots/security-bot/src/moderator');
const { buildModerationLog } = require('../bots/security-bot/src/logging');
const feedback = require('../bots/security-bot/src/feedback');
const orders = require('../bots/security-bot/src/orders');
const { createBudgetSet } = require('../bots/security-bot/src/budget');
const { decodeLogState } = require('../bots/security-bot/src/hidden');
const { handleInteraction } = require('../bots/security-bot/src/interactions');
const {
  makeGuild,
  makeChannel,
  makeMember,
  makeMessage,
  makeCtx,
  makeInteraction,
  makeComponentMessage,
  textsOf,
  allComponentsOf,
} = require('./security-fakes');

function scenario({ allow = { timeout: true, kick: false, ban: false }, logChannelId = 'log1', content = 'Du bist ein Idiot' } = {}) {
  const channel = makeChannel({ id: 'c1', name: 'chat' });
  const log = makeChannel({ id: 'log1', name: 'mod-log' });
  const guild = makeGuild({ id: 'g1', name: 'Testserver', ownerId: 'owner1', channels: [channel, log] });

  const target = makeMember({ id: 'u2', displayName: 'Ben' });
  const admin = makeMember({ id: 'admin1', displayName: 'Admin', administrator: true });
  guild.memberCache.set(target.id, target);
  guild.memberCache.set(admin.id, admin);

  const message = makeMessage({ id: 'm1', content, channel, guild, author: { id: 'u2', username: 'Ben' }, member: target });
  channel.messages.cache.set('m1', message);

  const ctx = makeCtx({ guilds: [guild], env: { SECURITY_BOT_OWNER_ID: 'owner1' } });
  ctx.budget = createBudgetSet((k, d) => d);
  ctx.store.updateGuild('g1', { allow, logChannelId, lang: 'de', setup: { done: true } });

  const record = {
    key: 'g1:c1:m1',
    guildId: 'g1',
    channelId: 'c1',
    channelName: 'chat',
    messageId: 'm1',
    authorId: 'u2',
    authorName: 'Ben',
    content,
    createdAt: Date.now(),
    immune: false,
    mentions: [],
    reply: null,
  };

  return { ctx, guild, channel, log, target, admin, message, record, idMap: new Map([[1, record]]) };
}

function logChannelOf(guild, ctx) {
  const cfg = ctx.store.getGuild(guild.id);
  return guild.channelCache.get(cfg.logChannelId);
}

// ------------------------------ Maßnahmen ------------------------------

test('Verwarnung: Ping-Antwort im Kanal, DM, Eintrag im Strafregister, Log', async () => {
  const { ctx, guild, target, message, idMap } = scenario();
  guild.iconURL = () => 'https://cdn.discordapp.com/icons/g1/server.png';

  const result = await applyModerations({
    ctx,
    guild,
    idMap,
    decisions: [
      { nachricht_id: 1, regel_id: 'S1', massnahme: 'warn', dauer: 'keine', begruendung: 'Beleidigung', nutzer_nachricht: 'Jetzt reichts, Ben. Das war eine Beleidigung.', konfidenz: 90 },
    ],
  });

  assert.equal(result.applied.length, 1);
  assert.equal(target.timeouts.length, 0, 'Warnen greift nicht in den Account ein');
  assert.match(message.replies[0].components[0].components[0].content, /^<@u2> Jetzt reichts, Ben/);
  assert.equal(ctx.dms.filter((d) => d.id === 'u2').length, 1, 'Nutzer bekommt eine DM');
  const dm = ctx.dms.find((d) => d.id === 'u2').payload;
  const dmText = textsOf(dm);
  assert.equal(dm.components[0].accent_color, 0xed4245, 'roter DM-Container');
  assert.match(dmText, /Du hast auf „Testserver“ gegen die Regeln verstoßen\./);
  assert.match(dmText, /\*\*Maßnahme:\*\* Verwarnung/);
  assert.match(dmText, /Siehe hier für weitere Informationen/);
  assert.ok(dmText.includes(`https://discord.com/channels/g1/c1/${result.applied[0].publicMessage.id}`));
  assert.ok(allComponentsOf(dm).some((c) => c.type === 11 && c.media?.url === 'https://cdn.discordapp.com/icons/g1/server.png'));

  const penalties = ctx.store.listPenalties('g1', { userId: 'u2' });
  assert.equal(penalties.length, 1);
  assert.equal(penalties[0].ruleLabel, 'S1 Beleidigung & Belästigung');
  assert.equal(penalties[0].action, 'warn');

  const logChannel = logChannelOf(guild, ctx);
  assert.ok(logChannel.sent.length >= 1, 'Es gibt eine Log-Meldung');
  const logText = textsOf(logChannel.sent[0]);
  assert.match(logText, /Maßnahme|Moderation/);
  assert.match(logText, /S1 Beleidigung/);
  assert.match(logText, /Idiot/);
});

test('Log-Meldung hat 👍/👎 mit Zähler, „Neuer Auftrag“ und unsichtbaren Zustand', async () => {
  const { ctx, guild, idMap } = scenario();
  const result = await applyModerations({
    ctx,
    guild,
    idMap,
    decisions: [{ nachricht_id: 1, regel_id: 'S1', massnahme: 'warn', dauer: 'keine', begruendung: 'x', nutzer_nachricht: 'y', konfidenz: 50 }],
  });

  const logChannel = logChannelOf(guild, ctx);
  const payload = logChannel.sent[0];
  const components = allComponentsOf(payload);
  const buttons = components.filter((c) => c.type === 2);

  assert.deepEqual(buttons.map((b) => b.label), ['👍 (0)', '👎 (0)', 'Neuer Auftrag']);
  assert.equal(buttons[0].style, 3, 'grüner Button');
  assert.equal(buttons[1].style, 4, 'roter Button');
  assert.ok(buttons[2].custom_id.startsWith('ord:new:'));

  const state = decodeLogState(textsOf(payload));
  assert.deepEqual(state.penalties, [result.applied[0].penalty.id]);
  assert.equal(state.up, 0);
  assert.equal(state.down, 0);
});

test('Timeout: Dauer wird gesetzt und im Register vermerkt', async () => {
  const { ctx, guild, target, idMap } = scenario();

  await applyModerations({
    ctx,
    guild,
    idMap,
    decisions: [{ nachricht_id: 1, regel_id: 'C2', massnahme: 'timeout', dauer: '1h', begruendung: 'Beleidigt', nutzer_nachricht: 'Pause für dich.', konfidenz: 80 }],
  });

  assert.equal(target.timeouts.length, 1);
  assert.equal(target.timeouts[0].ms, 3600 * 1000);
  assert.equal(ctx.store.listPenalties('g1', { userId: 'u2' })[0].duration, '1h');
});

test('Kick und Ban laufen nur, wenn sie erlaubt sind – sonst Herabstufung', async () => {
  const { ctx, guild, target, idMap } = scenario({ allow: { timeout: true, kick: false, ban: false } });
  const result = await applyModerations({
    ctx,
    guild,
    idMap,
    decisions: [{ nachricht_id: 1, regel_id: 'S3', massnahme: 'ban', dauer: 'keine', begruendung: 'Drohung', nutzer_nachricht: 'Ban.', konfidenz: 95 }],
  });

  assert.equal(result.applied[0].measure, 'timeout', 'Ban ist nicht erlaubt → Timeout');
  assert.equal(guild.bans, undefined, 'kein Bann ausgeführt');
  assert.match(textsOf(logChannelOf(guild, ctx).sent[0]), /herabgestuft/);

  const second = scenario({ allow: { timeout: false, kick: true, ban: true } });
  const kickResult = await applyModerations({
    ctx: second.ctx,
    guild: second.guild,
    idMap: second.idMap,
    decisions: [{ nachricht_id: 1, regel_id: 'S3', massnahme: 'kick', dauer: 'keine', begruendung: 'x', nutzer_nachricht: 'y', konfidenz: 70 }],
  });
  assert.equal(kickResult.applied[0].measure, 'kick');
  assert.equal(second.target.kicks.length, 1);
});

test('Team-Mitglieder sind immun und werden nur als Kontext gelesen', async () => {
  const { ctx, guild, idMap, record } = scenario();
  record.immune = true;

  const result = await applyModerations({
    ctx,
    guild,
    idMap,
    decisions: [{ nachricht_id: 1, regel_id: 'S1', massnahme: 'warn', dauer: 'keine', begruendung: 'x', nutzer_nachricht: 'y', konfidenz: 50 }],
  });

  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].reason, 'immun');
  assert.equal(ctx.store.listPenalties('g1').length, 0);
});

test('Pro Person genau eine Maßnahme – die schwerste gewinnt', async () => {
  const { ctx, guild, target, idMap } = scenario({ allow: { timeout: true, kick: false, ban: false } });

  const result = await applyModerations({
    ctx,
    guild,
    idMap,
    decisions: [
      { nachricht_id: 1, regel_id: 'S1', massnahme: 'warn', dauer: 'keine', begruendung: 'klein', nutzer_nachricht: 'a', konfidenz: 40 },
      { nachricht_id: 1, regel_id: 'S3', massnahme: 'timeout', dauer: '10m', begruendung: 'schwer', nutzer_nachricht: 'b', konfidenz: 80 },
    ],
  });

  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].measure, 'timeout');
  assert.equal(target.timeouts.length, 1);
  assert.equal(ctx.store.listPenalties('g1', { userId: 'u2' }).length, 1);
});

test('Unbekannte IDs und verschwundene Nutzer werden sauber übersprungen', async () => {
  const { ctx, guild, idMap } = scenario();
  const unknown = await applyModerations({
    ctx,
    guild,
    idMap,
    decisions: [{ nachricht_id: 99, regel_id: 'S1', massnahme: 'warn', dauer: 'keine', begruendung: 'x', nutzer_nutzer: '', nutzer_nachricht: 'y', konfidenz: 10 }],
  });
  assert.equal(unknown.skipped[0].reason, 'unbekannte_id');

  const { ctx: ctx2, guild: guild2, idMap: idMap2, target } = scenario();
  guild2.memberCache.delete(target.id);
  const gone = await applyModerations({
    ctx: ctx2,
    guild: guild2,
    idMap: idMap2,
    decisions: [{ nachricht_id: 1, regel_id: 'S1', massnahme: 'timeout', dauer: '1h', begruendung: 'x', nutzer_nachricht: 'y', konfidenz: 60 }],
  });
  assert.equal(gone.skipped.some((s) => s.reason === 'nutzer_weg'), true);
});

test('Fallback-Nachricht und Maßnahmen-Text klingen menschlich', () => {
  assert.match(fallbackUserMessage({ lang: 'de', userName: 'Ben', action: 'ban', ruleText: 'S1 Beleidigung' }), /Jetzt reichts, Ben/);
  assert.match(fallbackUserMessage({ lang: 'en', userName: 'Ben', action: 'warn', ruleText: 'S1' }), /That's enough, Ben/);
  assert.equal(measureText('timeout', 3600, 'de'), 'Timeout (1h)');
  assert.equal(measureText('warn', 0, 'de'), 'Verwarnung');
});

test('Strafregister fließt in die KI-Anfrage ein', async () => {
  const { ctx, guild, idMap } = scenario();
  await applyModerations({
    ctx,
    guild,
    idMap,
    decisions: [{ nachricht_id: 1, regel_id: 'S1', massnahme: 'timeout', dauer: '1d', begruendung: 'Wiederholung', nutzer_nachricht: 'y', konfidenz: 90 }],
  });

  const register = ctx.store.registerForPrompt('g1', { userIds: ['u2'], sinceMs: Date.now() - 30 * 24 * 3600 * 1000 });
  assert.match(register, /Ben \(user_id=u2\): 1 Eintrag/);
  assert.match(register, /S1 Beleidigung/);
  assert.match(register, /timeout \(1d\)/);
});

// ------------------------------ Feedback ------------------------------

test('👍-Button öffnet das Formular; ohne Register-Eintrag ohne Häkchen', async () => {
  const { ctx, guild, admin } = scenario();
  const payload = buildModerationLog({
    lang: 'de',
    actionLine: '⚠️ **Verwarnung**',
    userLine: 'Ben',
    ruleLine: 'S1 Beleidigung',
    quoteLine: '„Idiot“',
    reasonLine: 'Beleidigung',
    state: { up: 0, down: 0, voters: {}, penalties: [] },
  });
  const message = makeComponentMessage({ payload });

  const up = makeInteraction({ guild, member: admin, customId: 'fb:up:p1', kind: 'button', message });
  await handleInteraction(ctx, up);

  assert.equal(up.modals.length, 1);
  assert.match(up.modals[0].components[0].label, /gut/);
  assert.equal(up.modals[0].components.length, 1, 'ohne Register-Eintrag kein Häkchen');
});

test('👎-Button bietet das Entfernen aus dem Strafregister an', async () => {
  const { ctx, guild, admin } = scenario();
  const penalty = ctx.store.addPenalty({ guildId: 'g1', userId: 'u2', userName: 'Ben', action: 'timeout', duration: '1h', ruleId: 'S1', ruleLabel: 'S1 Beleidigung' });

  const payload = buildModerationLog({
    lang: 'de',
    actionLine: '⏳ **Timeout (1h)**',
    userLine: 'Ben',
    ruleLine: 'S1 Beleidigung',
    quoteLine: '„Idiot“',
    reasonLine: 'Beleidigung',
    state: { up: 0, down: 0, voters: {}, penalties: [penalty.id] },
  });
  const message = makeComponentMessage({ payload });

  const down = makeInteraction({ guild, member: admin, customId: `fb:down:${penalty.id}`, kind: 'button', message });
  await handleInteraction(ctx, down);

  const modal = down.modals[0];
  assert.equal(modal.components.length, 2);
  assert.match(modal.components[0].label, /schlecht/);
  assert.equal(modal.components[1].component.type, 22, 'Häkchen-Feld');
  assert.equal(modal.components[1].component.options[0].default, false, 'Haken ist noch weg');
  assert.match(modal.components[1].component.options[0].label, /Strafregister/);
});

test('Jeder kann nur einmal abstimmen', async () => {
  const { ctx, guild, admin } = scenario();
  const payload = buildModerationLog({
    lang: 'de',
    actionLine: '⚠️ **Verwarnung**',
    userLine: 'Ben',
    ruleLine: 'S1',
    quoteLine: 'x',
    reasonLine: 'y',
    state: { up: 1, down: 0, voters: { admin1: 1 }, penalties: [] },
  });
  const message = makeComponentMessage({ payload });

  const again = makeInteraction({ guild, member: admin, customId: 'fb:up:p1', kind: 'button', message });
  await handleInteraction(ctx, again);

  assert.equal(again.modals.length, 0);
  assert.match(textsOf(again.replies[0]), /schon abgestimmt/);
});

test('Feedback absenden: Zähler, Danke-DM, Owner-Info und Register-Entfernung', async () => {
  const { ctx, guild, admin } = scenario();
  const penalty = ctx.store.addPenalty({ guildId: 'g1', userId: 'u2', userName: 'Ben', action: 'timeout', duration: '1d', ruleId: 'C1', ruleLabel: 'C1 Keine Beleidigungen' });

  const payload = buildModerationLog({
    lang: 'de',
    actionLine: '⏳ **Timeout (1d)**',
    userLine: 'Ben',
    ruleLine: 'C1 Keine Beleidigungen',
    quoteLine: '„Idiot“',
    reasonLine: 'Beleidigung',
    state: { up: 0, down: 0, voters: {}, penalties: [penalty.id] },
  });
  const message = makeComponentMessage({ payload });

  const modal = makeInteraction({
    guild,
    member: admin,
    customId: 'fb:modal:down',
    kind: 'modal',
    message,
    fields: { reason: 'War zu hart, war nur Spaß', remove: ['yes'] },
  });
  await handleInteraction(ctx, modal);

  // 1) Danke – privat
  assert.match(textsOf(modal.replies[0]), /Danke/);

  // 2) Log-Nachricht neu geschrieben: Zähler + kein Register-Eintrag mehr
  const edited = message.edits.at(-1);
  const buttons = allComponentsOf(edited).filter((c) => c.type === 2);
  assert.equal(buttons[0].label, '👍 (0)');
  assert.equal(buttons[1].label, '👎 (1)');
  const state = decodeLogState(textsOf(edited));
  assert.equal(state.down, 1);
  assert.deepEqual(state.voters, { admin1: -1 });
  assert.deepEqual(state.penalties, []);

  // 3) Eintrag ist wirklich weg
  assert.equal(ctx.store.getPenalty(penalty.id), null);

  // 4) Entfernung steht im Log – mit Namen
  const logChannel = logChannelOf(guild, ctx);
  assert.ok(logChannel.sent.some((p) => /Strafregister entfernt/.test(textsOf(p)) && /Admin/.test(textsOf(p))));

  // 5) Der Bot-Owner bekommt die Entscheidung + Bewertung + Grund
  const owner = ctx.dms.find((d) => d.id === 'owner1');
  assert.ok(owner, 'Owner wurde informiert');
  const ownerText = textsOf(owner.payload);
  assert.match(ownerText, /👎 schlecht/);
  assert.match(ownerText, /War zu hart/);
});

// ------------------------------ Aufträge ------------------------------

function orderFetch(verdict) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      model: 'openai/gpt-oss-120b',
      choices: [{ message: { content: JSON.stringify(verdict) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
    }),
    text: async () => '',
  });
}

test('Auftrag: Panel und Formular', async () => {
  const { ctx, guild, admin } = scenario();

  const panel = makeInteraction({ guild, member: admin, customId: 'ord:new:none', kind: 'button' });
  await handleInteraction(ctx, panel);
  assert.match(textsOf(panel.replies[0]), /Auftrag/);

  const create = makeInteraction({ guild, member: admin, customId: 'ord:create', kind: 'button' });
  await handleInteraction(ctx, create);
  assert.equal(create.modals.length, 1);
  assert.deepEqual(create.modals[0].components.map((c) => c.component.custom_id), ['ids', 'instruction']);
});

test('Auftrag wird ausgeführt – im Log steht der Moderator', async () => {
  const { ctx, guild, admin, channel } = scenario();
  ctx.fetchFn = orderFetch({
    verstanden: true,
    hinweis: 'klarer Fall',
    verstoesse: [
      { nachricht_id: 1, regel_id: 'S1', massnahme: 'ban', dauer: 'keine', begruendung: 'Beleidigung', nutzer_nachricht: 'Du bist raus, Ben.', konfidenz: 95 },
    ],
  });
  ctx.store.updateGuild('g1', { allow: { timeout: true, kick: true, ban: true }, groqKey: 'gsk_test' });

  const target = guild.memberCache.get('u2');
  const targetId = '123456789012345678';
  const message = makeMessage({ id: targetId, content: 'Du Dummkopf', channel, guild, author: { id: 'u2', username: 'Ben' }, member: target });
  channel.messages.cache.set(targetId, message);

  const modal = makeInteraction({
    guild,
    member: admin,
    customId: 'ord:modal:create',
    kind: 'modal',
    fields: { ids: targetId, instruction: 'Banne ihn' },
  });
  await handleInteraction(ctx, modal);

  const penalties = ctx.store.listPenalties('g1', { userId: 'u2' });
  assert.equal(penalties.length, 1);
  assert.equal(penalties[0].source, 'order');
  assert.equal(penalties[0].forcedBy, 'admin1');
  assert.equal(penalties[0].action, 'ban');
  assert.ok(guild.bans?.length === 1, 'Ban wurde ausgeführt');

  const logText = textsOf(logChannelOf(guild, ctx).sent.at(-1));
  assert.match(logText, /Auftrag von/);
  assert.match(logText, /Admin/);
  assert.match(logText, /Banne ihn/);
  assert.ok(!/Banne ihn/.test(textsOf(channel.sent.at(-1))), 'Im Kanal steht nichts vom Auftrag');
});

test('Auftrag bei Groq-Limit: klare Warteschlange und Entfernen-Button', async () => {
  const { ctx, guild, admin, channel, log } = scenario();
  ctx.store.updateGuild('g1', { groqKey: 'gsk_test' });
  const targetId = '123456789012345680';
  channel.messages.cache.set(
    targetId,
    makeMessage({ id: targetId, content: 'Du Dummkopf', channel, guild, author: { id: 'u2', username: 'Ben' }, member: guild.memberCache.get('u2') })
  );
  ctx.budget.smart.canSpend = () => ({ ok: false, reason: 'tpd', resetInMs: 60_000 });

  const modal = makeInteraction({
    guild,
    member: admin,
    customId: 'ord:modal:create',
    kind: 'modal',
    fields: { ids: targetId, instruction: 'Verwarne ihn' },
  });
  await handleInteraction(ctx, modal);

  const queued = modal.edits.at(-1);
  assert.match(textsOf(queued), /Warteschlange/);
  assert.match(textsOf(queued), /nicht verworfen/);
  assert.match(textsOf(queued), /Groq-Limit/);
  assert.match(textsOf(log.sent.at(-1)), /Warteschlange/);
  const remove = allComponentsOf(queued).find((c) => c.custom_id?.startsWith('ord:cancel:'));
  assert.ok(remove, 'Entfernen-Button ist sichtbar');
  assert.equal(remove.style, 4);

  const queue = orders.orderQueueFor(ctx, guild.id);
  assert.equal(queue.size, 1);
  assert.equal([...queue.values()][0].instruction, 'Verwarne ihn');

  const cancel = makeInteraction({ guild, member: admin, customId: remove.custom_id, kind: 'button' });
  await handleInteraction(ctx, cancel);
  assert.equal(queue.size, 0);
  assert.match(textsOf(cancel.updates.at(-1)), /aus der Warteschlange entfernt/);
  assert.equal(ctx.store.listPenalties('g1').length, 0);
});

test('Auftrag nach Groq-Fehler: automatischer Retry aus der Warteschlange', async () => {
  const { ctx, guild, admin, channel } = scenario();
  ctx.store.updateGuild('g1', { groqKey: 'gsk_test' });
  const targetId = '123456789012345681';
  channel.messages.cache.set(
    targetId,
    makeMessage({ id: targetId, content: 'Du Dummkopf', channel, guild, author: { id: 'u2', username: 'Ben' }, member: guild.memberCache.get('u2') })
  );
  ctx.fetchFn = async () => {
    throw new Error('offline');
  };

  const modal = makeInteraction({
    guild,
    member: admin,
    customId: 'ord:modal:create',
    kind: 'modal',
    fields: { ids: targetId, instruction: 'Verwarne ihn' },
  });
  await handleInteraction(ctx, modal);
  assert.match(textsOf(modal.edits.at(-1)), /Warteschlange/);
  assert.match(textsOf(modal.edits.at(-1)), /Groq-Fehler/);

  const queue = orders.orderQueueFor(ctx, guild.id);
  const order = [...queue.values()][0];
  assert.ok(order.retryAt > Date.now());
  ctx.fetchFn = orderFetch({
    verstanden: true,
    verstoesse: [
      { nachricht_id: 1, regel_id: 'S1', massnahme: 'warn', dauer: 'keine', begruendung: 'Beleidigung', nutzer_nachricht: 'Das war eine Beleidigung.', konfidenz: 95 },
    ],
  });

  const retried = await orders.processOrderQueue(ctx, guild, { now: order.retryAt });
  assert.equal(retried.processed, 1);
  assert.equal(retried.pending, 0);
  assert.equal(ctx.store.listPenalties('g1', { userId: 'u2' }).length, 1);
});

test('Unklare Anweisung landet als „Keine klare Anweisung verstanden“ im Log', async () => {
  const { ctx, guild, admin, channel } = scenario();
  ctx.fetchFn = orderFetch({ verstanden: false, hinweis: 'Keine Maßnahme erkennbar', verstoesse: [] });
  ctx.store.updateGuild('g1', { groqKey: 'gsk_test' });

  const targetId = '123456789012345679';
  channel.messages.cache.set(
    targetId,
    makeMessage({ id: targetId, content: 'Hm', channel, guild, author: { id: 'u2', username: 'Ben' }, member: guild.memberCache.get('u2') })
  );

  const modal = makeInteraction({
    guild,
    member: admin,
    customId: 'ord:modal:create',
    kind: 'modal',
    fields: { ids: targetId, instruction: 'schau mal' },
  });
  await handleInteraction(ctx, modal);

  assert.equal(ctx.store.listPenalties('g1').length, 0);
  const logText = textsOf(logChannelOf(guild, ctx).sent.at(-1));
  assert.match(logText, /Keine klare Anweisung verstanden/);
  assert.match(logText, /Admin/);
  assert.match(textsOf(modal.edits.at(-1)), /Keine klare Anweisung/);
});

test('Nachricht per ID finden (Puffer und Kanal)', async () => {
  const { ctx, guild, channel } = scenario();
  ctx.store.addBuffered('g1', { key: 'k', guildId: 'g1', channelId: 'c1', messageId: 'm1', content: 'x', createdAt: Date.now() });

  const found = await orders.findMessage(ctx, guild, 'm1');
  assert.equal(found.id, 'm1');

  const missing = await orders.findMessage(ctx, guild, 'gibt-es-nicht');
  assert.equal(missing, null);
  assert.ok(channel.messages.cache.has('m1'));
});
