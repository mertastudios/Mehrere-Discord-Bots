/**
 * Tests für die KI-gestützten Moderationsbefehle des Sicherheitsbots:
 *   - /security_action  (verdeckte KI-Moderation ausgewählter Nachrichten)
 *   - /security_ai_order (freier KI-Auftrag zum ganzen Chatverlauf)
 *   - Safety-/Empty-Response-Härtung des Gemini-Clients
 *   - Discord-Formatierung der Begründungen (fette Maßnahme + fetter Grund)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits, ChannelType } = require('discord.js');

const { callGemini } = require('../bots/security-bot/src/gemini');
const { personalMessageText, moderationHeadline } = require('../bots/security-bot/src/moderator');
const { collectUserMessages, numberMessages } = require('../bots/security-bot/src/message-scan');
const targeted = require('../bots/security-bot/src/targeted-action');
const aiOrder = require('../bots/security-bot/src/ai-order');
const { createSecurityStore } = require('../bots/security-bot/src/store');
const { buildTargetedDirectives, buildOrderDirectives } = require('../bots/security-bot/src/prompts');

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeStore() {
  const store = createSecurityStore({
    env: (k) => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : ''),
  });
  return store.init().then(() => store);
}

function geminiJsonResponse(json) {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }),
  };
}

/** Minimale Discord-Welt mit echter Nachrichtenhistorie in einem Kanal. */
function makeWorld({ messageCount = 30, targetId = '111111111111111111' } = {}) {
  const now = Date.now();
  const membersCache = new Map();
  const channelsCache = new Map();

  const makeMember = (id, { admin = false, name } = {}) => ({
    id,
    displayName: name || `Name${id}`,
    user: { id, username: `user${id}`, globalName: name || `Name${id}` },
    moderatable: true,
    timeouts: [],
    permissions: { has: (p) => admin && p === PermissionFlagsBits.Administrator },
    async timeout(ms, reason) {
      this.timeouts.push({ ms, reason });
    },
  });

  membersCache.set(targetId, makeMember(targetId, { name: 'Max' }));
  membersCache.set('999999999999999999', makeMember('999999999999999999', { admin: true, name: 'Chefin' }));
  membersCache.set('888888888888888888', makeMember('888888888888888888', { name: 'Anna' }));

  const guild = {
    id: 'g1',
    name: 'Test Server',
    members: {
      me: { id: 'bot1' },
      cache: membersCache,
      fetch: async (id) => membersCache.get(String(id)) || null,
    },
    channels: { cache: channelsCache },
    roles: { cache: new Map() },
  };

  const history = [];
  for (let i = 0; i < messageCount; i++) {
    const authorId = i % 5 === 0 ? '888888888888888888' : targetId;
    history.push({
      id: `m${i + 1}`,
      author: { id: authorId, bot: false, username: `user${authorId}`, globalName: null },
      member: membersCache.get(authorId),
      content: `Nachricht ${i + 1} von ${authorId === targetId ? 'Max' : 'Anna'}`,
      createdTimestamp: now - (messageCount - i) * 1000,
      channelId: 'c1',
      attachments: { size: 0 },
      mentions: { users: new Map(), members: new Map() },
      reference: null,
      system: false,
      replies: [],
      async reply(payload) {
        this.replies.push(payload);
        return { id: `r${this.id}` };
      },
    });
  }

  const channel = {
    id: 'c1',
    name: 'allgemein',
    type: ChannelType.GuildText,
    guildId: 'g1',
    guild,
    lastMessageId: '900000000000000000',
    sent: [],
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async (arg) => {
        if (typeof arg === 'string') {
          const found = history.find((m) => m.id === arg);
          if (!found) throw new Error('nicht gefunden');
          return found;
        }
        const { limit = 100, before } = arg || {};
        // Neueste zuerst (wie Discord)
        let list = [...history].reverse();
        if (before) {
          const idx = list.findIndex((m) => m.id === before);
          list = idx >= 0 ? list.slice(idx + 1) : [];
        }
        return new Map(list.slice(0, limit).map((m) => [m.id, m]));
      },
    },
    send: async (p) => {
      channel.sent.push(p);
      return { id: `s${channel.sent.length}` };
    },
  };
  for (const msg of history) msg.channel = channel;
  channelsCache.set('c1', channel);

  const logChannel = {
    id: 'clog',
    name: 'log',
    type: ChannelType.GuildText,
    sent: [],
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => { throw new Error('leer'); } },
    send: async (p) => {
      logChannel.sent.push(p);
      return { id: 'log1' };
    },
  };
  channelsCache.set('clog', logChannel);

  for (const msg of history) msg.guild = guild;

  return { guild, channel, logChannel, history, membersCache };
}

