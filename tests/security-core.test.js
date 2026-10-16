/**
 * Security-Bot (v2) – Kern-Bausteine:
 * Sprachen, UI (Components V2), unsichtbarer Zustand, Regelwerk, Verlauf-Format,
 * Sammler/Vorfilter, Budget und Speicher.
 * Läuft komplett ohne Discord- und ohne Netzwerkverbindung.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ui = require('../bots/security-bot/src/ui');
const { LANGS, t, isValidLang, langOptions } = require('../bots/security-bot/src/languages');
const { encodeHidden, decodeHidden, encodeLogState, decodeLogState, stripHidden } = require('../bots/security-bot/src/hidden');
const rules = require('../bots/security-bot/src/rules');
const { buildTranscript, humanizeContent, extractTextFromMessage, estimateTokens } = require('../bots/security-bot/src/transcript');
const collector = require('../bots/security-bot/src/collector');
const { createBudgetSet, createLane } = require('../bots/security-bot/src/budget');
const { createSecurityStore } = require('../bots/security-bot/src/store');
const { makeMessage, makeChannel, makeGuild, silent } = require('./security-fakes');

// ------------------------------- Sprachen -------------------------------

test('10 Sprachen, gültige Codes und Deutsch als Rückfall', () => {
  assert.equal(LANGS.length, 10);
  assert.ok(isValidLang('de') && isValidLang('ja'));
  assert.ok(!isValidLang('xx'));
  assert.equal(t('de', 'next'), 'Weiter');
  assert.equal(t('en', 'next'), 'Next');
  // unbekannter Schlüssel → Schlüsselname, fehlende Sprache → Deutsch
  assert.equal(t('en', 'gibtEsNicht'), 'gibtEsNicht');
  assert.equal(t('de', 'stepOf', { n: 3 }), 'Schritt 3/7');
  assert.equal(langOptions({ selected: 'fr' }).filter((o) => o.default).length, 1);
});

// --------------------------------- UI ---------------------------------

test('Components V2: Flags, Buttons, Selects, Modal-Formulare', () => {
  const payload = ui.payload([ui.container([ui.text('Hallo')])], { ephemeral: true });
  assert.equal(payload.flags, ui.FLAG_V2 | ui.FLAG_EPHEMERAL);
  assert.equal(payload.components[0].type, 17);
  assert.equal(payload.components[0].components[0].type, 10);

  const btn = ui.button({ id: 'x', label: 'Test', style: ui.STYLE.danger });
  assert.deepEqual({ type: btn.type, style: btn.style, custom_id: btn.custom_id }, { type: 2, style: 4, custom_id: 'x' });

  assert.equal(ui.channelSelect({ id: 'c', placeholder: 'p' }).type, 8);
  assert.equal(ui.roleSelect({ id: 'r' }).type, 6);
  assert.equal(ui.stringSelect({ id: 's', options: [{ label: 'a', value: 'a' }] }).type, 3);

  // Modernes Modal: Input liegt in einem Label (Typ 18)
  const input = ui.textInput({ id: 'reason', label: 'Warum?', style: 2, maxLength: 400 });
  assert.equal(input.type, 18);
  assert.equal(input.component.type, 4);
  assert.equal(ui.modal({ id: 'm', title: 'T', components: [input] }).custom_id, 'm');

  const box = ui.checkboxGroup({ id: 'remove', label: 'Aktionen', options: [{ label: 'Weg', value: 'yes' }] });
  assert.equal(box.component.type, 22);
  assert.equal(box.component.options[0].default, false);
});

// --------------------------- Unsichtbarer Zustand ---------------------------

test('Unsichtbarer Zustand: Roundtrip, Zähler, Entfernen aus dem Text', () => {
  const state = { up: 2, down: 1, voters: { u1: 1, u2: -1 }, penalties: ['p1', 'p2'] };
  const blob = encodeLogState(state);
  assert.ok(!/[^\u200B-\u200F\u2060-\u206F\uFEFF]/.test(blob), 'Blob besteht nur aus unsichtbaren Zeichen');
  const text = `Log-Text${blob}`;
  assert.deepEqual(decodeLogState(text), state);
  assert.equal(decodeLogState('ohne Blob').up, 0);
  assert.deepEqual(decodeLogState('ohne Blob').voters, {});
  assert.equal(stripHidden(text), 'Log-Text');
});

test('Blobs überleben fremde Zero-Width-Zeichen', () => {
  const blob = encodeHidden('sec1:{"up":5,"down":0,"voters":{},"penalties":[]}');
  const text = `\u200B\u200Bfremd${blob}\u200B`;
  const decoded = decodeHidden(text);
  assert.ok(decoded.some((d) => d.startsWith('sec1:')));
  assert.equal(decodeLogState(text).up, 5);
});

// ------------------------------- Regelwerk -------------------------------

test('Systemregeln sind immer dabei, eigene Regeln werden nummeriert', () => {
  assert.ok(rules.SYSTEM_RULES.length >= 10);
  const parsed = rules.parseCustomRules('1. Keine Beleidigungen\n- Kein Spam\n\n Werbung verboten');
  assert.deepEqual(parsed.map((r) => r.id), ['C1', 'C2', 'C3']);
  assert.equal(parsed[0].text, 'Keine Beleidigungen');

  const block = rules.buildRulesBlock('Keine Beleidigungen');
  assert.match(block, /S1 \[Beleidigung & Belästigung\]/);
  assert.match(block, /C1 \[Keine Beleidigungen\]/);
  assert.match(rules.buildRulesBlock(''), /nur die Systemregeln/);
  assert.equal(rules.ruleLabel('c1', 'Keine Beleidigungen'), 'C1 Keine Beleidigungen');
});

test('Zeichenlimits: Regeln und Anweisungen werden gekürzt', () => {
  const long = 'x'.repeat(rules.MAX_RULES_CHARS + 50);
  const clamped = rules.clampRules(long);
  assert.equal(clamped.truncated, true);
  assert.equal(clamped.text.length, rules.MAX_RULES_CHARS);
  const instr = rules.clampInstructions('y'.repeat(rules.MAX_INSTRUCTIONS_CHARS + 10));
  assert.equal(instr.truncated, true);
  assert.equal(instr.text.length, rules.MAX_INSTRUCTIONS_CHARS);
});

// ------------------------------- Verlauf -------------------------------

test('Verlauf: IDs ab 1, Reihenfolge, Kontext für das Team', () => {
  const guild = makeGuild();
  const channel = makeChannel({ name: 'chat', guild });
  const a = makeMessage({ channel, guild, content: 'Hallo <@42>', author: { id: 'u1', username: 'Anna' }, member: { displayName: 'Anna' } });
  const b = makeMessage({ channel, guild, content: 'Du bist doof', author: { id: 'u2', username: 'Ben' }, member: { displayName: 'Ben' } });

  const { text, idMap } = buildTranscript([a, b]);
  assert.match(text, /── #chat ──/);
  assert.match(text, /\[1\] \d\d:\d\d Anna \(user_id=u1\)/);
  assert.match(text, /\[2\] \d\d:\d\d Ben \(user_id=u2\)/);
  assert.equal(idMap.get(2).authorId ?? idMap.get(2).author.id, 'u2');
});

test('Team-Nachrichten sind Kontext, nicht moderierbar', () => {
  const record = { key: 'k', channelId: 'c', channelName: 'chat', messageId: 'm1', authorId: 'a1', authorName: 'Chef', content: 'Ruhe jetzt', createdAt: Date.now(), immune: true };
  const { text, idMap } = buildTranscript([record]);
  assert.match(text, /\[KONTEXT · Team\]/);
  assert.equal(idMap.size, 0, 'immune Nachrichten bekommen keine ID');
});

test('Discord-Formate werden lesbar gemacht (Mentions, Emojis, Timestamps)', () => {
  const guild = makeGuild();
  const channel = makeChannel({ name: 'chat', guild });
  const message = makeMessage({ channel, guild, content: 'Hey <@77> <:party:1234> <t:1700000000:R> **fett**' });
  guild.members.cache.set('77', { displayName: 'Mia', id: '77' });

  const out = humanizeContent(message, message.content);
  assert.match(out, /@\[Mia\]/);
  assert.match(out, /:party:/);
  assert.match(out, /2023-11-14/);
  assert.ok(!out.includes('**'), 'Markdown wird entschärft');
});

test('Regeln aus Embeds und Components V2 herausziehen', () => {
  const guild = makeGuild();
  const channel = makeChannel({ name: 'regeln', guild });
  const message = makeMessage({
    channel,
    guild,
    content: '',
    embeds: [
      {
        toJSON: () => ({ title: 'Serverregeln', description: 'Seid nett', fields: [{ name: 'Spam', value: 'Verboten' }] }),
      },
    ],
  });
  const text = extractTextFromMessage(message);
  assert.match(text, /## Serverregeln/);
  assert.match(text, /Seid nett/);
  assert.match(text, /Verboten/);

  const v2 = makeMessage({
    guild,
    channel,
    components: [{ type: 17, components: [{ type: 10, content: 'Regel 1: Respekt' }, { type: 1, components: [{ type: 2, custom_id: 'x' }] }] }],
  });
  assert.match(extractTextFromMessage(v2), /Regel 1: Respekt/);
  assert.ok(estimateTokens('a'.repeat(350)) >= 100);
});

// ------------------------------- Sammler -------------------------------

test('Sammler: Bots/Webhooks raus, Kanalfilter, Datensatz-Form', () => {
  const guild = makeGuild();
  const channel = makeChannel({ name: 'chat', guild });

  assert.equal(collector.isCollectable(makeMessage({ author: { id: 'b', bot: true } })), false);
  assert.equal(collector.isCollectable({ ...makeMessage({}), webhookId: 'w1' }), false);
  assert.equal(collector.isCollectable(makeMessage({ content: 'hi' })), true);

  assert.equal(collector.isMonitored('c1', { channels: [] }), true);
  assert.equal(collector.isMonitored('c1', { channels: ['c1'] }), true);
  assert.equal(collector.isMonitored('c2', { channels: ['c1'] }), false);

  const record = collector.toRecord(makeMessage({ channel, guild, content: 'Hallo', member: { displayName: 'Anna' } }));
  assert.equal(record.channelName, 'chat');
  assert.equal(record.authorName, 'Anna');
  assert.ok(record.key.includes(':'));

  const immune = collector.toRecord(makeMessage({ channel, guild, content: 'Hi' }), { immune: true });
  assert.equal(immune.immune, true);
});

test('Lokaler Filter erkennt Beleidigungen, Drohungen, Scam und Spam', () => {
  const base = { messageId: 'm1', authorId: 'u1', createdAt: Date.now() };
  assert.ok(collector.localSignals({ ...base, content: 'Du bist ein Hurensohn' }).some((s) => s.kind === 'beleidigung'));
  assert.ok(collector.localSignals({ ...base, content: 'ich bring dich um' }).some((s) => s.kind === 'drohung'));
  assert.ok(collector.localSignals({ ...base, content: 'hol dir free nitro https://discord.com/gift/abc' }).some((s) => s.kind === 'scam'));
  assert.ok(collector.localSignals({ ...base, content: '@everyone kommt alle' }).some((s) => s.kind === 'spam'));
  assert.equal(collector.localSignals({ ...base, content: 'Guten Morgen zusammen' }).length, 0);
});

test('Puffer-Risiko: Wiederholungen und Mention-Druck', () => {
  const now = Date.now();
  const records = [];
  for (let i = 0; i < 4; i++) {
    records.push({
      messageId: `m${i}`,
      authorId: 'u1',
      content: 'spam spam spam',
      createdAt: now - i * 1000,
      mentions: [{ id: 'ziel', name: 'Ziel' }],
    });
  }
  const risk = collector.bufferRisk(records);
  assert.ok(risk.score > 0);
  assert.ok(risk.signals.some((s) => s.kind === 'mention_druck'));
});

test('Es wird erst geprüft, wenn es sich lohnt', () => {
  const now = Date.now();
  const many = Array.from({ length: 20 }, (_, i) => ({ messageId: `m${i}`, authorId: 'u1', content: 'hallo', createdAt: now - 60_000 }));
  assert.equal(collector.shouldAnalyse(many, { score: 0, now }).run, true); // Ruhe + Menge
  assert.equal(collector.shouldAnalyse(many, { score: 50, now }).reason, 'risiko');
  const few = Array.from({ length: 2 }, () => ({ messageId: 'm', authorId: 'u', content: 'hi', createdAt: now }));
  assert.equal(collector.shouldAnalyse(few, { score: 0, now }).run, false);
});

// ------------------------------- Budget -------------------------------

test('Budget: harte Grenzen, Reserve und Pacing', () => {
  let clock = 1_700_000_000_000;
  const lane = createLane({ name: 'smart', tpd: 10000, rpd: 10, tpm: 8000, rpm: 30, reserve: 0, avgCallTokens: 1000, now: () => clock });
  assert.equal(lane.canSpend(2000).ok, true);
  lane.spend(2000);
  // Pacing: Mindestabstand, weil das Tagesbudget nur 10 Aufrufe erlaubt
  assert.ok(lane.canSpend(2000).waitMs > 0);
  assert.equal(lane.canSpend(2000, { priority: true }).ok, true);

  for (let i = 0; i < 12; i++) {
    clock += 60_000;
    if (lane.canSpend(1000, { priority: true }).ok) lane.spend(1000);
  }
  const blocked = lane.canSpend(1000, { priority: true });
  assert.equal(blocked.ok, false);
  assert.ok(['tpd', 'rpd'].includes(blocked.reason));

  const set = createBudgetSet((k, d) => d);
  assert.match(set.summary(), /Urteile\/Tag/);
  assert.match(set.resetText({ resetInMs: 3_600_000 }, 0), /UTC/);
});

// ------------------------------- Speicher -------------------------------

test('Speicher: Standard-Konfiguration, Setup-Stand, Strafregister, Puffer', async () => {
  const file = path.join(os.tmpdir(), `sec-store-${Date.now()}-${Math.random()}.json`);
  const store = createSecurityStore({ logger: silent(), env: (k, d) => d, filePath: file });
  await store.init();

  const cfg = store.getGuild('g1');
  assert.equal(cfg.lang, 'de');
  assert.deepEqual(cfg.allow, { ban: false, kick: false, timeout: true });
  assert.equal(cfg.setup.step, 1);
  assert.deepEqual(cfg.setup.configuredSteps, []);
  assert.equal(cfg.setup.done, false);

  store.updateGuild('g1', { lang: 'en', channels: ['c1'], setup: { step: 4, furthest: 4 } });
  const updated = store.getGuild('g1');
  assert.equal(updated.lang, 'en');
  assert.deepEqual(updated.channels, ['c1']);
  assert.equal(updated.setup.step, 4);

  const penalty = store.addPenalty({
    guildId: 'g1',
    userId: 'u1',
    userName: 'Ben',
    action: 'timeout',
    duration: '1h',
    ruleId: 'C1',
    ruleLabel: 'C1 Keine Beleidigungen',
    reason: 'Beleidigt',
    excerpt: 'du dummi',
    source: 'ai',
  });
  assert.ok(penalty.id);
  assert.equal(store.listPenalties('g1', { userId: 'u1' }).length, 1);
  assert.match(store.registerForPrompt('g1', { userIds: ['u1'], sinceMs: 0 }), /C1 Keine Beleidigungen/);

  assert.equal(store.removePenalty(penalty.id).id, penalty.id);
  assert.equal(store.listPenalties('g1', { userId: 'u1' }).length, 0);

  store.addBuffered('g1', { key: 'k1', content: 'hi', createdAt: Date.now() });
  assert.equal(store.pendingCount('g1'), 1);
  assert.equal(store.dropBuffered('g1', ['k1']), 1);
  assert.equal(store.pendingCount('g1'), 0);

  await store.flush({ force: true });
  assert.ok(fs.existsSync(file));
  fs.unlinkSync(file);
});

test('Server-Daten werden vollständig gelöscht', () => {
  const store = createSecurityStore({ logger: silent(), env: (k, d) => d, filePath: path.join(os.tmpdir(), `sec-wipe-${Math.random()}.json`) });
  store.updateGuild('g9', { lang: 'fr' });
  store.addPenalty({ guildId: 'g9', userId: 'u1', action: 'warn' });
  store.addBuffered('g9', { key: 'k', content: 'x' });

  store.deleteGuild('g9');
  assert.equal(store.getAllGuilds().includes('g9'), false);
  assert.equal(store.listPenalties('g9').length, 0);
  assert.equal(store.pendingCount('g9'), 0);
});

test('Setup-Stand wird begrenzt (1–7) und sauber normalisiert', () => {
  const store = createSecurityStore({ logger: silent(), env: (k, d) => d, filePath: path.join(os.tmpdir(), `sec-norm-${Math.random()}.json`) });
  const cfg = store.updateGuild('g1', { setup: { step: 99, furthest: -5, configuredSteps: [1, 2, 2, 0, 8, '3'], done: true } });
  assert.equal(cfg.setup.step, 7);
  assert.equal(cfg.setup.furthest, 1);
  assert.deepEqual(cfg.setup.configuredSteps, [1, 2, 3]);
  assert.equal(cfg.setup.done, true);
  assert.equal(store.updateGuild('g1', { rulesMode: 'quatsch' }).rulesMode, null);
});
