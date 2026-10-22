const { test } = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../bots/security-bot/src/ui');
const logging = require('../bots/security-bot/src/logging');
const { adminRequiredPayload, teamOnlyPayload } = require('../bots/security-bot/src/guard');
const { orderPanel } = require('../bots/security-bot/src/orders');
const { dmGuildOwner, notifyMissingAdmin } = require('../bots/security-bot/src/notices');
const { sendPublicNotice, sendDirectMessage } = require('../bots/security-bot/src/moderator');
const { handleInteraction } = require('../bots/security-bot/src/interactions');
const { patchComponents, readState } = require('../bots/security-bot/src/feedback');
const { decodeHidden } = require('../bots/security-bot/src/hidden');
const { t } = require('../bots/security-bot/src/languages');
const {
  makeGuild, makeChannel, makeCtx, makeInteraction, makeMessage,
  textsOf, allComponentsOf,
} = require('./security-fakes');

function assertV2(payload) {
  assert.equal(payload.flags & ui.FLAG_V2, ui.FLAG_V2);
  assert.ok(payload.components.length > 0);
  assert.ok(payload.components.every((c) => c.type === 17), 'alle Inhalte stehen in Containern');
  assert.ok(!Object.hasOwn(payload, 'content'));
  assert.ok(!Object.hasOwn(payload, 'embeds'));
  assert.doesNotMatch(textsOf(payload), /\[object Object\]/);
}

function assertLog(payload, lang = 'en') {
  assertV2(payload);
  const buttons = allComponentsOf(payload).filter((c) => c.custom_id?.startsWith('ord:new:'));
  assert.equal(buttons.length, 1, 'genau ein Auftragsbutton pro Log-Nachricht');
  assert.equal(buttons[0].style, ui.STYLE.secondary, 'grauer Button');
  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[0].label, t(lang, 'orderButton'));
}

function scenario() {
  const log = makeChannel({ id: 'log1' });
  const channel = makeChannel({ id: 'chat1' });
  const guild = makeGuild({ id: 'g1', channels: [log, channel] });
  const ctx = makeCtx({ guilds: [guild] });
  ctx.store.updateGuild(guild.id, { lang: 'en', logChannelId: log.id, setup: { done: true } });
  return { ctx, guild, log, channel };
}

test('Hinweise, Fehler, Limits, Setup-Abschluss und beliebige Log-Einträge sind V2 mit Auftragsbutton', async () => {
  const { ctx, guild, log } = scenario();
  await logging.logNotice(ctx, guild, { lang: 'en', lines: ['Notice'] });
  await logging.logError(ctx, guild, { lang: 'en', detail: 'Error' });
  await logging.logRateLimit(ctx, guild, { lang: 'en', resetText: '1 minute', pending: 3 });
  await logging.logSetupDone(ctx, guild, { lang: 'en' });
  const plain = ui.payload([ui.container([ui.text('Another log')])]);
  const before = JSON.stringify(plain);
  await logging.sendToLog(ctx, guild, plain);
  assert.equal(JSON.stringify(plain), before, 'Originalpayload bleibt unverändert');
  assert.equal(log.sent.length, 5);
  for (const payload of log.sent) {
    assertLog(payload);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
  }

  const open = makeInteraction({ guild, customId: 'ord:new:none' });
  await handleInteraction(ctx, open);
  assertV2(open.replies[0]);
  assert.equal(open.replies[0].flags & ui.FLAG_EPHEMERAL, ui.FLAG_EPHEMERAL);
  assert.ok(allComponentsOf(open.replies[0]).some((c) => c.custom_id === 'ord:create'));
});

test('Auch die direkte Ankündigung eines neu angelegten Log-Kanals hat einen lokalisierten Auftragsbutton', async () => {
  const { ctx, guild, log } = scenario();
  guild.channelCache.delete(log.id);
  const result = await logging.ensureLogChannel(ctx, guild);
  assert.equal(result.recreated, true);
  assert.equal(result.channel.sent.length, 1);
  assertLog(result.channel.sent[0]);
});

