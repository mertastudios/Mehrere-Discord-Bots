/**
 * /setup – der Assistent: Rechte, Fortschritt, alle 7 Schritte, Abschluss,
 * und die Wartung (Log-Kanal weg, Rolle weg, Server weg).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const setup = require('../bots/security-bot/src/setup');
const { FLAG_V2 } = require('../bots/security-bot/src/ui');
const { dmGuildOwner, notifyMissingAdmin } = require('../bots/security-bot/src/notices');
const maintenance = require('../bots/security-bot/src/maintenance');
const { handleInteraction } = require('../bots/security-bot/src/interactions');
const { handleIncoming } = require('../bots/security-bot/src/pipeline');
const { MAX_RULES_CHARS } = require('../bots/security-bot/src/rules');
const {
  makeGuild,
  makeChannel,
  makeMember,
  makeRole,
  makeMessage,
  makeCtx,
  makeInteraction,
  textsOf,
  allComponentsOf,
  silent,
} = require('./security-fakes');

function groqOkFetch(calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ object: 'list', data: [{ id: 'openai/gpt-oss-20b' }] }),
      text: async () => '',
    };
  };
}

function baseSetup() {
  const channel = makeChannel({ id: 'c1', name: 'allgemein' });
  const channel2 = makeChannel({ id: 'c2', name: 'offtopic' });
  const guild = makeGuild({ id: 'g1', name: 'Testserver', ownerId: 'owner1', channels: [channel, channel2] });
  const ctx = makeCtx({ guilds: [guild] });
  const admin = makeMember({ id: 'admin1', displayName: 'Admin', administrator: true });
  guild.memberCache.set(admin.id, admin);
  return { guild, ctx, admin, channel, channel2 };
}

test('Alle Setup-Schritte sind saubere Components-V2-Container mit Überschriften und Dividern', () => {
  const { guild, ctx } = baseSetup();

  for (let step = 1; step <= 7; step += 1) {
    const payload = setup.renderStep(ctx, guild, ctx.store.getGuild(guild.id), step);
    const container = payload.components[0];
    const header = container.components.find((component) => component.type === 10)?.content || '';
    const components = allComponentsOf(payload);

    assert.equal(payload.flags & FLAG_V2, FLAG_V2, `Schritt ${step} muss Components V2 sein`);
    assert.equal(container.type, 17);
    assert.ok(!Object.hasOwn(container, 'accent_color'), 'kein Embed-Farbrand');
    assert.match(header, /^# .*Setup · Schritt \d\/7\n## /);
    assert.doesNotMatch(textsOf(payload), /\[object Object\]/);
    assert.ok(components.filter((component) => component.type === 14 && component.divider).length >= 2);
  }
});

test('Weiter und Fertig sind für nicht eingerichtete Pflichtschritte deaktiviert', () => {
  const { guild, ctx } = baseSetup();
  const nextDisabled = (step) => allComponentsOf(setup.renderStep(ctx, guild, ctx.store.getGuild(guild.id), step))
    .find((component) => component.custom_id === 'setup:nav:next')?.disabled;
  const finishDisabled = allComponentsOf(setup.renderStep(ctx, guild, ctx.store.getGuild(guild.id), 7))
    .find((component) => component.custom_id === 'setup:nav:finish')?.disabled;

  assert.equal(nextDisabled(1), true);
  assert.equal(nextDisabled(2), true);
  assert.equal(nextDisabled(3), true);
  assert.equal(nextDisabled(4), true);

  ctx.store.updateGuild('g1', {
    channels: ['c1'],
    rulesMode: 'skip',
    setup: { step: 5, furthest: 5, configuredSteps: [1, 3] },
  });
  assert.equal(nextDisabled(5), false, 'sichere Standardmaßnahmen sind bereits konfiguriert');
  assert.equal(nextDisabled(6), true);
  assert.equal(finishDisabled, true);
});

// ------------------------------ Rechte ------------------------------

test('Ohne Administrator-Rechte verweigert der Bot alles – mit Begründung', async () => {
  const channel = makeChannel({ id: 'c1', name: 'allgemein' });
  const guild = makeGuild({ id: 'g1', botAdmin: false, channels: [channel] });
  const ctx = makeCtx({ guilds: [guild] });
  const interaction = makeInteraction({ guild, member: makeMember({ administrator: true }), commandName: 'setup', kind: 'command' });

  await handleInteraction(ctx, interaction);
  const text = textsOf(interaction.replies[0]);
  assert.match(text, /Administrator/);
  assert.match(text, /Servereinstellungen/);
  // Und es wird auch nichts gesammelt
  await handleIncoming({ ctx, message: makeMessage({ guild, channel, content: 'Hallo' }) });
  assert.equal(ctx.store.pendingCount('g1'), 0);
});

test('Nur Owner/Admins dürfen /setup benutzen', async () => {
  const { guild, ctx } = baseSetup();
  const outsider = makeMember({ id: 'user9', displayName: 'Fremder', administrator: false });
  const interaction = makeInteraction({ guild, member: outsider, commandName: 'setup', kind: 'command' });

  await handleInteraction(ctx, interaction);
  assert.match(textsOf(interaction.replies[0]), /Owner|Admins/);
});

// ------------------------------ Fortschritt ------------------------------

test('Unfertiges Setup springt zum ersten noch nicht eingerichteten Schritt', async () => {
  const { guild, ctx, admin } = baseSetup();
  ctx.store.updateGuild('g1', { setup: { step: 3, furthest: 3 } });

  const interaction = makeInteraction({ guild, member: admin, commandName: 'setup', kind: 'command' });
  await handleInteraction(ctx, interaction);

  const text = textsOf(interaction.replies[0]);
  assert.match(text, /Schritt 2\/7/);
  assert.match(text, /mindestens einen Textkanal/i);
});

test('Fertiges Setup: es beginnt wieder bei Schritt 1 mit allen Werten', async () => {
  const { guild, ctx, admin } = baseSetup();
  ctx.store.updateGuild('g1', { lang: 'en', channels: ['c1'], setup: { step: 7, furthest: 7, done: true } });

  const interaction = makeInteraction({ guild, member: admin, commandName: 'setup', kind: 'command' });
  await handleInteraction(ctx, interaction);

  const text = textsOf(interaction.replies[0]);
  assert.match(text, /Step 1\/7/);
});

test('Weiter ist gesperrt, bis der Schritt eingerichtet wurde; danach bleibt Zurück verfügbar', async () => {
  const { guild, ctx, admin } = baseSetup();

  const blocked = makeInteraction({ guild, member: admin, customId: 'setup:nav:next', kind: 'button' });
  await handleInteraction(ctx, blocked);
  assert.equal(ctx.store.getGuild('g1').setup.step, 1);
  assert.match(textsOf(blocked.updates[0]), /schließe diesen Schritt/i);

  const select = makeInteraction({ guild, member: admin, customId: 'setup:sel:lang', values: ['de'], kind: 'select' });
  await handleInteraction(ctx, select);
  assert.equal(ctx.store.getGuild('g1').setup.step, 1, 'die Auswahl navigiert nicht automatisch weiter');

  const next = makeInteraction({ guild, member: admin, customId: 'setup:nav:next', kind: 'button' });
  await handleInteraction(ctx, next);
  assert.equal(ctx.store.getGuild('g1').setup.step, 2);
  assert.match(textsOf(next.updates[0]), /Schritt 2\/7/);

  const back = makeInteraction({ guild, member: admin, customId: 'setup:nav:back', kind: 'button' });
  await handleInteraction(ctx, back);
  assert.equal(ctx.store.getGuild('g1').setup.step, 1);
  assert.match(textsOf(back.updates[0]), /Schritt 1\/7/);
});

test('Direktes Springen kann unvollständige Schritte nicht umgehen', async () => {
  const { guild, ctx, admin } = baseSetup();
  const jump = makeInteraction({ guild, member: admin, customId: 'setup:sel:step', values: ['6'], kind: 'select' });

  await handleInteraction(ctx, jump);
  assert.equal(ctx.store.getGuild('g1').setup.step, 1);
  assert.match(textsOf(jump.updates[0]), /Schritt 1\/7/);
  assert.equal(ctx.store.getGuild('g1').setup.furthest, 1);
});

test('Fertig kann nicht per altem Button bei unvollständigem Setup ausgelöst werden', async () => {
  const { guild, ctx, admin } = baseSetup();
  const finish = makeInteraction({ guild, member: admin, customId: 'setup:nav:finish', kind: 'button' });

  await handleInteraction(ctx, finish);
  assert.equal(ctx.store.getGuild('g1').setup.done, false);
  assert.equal(ctx.store.getGuild('g1').setup.step, 1);
  assert.match(textsOf(finish.updates[0]), /SetupNeedFirst|schließe diesen Schritt/i);
});

// ------------------------------ Schritt 1–3 ------------------------------

test('Schritt 1: Sprache wird gespeichert, bleibt auf Schritt 1 und zeigt kein Objekt-Format', async () => {
  const { guild, ctx, admin } = baseSetup();
  const select = makeInteraction({ guild, member: admin, customId: 'setup:sel:lang', values: ['en'], kind: 'select' });

  await handleInteraction(ctx, select);
  assert.equal(ctx.store.getGuild('g1').lang, 'en');
  const text = textsOf(select.updates[0]);
  assert.match(text, /Step 1\/7/);
  assert.match(text, /Language saved/i);
  assert.doesNotMatch(text, /\[object Object\]/);
});

test('Schritt 2: Kanal-Auswahl speichert Kanäle ohne Alle-auswählen-/Leeren-Buttons', async () => {
  const { guild, ctx, admin } = baseSetup();

  const pick = makeInteraction({ guild, member: admin, customId: 'setup:sel:channels', values: ['c1', 'c2'], kind: 'select' });
  await handleInteraction(ctx, pick);
  assert.deepEqual(ctx.store.getGuild('g1').channels, ['c1', 'c2']);
  assert.match(textsOf(pick.updates[0]), /2 ausgewählt/);

  const componentIds = allComponentsOf(pick.updates[0]).map((component) => component.custom_id).filter(Boolean);
  assert.ok(!componentIds.includes('setup:btn:all_channels'));
  assert.ok(!componentIds.includes('setup:btn:none_channels'));
  const selector = allComponentsOf(pick.updates[0]).find((component) => component.custom_id === 'setup:sel:channels');
  assert.equal(selector.min_values, 1, 'mindestens ein überwachter Kanal ist erforderlich');
  assert.deepEqual(selector.default_values, [{ id: 'c1', type: 'channel' }, { id: 'c2', type: 'channel' }]);
});

test('Schritt 2: Der Log-Kanal kann nicht gleichzeitig überwacht werden', async () => {
  const { guild, ctx, admin } = baseSetup();
  ctx.store.updateGuild('g1', { logChannelId: 'c2' });

  const pick = makeInteraction({ guild, member: admin, customId: 'setup:sel:channels', values: ['c1', 'c2'], kind: 'select' });
  await handleInteraction(ctx, pick);
  assert.deepEqual(ctx.store.getGuild('g1').channels, ['c1']);
});

test('Schritt 3: immune Rollen werden gespeichert, @everyone wird ausgeschlossen', async () => {
  const { guild, ctx, admin } = baseSetup();
  guild.roles.cache.set('r1', makeRole({ id: 'r1', name: 'Team' }));
  guild.roles.cache.set('r2', makeRole({ id: 'r2', name: 'VIP' }));
  const pick = makeInteraction({ guild, member: admin, customId: 'setup:sel:roles', values: [guild.id, 'r1', 'r2'], kind: 'select' });

  await handleInteraction(ctx, pick);
  assert.deepEqual(ctx.store.getGuild('g1').immuneRoles, ['r1', 'r2']);
  assert.ok(ctx.store.getGuild('g1').setup.configuredSteps.includes(3));
  assert.match(textsOf(pick.updates[0]), /Owner/);
  assert.match(textsOf(pick.updates[0]), /@everyone.*ignoriert/i);
});

test('Schritt 3: keine zusätzlichen Rollen ist eine bewusste, gültige Auswahl', async () => {
  const { guild, ctx, admin } = baseSetup();
  ctx.store.updateGuild('g1', { channels: ['c1'], setup: { step: 3, furthest: 3 } });
  const payload = setup.renderStep(ctx, guild, ctx.store.getGuild('g1'), 3);
  assert.equal(allComponentsOf(payload).find((component) => component.custom_id === 'setup:nav:next').disabled, true);

  const none = makeInteraction({ guild, member: admin, customId: 'setup:btn:none_roles', kind: 'button' });
  await handleInteraction(ctx, none);
  assert.deepEqual(ctx.store.getGuild('g1').immuneRoles, []);
  assert.ok(ctx.store.getGuild('g1').setup.configuredSteps.includes(3));
  assert.equal(allComponentsOf(none.updates[0]).find((component) => component.custom_id === 'setup:nav:next').disabled, false);
});

// ------------------------------ Schritt 4: Regelwerk ------------------------------

test('Schritt 4: Überspringen ist eine bewusste Auswahl und bleibt auf Schritt 4', async () => {
  const { guild, ctx, admin } = baseSetup();
  ctx.store.updateGuild('g1', { setup: { step: 4, furthest: 4 } });
  const skip = makeInteraction({ guild, member: admin, customId: 'setup:btn:rules_skip', kind: 'button' });

  await handleInteraction(ctx, skip);
  const cfg = ctx.store.getGuild('g1');
  assert.equal(cfg.rulesMode, 'skip');
  assert.equal(cfg.rules, '');
  assert.equal(cfg.setup.step, 4);
  assert.ok(cfg.setup.configuredSteps.includes(4));
  assert.match(textsOf(skip.updates[0]), /Schritt 4\/7/);
});

test('Schritt 4: manuell im Formular eingeben (mit Kürzung am Limit)', async () => {
  const { guild, ctx, admin } = baseSetup();
  ctx.store.updateGuild('g1', { setup: { step: 4, furthest: 4 } });
  const modal = makeInteraction({ guild, member: admin, customId: 'setup:modal:rules', kind: 'modal', fields: { rules: '1. Seid nett\n2. Kein Spam' } });

  await handleInteraction(ctx, modal);
  const cfg = ctx.store.getGuild('g1');
  assert.equal(cfg.rulesMode, 'manual');
  assert.match(cfg.rules, /Kein Spam/);
  assert.equal(cfg.setup.step, 4);

  const tooLong = makeInteraction({ guild, member: admin, customId: 'setup:modal:rules', kind: 'modal', fields: { rules: 'x'.repeat(MAX_RULES_CHARS + 100) } });
  await handleInteraction(ctx, tooLong);
  assert.equal(ctx.store.getGuild('g1').rules.length, MAX_RULES_CHARS);
  assert.match(textsOf(tooLong.updates.at(-1)), new RegExp(String(MAX_RULES_CHARS)));
});

test('Schritt 4: Import zeigt den Kanalauswähler und übernimmt die ausgewählte Regel-Nachricht', async () => {
  const { guild, ctx, admin } = baseSetup();
  ctx.store.updateGuild('g1', { setup: { step: 4, furthest: 4 } });
  const ruleChannel = makeChannel({
    id: 'rules',
    name: 'regeln',
    guild,
    messages: [
      makeMessage({
        id: 'm1',
        channel: null,
        guild,
        content: '',
        embeds: [{ toJSON: () => ({ title: 'Serverregeln', description: 'Respektvoll bleiben', fields: [{ name: 'Spam', value: 'Verboten' }] }) }],
      }),
    ],
  });
  guild.channelCache.set(ruleChannel.id, ruleChannel);

  const openImport = makeInteraction({ guild, member: admin, customId: 'setup:btn:rules_import', kind: 'button' });
  await handleInteraction(ctx, openImport);
  const importSelector = allComponentsOf(openImport.updates[0]).find((component) => component.custom_id === 'setup:sel:import');
  assert.equal(importSelector.type, 8, 'der eigene Kanal kann ausgewählt werden');
  assert.equal(importSelector.min_values, 1);
  assert.doesNotMatch(textsOf(openImport.updates[0]), /\[object Object\]/);

  const pick = makeInteraction({ guild, member: admin, customId: 'setup:sel:import', values: ['rules'], kind: 'select' });
  await handleInteraction(ctx, pick);

  const draft = ctx.setupDraft.get('g1');
  assert.ok(draft, 'Import-Entwurf wird gehalten');
  assert.match(draft.text, /Respektvoll bleiben/);
  assert.match(textsOf(pick.updates[0]), /Verboten/);

  const use = makeInteraction({ guild, member: admin, customId: 'setup:btn:import_use', kind: 'button' });
  await handleInteraction(ctx, use);
  const cfg = ctx.store.getGuild('g1');
  assert.equal(cfg.rulesMode, 'import');
  assert.match(cfg.rules, /Respektvoll bleiben/);
  assert.equal(cfg.setup.step, 4, 'Import springt nicht automatisch zum nächsten Schritt');
});

test('Schritt 4: Import verlangt genau eine Nachricht im Kanal', async () => {
  const { guild, ctx, admin } = baseSetup();
  const busy = makeChannel({
    id: 'busy',
    name: 'chat',
    guild,
    messages: [makeMessage({ id: 'm1', content: 'hi' }), makeMessage({ id: 'm2', content: 'ho' })],
  });
  guild.channelCache.set(busy.id, busy);

  const pick = makeInteraction({ guild, member: admin, customId: 'setup:sel:import', values: ['busy'], kind: 'select' });
  await handleInteraction(ctx, pick);

  assert.equal(ctx.setupDraft.get('g1'), undefined);
  assert.match(textsOf(pick.updates[0]), /eine/);
});

// ------------------------------ Schritt 5 ------------------------------

test('Schritt 5: Anweisung schreiben und Maßnahmen ankreuzen (Warn bleibt Pflicht)', async () => {
  const { guild, ctx, admin } = baseSetup();

  const modal = makeInteraction({ guild, member: admin, customId: 'setup:modal:instr', kind: 'modal', fields: { instructions: 'Bei Werbung sofort 1 Tag Timeout.' } });
  await handleInteraction(ctx, modal);
  assert.match(ctx.store.getGuild('g1').instructions, /Werbung/);

  const kick = makeInteraction({ guild, member: admin, customId: 'setup:btn:allow_kick', kind: 'button' });
  await handleInteraction(ctx, kick);
  assert.equal(ctx.store.getGuild('g1').allow.kick, true);
  assert.equal(ctx.store.getGuild('g1').allow.ban, false);
  assert.match(textsOf(kick.updates[0]), /Verwarnung/);

  const ban = makeInteraction({ guild, member: admin, customId: 'setup:btn:allow_ban', kind: 'button' });
  await handleInteraction(ctx, ban);
  assert.equal(ctx.store.getGuild('g1').allow.ban, true);
});

// ------------------------------ Schritt 6 ------------------------------

test('Schritt 6: Kanal selbst anlegen lassen und Rechte setzen', async () => {
  const { guild, ctx, admin } = baseSetup();
  const auto = makeInteraction({ guild, member: admin, customId: 'setup:btn:log_auto', kind: 'button' });

  await handleInteraction(ctx, auto);
  const cfg = ctx.store.getGuild('g1');
  assert.ok(cfg.logChannelId, 'Log-Kanal wurde gespeichert');
  assert.equal(cfg.logAuto, true);
  assert.equal(guild.created.length, 1);

  const created = guild.created[0];
  assert.equal(created.overwrites[0].id, guild.id, '@everyone wird gesperrt');
  assert.ok(created.overwrites.length >= 3);
});

test('Schritt 6: eigenen Kanal wählen – er fliegt aus der Überwachung', async () => {
  const { guild, ctx, admin } = baseSetup();
  ctx.store.updateGuild('g1', { channels: ['c1', 'c2'] });

  const pick = makeInteraction({ guild, member: admin, customId: 'setup:sel:log', values: ['c2'], kind: 'select' });
  await handleInteraction(ctx, pick);

  const cfg = ctx.store.getGuild('g1');
  assert.equal(cfg.logChannelId, 'c2');
  assert.deepEqual(cfg.channels, ['c1']);
  assert.ok(guild.channelCache.get('c2').overwrites, 'Rechte wurden gesetzt');
});

// ------------------------------ Schritt 7 + Abschluss ------------------------------

test('Schritt 7: Key wird geprüft und nur bei Erfolg gespeichert', async () => {
  const { guild, ctx, admin } = baseSetup();

  // ungültiger Key → nicht gespeichert
  const bad = makeInteraction({ guild, member: admin, customId: 'setup:modal:key', kind: 'modal', fields: { key: 'gsk_bad' } });
  await handleInteraction(ctx, bad);
  assert.equal(ctx.store.getGuild('g1').groqKey, null);
  assert.match(textsOf(bad.edits.at(-1)), /funktioniert nicht/i);

  // gültiger Key → gespeichert
  ctx.fetchFn = groqOkFetch();
  const good = makeInteraction({ guild, member: admin, customId: 'setup:modal:key', kind: 'modal', fields: { key: 'gsk_good' } });
  await handleInteraction(ctx, good);
  assert.equal(ctx.store.getGuild('g1').groqKey, 'gsk_good');
  assert.match(textsOf(good.edits.at(-1)), /gültig/i);
});

test('Abschluss: vollständig konfiguriertes Setup wird beendet und im Log angekündigt', async () => {
  const { guild, ctx, admin } = baseSetup();
  ctx.store.updateGuild('g1', {
    channels: ['c1'],
    immuneRoles: [],
    rulesMode: 'skip',
    instructions: 'freundlich',
    logChannelId: 'c2',
    groqKey: 'gsk_valid',
    setup: { step: 7, furthest: 7, configuredSteps: [1, 3, 4, 5, 6, 7] },
  });

  const finish = makeInteraction({ guild, member: admin, customId: 'setup:nav:finish', kind: 'button' });
  await handleInteraction(ctx, finish);

  const cfg = ctx.store.getGuild('g1');
  assert.equal(cfg.setup.done, true);
  assert.ok(cfg.setup.completedAt);
  assert.equal(cfg.logChannelId, 'c2');

  const logChannel = guild.channelCache.get(cfg.logChannelId);
  assert.ok(logChannel.sent.length >= 1, 'Der Bot meldet sich im Log');
  assert.match(textsOf(logChannel.sent[0]), /Dienst|report|service|dienst/i);
  assert.match(textsOf(finish.updates[0]), /Fertig|Done/);
});

// ------------------------------ Wartung ------------------------------

test('Gelöschter Log-Kanal wird neu angelegt und angekündigt', async () => {
  const { guild, ctx } = baseSetup();
  const old = makeChannel({ id: 'oldlog', name: 'mod-log', guild });
  guild.channelCache.set(old.id, old);
  ctx.store.updateGuild('g1', { logChannelId: 'oldlog', logAuto: true });
  guild.channelCache.delete('oldlog');

  const result = await maintenance.handleChannelDelete(ctx, old);
  assert.equal(result.recreated, true);

  const cfg = ctx.store.getGuild('g1');
  assert.notEqual(cfg.logChannelId, 'oldlog');
  const newChannel = guild.channelCache.get(cfg.logChannelId);
  assert.ok(newChannel);
  assert.equal(newChannel.sent.some((p) => /neu angelegt|recreated|recréé|creado/i.test(textsOf(p))), true);
});

test('Gelöschte Rollen und Kanäle hinterlassen keine Reste im Speicher', async () => {
  const { guild, ctx } = baseSetup();
  ctx.store.updateGuild('g1', { immuneRoles: ['r1', 'r2'], channels: ['c1', 'c2'] });

  await maintenance.handleRoleDelete(ctx, { id: 'r1', name: 'Team', guild });
  assert.deepEqual(ctx.store.getGuild('g1').immuneRoles, ['r2']);

  await maintenance.handleChannelDelete(ctx, makeChannel({ id: 'c2', name: 'offtopic', guild }));
  assert.deepEqual(ctx.store.getGuild('g1').channels, ['c1']);
});

test('Server verlassen löscht alle Daten dieses Servers', async () => {
  const { guild, ctx } = baseSetup();
  ctx.store.updateGuild('g1', { lang: 'fr' });
  ctx.store.addPenalty({ guildId: 'g1', userId: 'u1', action: 'timeout' });
  ctx.store.addBuffered('g1', { key: 'k1', content: 'x' });
  ctx.adminWarnAt.set('g1', 123);

  await maintenance.handleGuildDelete(ctx, guild);
  assert.equal(ctx.store.getAllGuilds().includes('g1'), false);
  assert.equal(ctx.store.listPenalties('g1').length, 0);
  assert.equal(ctx.store.pendingCount('g1'), 0);
  assert.equal(ctx.adminWarnAt.has('g1'), false);
  assert.equal(silent().info(), undefined);
});

// ------------------------------ Beim Beitritt / Rechteverlust ------------------------------

test('Beim Beitritt wird der Owner angeschrieben und auf /setup hingewiesen', async () => {
  const { guild, ctx } = baseSetup();
  const result = await dmGuildOwner(ctx, guild);

  assert.equal(result.ok, true);
  assert.equal(result.via, 'dm');
  assert.equal(guild.ownerDms.length, 1);
  assert.match(textsOf(guild.ownerDms[0]), /\/setup/);
  assert.match(textsOf(guild.ownerDms[0]), /Administrator/);
});

test('Fehlende Administrator-Rechte werden gemeldet – höchstens alle 12 Stunden', async () => {
  const { guild, ctx } = baseSetup();
  guild.members.me.permissions = { has: () => false };

  const first = await notifyMissingAdmin(ctx, guild);
  assert.equal(first.ok, true);
  assert.equal(guild.ownerDms.length, 1);

  const second = await notifyMissingAdmin(ctx, guild);
  assert.equal(second.reason, 'throttled');
  assert.equal(guild.ownerDms.length, 1, 'keine Doppel-Meldung');

  const forced = await notifyMissingAdmin(ctx, guild, { force: true });
  assert.equal(forced.ok, true);
  assert.equal(guild.ownerDms.length, 2);
});