function makeInteraction({ guild, options = {}, user = { id: '999999999999999999', username: 'Chefin' }, admin = true }) {
  const state = { replies: [], edits: [], updates: [], modals: [], deferred: false };
  return {
    state,
    guildId: guild.id,
    guild,
    user,
    locale: 'de',
    memberPermissions: { has: (p) => admin && p === PermissionFlagsBits.Administrator },
    inGuild: () => true,
    options: {
      getUser: (name) => options[name] ?? null,
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
    },
    client: { user: { id: 'bot1' } },
    deferReply: async () => { state.deferred = true; },
    reply: async (p) => { state.replies.push(p); return p; },
    editReply: async (p) => { state.edits.push(p); return p; },
    update: async (p) => { state.updates.push(p); return p; },
    showModal: async (m) => { state.modals.push(m); return m; },
  };
}

/** Serialisiert eine Components-V2-Nachricht in reinen Text. */
function toJson(payload) {
  return (payload?.components || []).map((c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c));
}

function textOf(payload) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.content === 'string') out.push(node.content);
    if (Array.isArray(node.components)) node.components.forEach(walk);
  };
  toJson(payload).forEach(walk);
  if (typeof payload?.content === 'string') out.push(payload.content);
  return out.join('\n');
}

/** Alle interaktiven Komponenten (Select-Menüs, Buttons) einer Nachricht. */
function widgetsOf(payload) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 3 || node.type === 2) found.push(node);
    if (Array.isArray(node.components)) node.components.forEach(walk);
  };
  toJson(payload).forEach(walk);
  return found;
}

// ---------------------------------------------------------------------------
// 1. Gemini-Härtung gegen leere Antworten (Safety-Block)
// ---------------------------------------------------------------------------

test('Gemini: leere Safety-Antwort wird mit der nächsten Variante gerettet', async () => {
  const bodies = [];
  const fetchFn = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) {
      // Klassischer Fall: HTTP 200, aber kein Text (finish_reason SAFETY)
      return {
        ok: true,
        json: async () => ({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }),
      };
    }
    return geminiJsonResponse({ moderations: [] });
  };

  const res = await callGemini({
    apiKey: 'AIza-x',
    systemPrompt: 's',
    userPrompt: 'u',
    fetchFn,
    sleepFn: async () => {},
  });

  assert.equal(res.ok, true, 'der zweite Versuch liefert ein Ergebnis');
  assert.equal(bodies.length, 2);
  assert.ok(bodies[1].safetySettings.every((s) => s.threshold === 'BLOCK_NONE'));
});

test('Gemini: dauerhaft leere Antwort meldet empty_response inkl. finish_reason', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({
        candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
        promptFeedback: { blockReason: 'SAFETY' },
      }),
    };
  };

  const res = await callGemini({
    apiKey: 'AIza-x',
    systemPrompt: 's',
    userPrompt: 'u',
    fetchFn,
    sleepFn: async () => {},
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'empty_response');
  assert.equal(res.finishReason, 'SAFETY');
  assert.equal(res.blockReason, 'SAFETY');
  assert.ok(calls >= 4, 'alle Kompatibilitätsvarianten wurden probiert');
  assert.ok(String(res.message).includes('finish_reason=SAFETY'));
});