test('Moderationslog bleibt V2 mit echtem Divider und genau einem Auftrag nach Feedback-Updates', async () => {
  const payload = logging.buildModerationLog({
    lang: 'en', actionLine: 'Warning', userLine: 'Member', ruleLine: 'S1',
    state: { up: 0, down: 0, voters: {}, penalties: ['p1'] },
  });
  assertLog(payload);
  assert.ok(allComponentsOf(payload).some((c) => c.type === 14 && c.divider));
  const before = JSON.stringify(payload);
  const patched = { flags: ui.FLAG_V2, components: patchComponents(payload.components, {
    up: 1, down: 0, voters: { admin1: 1 }, penalties: ['p1'],
  }) };
  assert.equal(JSON.stringify(payload), before, 'Feedback klont auch verschachtelte Komponenten');
  assertLog(patched);
  assert.equal(readState(patched).up, 1);
  assert.equal(decodeHidden(textsOf(patched)).length, 1, 'Zustand wird nur einmal gespeichert');
  assert.doesNotMatch(JSON.stringify(patched), /__patched/);
  const again = { flags: ui.FLAG_V2, components: patchComponents(patched.components, {
    up: 1, down: 1, voters: { admin1: 1, admin2: -1 }, penalties: [],
  }) };
  assertLog(again);
  assert.equal(readState(again).down, 1);
  assert.equal(decodeHidden(textsOf(again)).length, 1);
  assert.equal(logging.withOrderButton(payload, 'en'), payload, 'vorhandene Buttons werden nicht verdoppelt');
});

test('Rechtehinweise, Panels, DMs, öffentliche Antworten und Fehlerantworten sind V2-Container', async () => {
  const { ctx, guild, channel } = scenario();
  for (const payload of [adminRequiredPayload('en'), teamOnlyPayload('en'), orderPanel('en')]) assertV2(payload);
  await dmGuildOwner(ctx, guild);
  assertV2(guild.ownerDms[0]);
  await notifyMissingAdmin(ctx, guild, { force: true });
  await sendDirectMessage({ ctx, userId: 'u1', text: 'Warning' });
  assertV2(ctx.dms[0].payload);

  const message = makeMessage({ id: 'm1', channel, guild });
  channel.messages.cache.set(message.id, message);
  const record = { channelId: channel.id, messageId: message.id, authorId: 'u1' };
  await sendPublicNotice({ ctx, guild, record, text: 'Public warning' });
  assertV2(message.replies[0]);
  assert.deepEqual(message.replies[0].allowedMentions.users, ['u1']);
  channel.messages.cache.clear();
  await sendPublicNotice({ ctx, guild, record, text: 'Fallback warning' });
  assertV2(channel.sent[0]);

  const dm = makeInteraction({ guild: null, kind: 'command', commandName: 'setup' });
  await handleInteraction(ctx, dm);
  assertV2(dm.replies[0]);
  assert.equal(dm.replies[0].flags & ui.FLAG_EPHEMERAL, ui.FLAG_EPHEMERAL);

  const failing = makeInteraction({ guild, kind: 'button', customId: 'setup:nav:back' });
  failing.update = async () => { throw new Error('Test error'); };
  await handleInteraction(ctx, failing);
  assertV2(failing.replies[0]);
  assert.match(textsOf(failing.replies[0]), /Test error/);
});

test('Öffentliche Fallback-Nachrichten im Log-Kanal bekommen ebenfalls den Auftragsbutton', async () => {
  const { ctx, guild, log } = scenario();
  guild.fetchOwner = async () => ({ send: async () => { throw new Error('DM closed'); } });
  guild.systemChannel = log;
  await dmGuildOwner(ctx, guild);
  assertLog(log.sent[0]);
  await sendPublicNotice({ ctx, guild, record: { channelId: log.id, messageId: 'gone', authorId: 'u1' }, text: 'Warning' });
  assertLog(log.sent[1]);
});