// ---------------------------------------------------------------------------
// 2. Discord-Formatierung der Begründung
// ---------------------------------------------------------------------------

test('Moderation: Maßnahme und Hauptgrund sind fett formatiert', () => {
  const mod = {
    action: 'timeout',
    duration: '1h',
    reason: 'Beleidigung eines Mitglieds',
    personal_message: '{USER} bitte unterlasse das.',
  };
  const text = personalMessageText(mod, 'u1', 'Max', 'de');
  assert.ok(text.startsWith('<@u1>'), 'Erwähnung zuerst');
  assert.ok(text.includes('**⏱️ Timeout (1h)**'), 'Maßnahme fett');
  assert.ok(text.includes('**Beleidigung eines Mitglieds**'), 'Hauptgrund fett');

  const warnHead = moderationHeadline({ action: 'warn', reason: 'Spam' }, 'de');
  assert.ok(warnHead.includes('**⚠️ Warnung**'));
  assert.ok(warnHead.includes('**Spam**'));
});

// ---------------------------------------------------------------------------
// 3. Prompt-Direktiven: verdeckte Ausführung
// ---------------------------------------------------------------------------

test('Prompts: Direktiven verbieten jede Erwähnung des Auftraggebers', () => {
  const directives = buildTargetedDirectives({
    targetName: 'Max',
    targetId: '111111111111111111',
    selectedIds: [1, 2],
    adminNote: 'Er stresst Anna seit Tagen.',
  }).join('\n');
  assert.ok(directives.includes('[1], [2]'));
  assert.ok(/NIEMALS/.test(directives));
  assert.ok(directives.includes('Er stresst Anna seit Tagen.'));

  const order = buildOrderDirectives({ order: 'Prüfe den Streit', reasoning: 'Beschwerden' }).join('\n');
  assert.ok(order.includes('Prüfe den Streit'));
  assert.ok(order.includes('Beschwerden'));
});

// ---------------------------------------------------------------------------
// 4. Live-Scan der Nutzer-Nachrichten
// ---------------------------------------------------------------------------

test('Scan: liest die letzten Nachrichten genau eines Nutzers', async () => {
  const w = makeWorld({ messageCount: 40 });
  const ctx = { client: { user: { id: 'bot1' } }, logger: noopLogger };
  const scan = await collectUserMessages({ ctx, guild: w.guild, userId: '111111111111111111', limit: 200 });

  assert.ok(scan.messages.length > 0);
  assert.ok(scan.messages.every((m) => m.authorId === '111111111111111111'));
  assert.ok(scan.messages[0].ord <= scan.messages[scan.messages.length - 1].ord, 'chronologisch sortiert');

  const numbered = numberMessages(scan.messages);
  assert.equal(numbered[0].seq, 1);

  const none = await collectUserMessages({ ctx, guild: w.guild, userId: '777777777777777777', limit: 200 });
  assert.equal(none.messages.length, 0, 'wer nichts geschrieben hat, liefert keine Treffer');
});

// ---------------------------------------------------------------------------
// 5. /security_action – kompletter Ablauf
// ---------------------------------------------------------------------------

async function makeCtx(world) {
  const store = await makeStore();
  store.setApiKey('g1', 'AIza-action-key-1234567');
  store.setLogChannelId('g1', 'clog');
  return {
    store,
    logger: noopLogger,
    env: (k, fb = '') => (k === 'SECURITY_STORE_DISABLE_FILE_BACKUP' ? 'true' : fb),
    client: { user: { id: 'bot1' }, guilds: { cache: new Map([['g1', world.guild]]) } },
  };
}

test('/security_action: Nutzer ohne Nachrichten kann nicht moderiert werden', async () => {
  const w = makeWorld({ messageCount: 10 });
  const ctx = await makeCtx(w);
  const interaction = makeInteraction({
    guild: w.guild,
    options: { user: { id: '777777777777777777', username: 'Leise', bot: false } },
  });
  w.membersCache.set('777777777777777777', {
    id: '777777777777777777',
    displayName: 'Leise',
    permissions: { has: () => false },
    moderatable: true,
  });

  await targeted.handleSecurityAction(ctx, interaction);
  const text = textOf(interaction.state.edits.at(-1));
  assert.match(text, /keine Nachricht geschrieben/);
});

test('/security_action: Auswahl über mehrere Seiten und verdeckte KI-Moderation', async () => {
  const w = makeWorld({ messageCount: 60 }); // > 25 Nachrichten ⇒ mehrere Seiten
  const ctx = await makeCtx(w);
  const interaction = makeInteraction({
    guild: w.guild,
    options: {
      user: { id: '111111111111111111', username: 'Max', bot: false },
      hinweis: 'Bitte diskret prüfen.',
    },
  });

  await targeted.handleSecurityAction(ctx, interaction);
  const first = interaction.state.edits.at(-1);
  const overview = textOf(first);
  assert.match(overview, /KI-Moderation vorbereiten/);
  assert.match(overview, /Seite:\*\* 1\//, 'Seitenanzeige vorhanden');

  const session = [...targeted.sessions.values()].at(-1);
  assert.ok(session, 'Session wurde angelegt');
  assert.ok(session.messages.length > targeted.PAGE_SIZE, 'mehr Nachrichten als eine Seite fasst');

  const pageOneKeys = session.messages.slice(0, targeted.PAGE_SIZE).map((m) => m.discordMessageId);

  // Seite 1: zwei Nachrichten auswählen
  const selInteraction = makeInteraction({ guild: w.guild });
  selInteraction.customId = `secact:sel:${session.token}`;
  selInteraction.values = pageOneKeys.slice(0, 2);
  await targeted.handleComponent(ctx, selInteraction);
  assert.equal(session.selected.size, 2);

  // Blättern und dort eine weitere auswählen – die alte Auswahl bleibt bestehen
  const nextInteraction = makeInteraction({ guild: w.guild });
  nextInteraction.customId = `secact:next:${session.token}`;
  await targeted.handleComponent(ctx, nextInteraction);
  assert.equal(session.page, 1);

  const pageTwoKeys = session.messages
    .slice(targeted.PAGE_SIZE, targeted.PAGE_SIZE * 2)
    .map((m) => m.discordMessageId);
  const sel2 = makeInteraction({ guild: w.guild });
  sel2.customId = `secact:sel:${session.token}`;
  sel2.values = pageTwoKeys.slice(0, 1);
  await targeted.handleComponent(ctx, sel2);
  assert.equal(session.selected.size, 3, 'Auswahl überlebt den Seitenwechsel');

  // Discord-Limit: nie mehr als 25 Optionen pro Select-Menü
  const rendered = targeted.renderSession(session);
  const select = widgetsOf(rendered).find((c) => Array.isArray(c.options));
  assert.ok(select, 'Select-Menü vorhanden');
  assert.ok(select.options.length <= 25, 'Select-Menü hält das 25er-Limit ein');
  assert.ok(
    select.options.every((o) => o.label.length <= 100 && o.value.length <= 100),
    'Discord-Limits für Labels/Values eingehalten'
  );

  // Ausführen: Gemini antwortet mit einem Timeout
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    geminiJsonResponse({
      moderations: [
        {
          message_id: 1,
          action: 'timeout',
          duration: '1h',
          primary: true,
          reason: 'Beleidigung eines Mitglieds',
          personal_message: '{USER} deine Nachricht verstößt gegen die Regeln.',
        },
      ],
    });

  try {
    const runInteraction = makeInteraction({ guild: w.guild });
    runInteraction.customId = `secact:run:${session.token}`;
    await targeted.handleComponent(ctx, runInteraction);

    const result = textOf(runInteraction.state.edits.at(-1));
    assert.match(result, /Erledigt/);
    assert.match(result, /Timeout \(1h\)/);
    assert.ok(!/<@999999999999999999>/.test(result.split('Im Chat')[0] + ''), 'Admin wird im Ergebnis nicht als Moderator genannt');

    const member = w.membersCache.get('111111111111111111');
    assert.equal(member.timeouts.length, 1, 'Timeout wurde tatsächlich gesetzt');

    // Die öffentliche Begründung hängt an der Nachricht – fett formatiert
    const answered = w.history.filter((m) => m.replies.length);
    assert.equal(answered.length, 1);
    const publicText = answered[0].replies[0].content;
    assert.ok(publicText.includes('**⏱️ Timeout (1h)**'));
    assert.ok(publicText.includes('**Beleidigung eines Mitglieds**'));
    assert.ok(!publicText.includes('Admin'), 'kein Hinweis auf den Auftraggeber');

    assert.ok(w.logChannel.sent.length > 0, 'Log-Kanal wurde informiert');
    assert.equal(targeted.sessions.has(session.token), false, 'Session wurde aufgeräumt');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('/security_action: fremde Admins können eine laufende Auswahl nicht kapern', async () => {
  const w = makeWorld({ messageCount: 12 });
  const ctx = await makeCtx(w);
  const interaction = makeInteraction({
    guild: w.guild,
    options: { user: { id: '111111111111111111', username: 'Max', bot: false } },
  });
  await targeted.handleSecurityAction(ctx, interaction);
  const session = [...targeted.sessions.values()].at(-1);

  const stranger = makeInteraction({ guild: w.guild, user: { id: '424242424242424242' } });
  stranger.customId = `secact:next:${session.token}`;
  await targeted.handleComponent(ctx, stranger);
  assert.match(textOf(stranger.state.replies.at(-1)), /anderen Administrator/);
});

// ---------------------------------------------------------------------------
// 6. /security_ai_order – freier Auftrag
// ---------------------------------------------------------------------------

test('/security_ai_order: Formular öffnet sich und der Auftrag wird ausgeführt', async () => {
  const w = makeWorld({ messageCount: 20 });
  const ctx = await makeCtx(w);

  const cmd = makeInteraction({ guild: w.guild });
  await aiOrder.handleAiOrderCommand(ctx, cmd);
  assert.equal(cmd.state.modals.length, 1);
  assert.equal(cmd.state.modals[0].data.custom_id, aiOrder.MODAL_ID);

  const fields = {
    secgem_order_task: 'Moderiere alle, die Anna angreifen.',
    secgem_order_reason: 'Mehrere Beschwerden, die Stimmung kippt.',
    secgem_order_focus: '',
  };
  const modal = makeInteraction({ guild: w.guild });
  modal.customId = aiOrder.MODAL_ID;
  modal.fields = { getTextInputValue: (id) => fields[id] ?? '' };

  const origFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push(JSON.parse(options.body));
    return geminiJsonResponse({
      moderations: [
        {
          message_id: 1,
          action: 'warn',
          primary: true,
          reason: 'Nachtreten gegen ein Mitglied',
          personal_message: '{USER} bitte hör damit auf.',
        },
      ],
    });
  };

  try {
    await aiOrder.handleAiOrderModal(ctx, modal);
    const text = textOf(modal.state.edits.at(-1));
    assert.match(text, /Auftrag ausgeführt/);
    assert.match(text, /Verwarnung/);
    assert.ok(seen.length === 1, 'genau ein Gemini-Aufruf');
    const prompt = seen[0].systemInstruction.parts[0].text;
    assert.ok(prompt.includes('Moderiere alle, die Anna angreifen.'), 'Auftrag steckt im Prompt');
    assert.ok(prompt.includes('Mehrere Beschwerden'), 'Begründung steckt im Prompt');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('/security_ai_order: leerer Auftrag wird abgelehnt', async () => {
  const w = makeWorld({ messageCount: 5 });
  const ctx = await makeCtx(w);
  const modal = makeInteraction({ guild: w.guild });
  modal.customId = aiOrder.MODAL_ID;
  modal.fields = { getTextInputValue: () => '' };
  await aiOrder.handleAiOrderModal(ctx, modal);
  assert.match(textOf(modal.state.replies.at(-1)), /dürfen nicht leer sein/);
});
