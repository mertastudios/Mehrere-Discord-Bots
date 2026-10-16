/**
 * Fakes für den Security-Bot-Test: Discord-Guild/Kanal/Nutzer/Interaction und
 * der Bot-Kontext – alles ohne echte Verbindung, aber mit genug Verhalten,
 * dass Setup, Moderation, Logging und Feedback echt durchlaufen.
 *
 * (Keine *.test.js Datei – wird von `node --test` nicht als Test gestartet.)
 */

const path = require('node:path');
const os = require('node:os');
const { Collection, PermissionFlagsBits } = require('discord.js');

const { createSecurityStore } = require('../bots/security-bot/src/store');

let counter = 0;
function uid(prefix = 'id') {
  counter += 1;
  return `${prefix}${counter}`;
}

function fakePermissions(has = true) {
  return {
    has: () => Boolean(has),
    any: () => Boolean(has),
  };
}

function makeRole({ id = uid('role'), name = 'Rolle', position = 1, administrator = false } = {}) {
  return {
    id,
    name,
    position,
    managed: false,
    permissions: fakePermissions(administrator),
  };
}

function makeMember({ id = uid('user'), displayName = 'Nutzer', administrator = false, position = 1, bot = false } = {}) {
  const member = {
    id,
    displayName,
    bot,
    timeouts: [],
    kicks: [],
    user: { id, username: displayName, bot, globalName: displayName },
    permissions: fakePermissions(administrator),
    roles: { cache: new Collection(), highest: { position } },
    timeout: async (ms, reason) => {
      member.timeouts.push({ ms, reason });
    },
    kick: async (reason) => {
      member.kicks.push(reason);
    },
  };
  return member;
}

function makeMessage({
  id = uid('msg'),
  content = 'Hallo',
  author = { id: uid('user'), username: 'Nutzer' },
  member = null,
  channel = null,
  guild = null,
  embeds = [],
  components = [],
  attachments = 0,
  createdTimestamp = Date.now(),
  reference = null,
} = {}) {
  const message = {
    id,
    content,
    author,
    member,
    channel,
    guild,
    embeds,
    components,
    reference,
    createdTimestamp,
    replies: [],
    mentions: { users: new Collection() },
    attachments: new Collection(
      Array.from({ length: attachments }, (_, i) => [`a${i}`, { contentType: 'image/png', name: `bild${i}.png` }])
    ),
    reply: async (payload) => {
      message.replies.push(payload);
      return { id: uid('reply'), payload };
    },
    fetch: async () => message,
    pin: async () => {},
  };
  return message;
}

function makeChannel({ id = uid('chan'), name = 'allgemein', type = 0, guild = null, messages = [] } = {}) {
  const store = new Collection();
  for (const message of messages) store.set(message.id, message);

  const send = async (payload) => {
    channel.sent.push(payload);
    return { id: uid('sent'), payload, channel };
  };

  const channel = {
    id,
    name,
    type,
    guild,
    sent: [],
    overwrites: null,
    deleted: false,
    send,
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: () => fakePermissions(true),
    permissionOverwrites: {
      set: async (overwrites) => {
        channel.overwrites = overwrites;
      },
    },
    messages: {
      cache: store,
      fetch: async (arg) => {
        if (typeof arg === 'string') {
          const found = store.get(arg);
          if (!found) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
          return found;
        }
        if (arg && typeof arg === 'object' && typeof arg.limit === 'number') {
          return store;
        }
        return store;
      },
      send,
    },
  };
  for (const message of messages) message.channel = channel;
  return channel;
}

function makeGuild({
  id = uid('guild'),
  name = 'Testserver',
  ownerId = 'owner1',
  botId = 'bot1',
  botAdmin = true,
  channels = [],
  roles = [],
} = {}) {
  const everyone = makeRole({ id, name: '@everyone', position: 0 });
  const roleCache = new Collection();
  roleCache.set(everyone.id, everyone);
  for (const role of roles) roleCache.set(role.id, role);

  const channelCache = new Collection();
  for (const channel of channels) {
    channel.guild = null; // wird unten gesetzt
    channelCache.set(channel.id, channel);
  }

  const memberCache = new Collection();
  const guild = {
    id,
    name,
    ownerId,
    channelCache,
    memberCache,
    created: [],
    members: {
      me: {
        id: botId,
        permissions: fakePermissions(botAdmin),
        roles: { cache: new Collection(), highest: { position: 10 } },
      },
      cache: memberCache,
      fetch: async (memberId) => {
        const member = memberCache.get(String(memberId));
        if (!member) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
        return member;
      },
      ban: async (memberId, options) => {
        guild.bans = guild.bans || [];
        guild.bans.push({ memberId, options });
      },
    },
    channels: {
      cache: channelCache,
      fetch: async (channelId) => {
        const found = channelCache.get(String(channelId));
        if (!found) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
        return found;
      },
      create: async (options) => {
        const channel = makeChannel({ name: options.name, type: options.type ?? 0, guild });
        channelCache.set(channel.id, channel);
        guild.created.push(channel);
        return channel;
      },
    },
    roles: { cache: roleCache, everyone },
    fetchOwner: async () => ({
      id: ownerId,
      send: async (payload) => {
        guild.ownerDms = guild.ownerDms || [];
        guild.ownerDms.push(payload);
      },
    }),
  };

  for (const channel of channelCache.values()) channel.guild = guild;
  return guild;
}

/** Bot-Kontext wie in index.js – nur ohne echten Client. */
function makeCtx({ guilds = [], env = {}, logChannel = null } = {}) {
  const cache = new Collection();
  for (const guild of guilds) cache.set(guild.id, guild);

  const dms = [];
  const store = createSecurityStore({
    logger: silent(),
    env: (key, fallback) => (env[key] === undefined ? fallback : env[key]),
    filePath: path.join(os.tmpdir(), `sec-bot-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
  });

  const ctx = {
    client: {
      user: { id: 'bot1', username: 'Sentinel' },
      guilds: { cache },
      users: {
        fetch: async (id) => ({
          id,
          send: async (payload) => {
            dms.push({ id, payload });
          },
        }),
      },
    },
    token: 'token',
    logger: silent(),
    env: (key, fallback) => (env[key] === undefined ? fallback : env[key]),
    store,
    budget: null,
    rest: { put: async () => [], get: async () => [] },
    pipeline: new Map(),
    setupDraft: new Map(),
    adminWarnAt: new Map(),
    fetchFn: async () => {
      throw new Error('kein Netz in Tests');
    },
    botHighestPosition: (g) => g?.members?.me?.roles?.highest?.position ?? 0,
    dms,
    logChannel,
  };
  return ctx;
}

function silent() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

/** Interaction-Fake: zeichnet alles auf, was der Bot antwortet. */
function makeInteraction({
  guild,
  member = null,
  customId = null,
  values = null,
  commandName = null,
  fields = {},
  message = null,
  kind = 'button',
  user = null,
} = {}) {
  const interaction = {
    guild,
    guildId: guild?.id,
    member: member || makeMember({ id: 'admin1', displayName: 'Admin', administrator: true }),
    user: user || member?.user || { id: 'admin1', username: 'Admin' },
    customId,
    values,
    commandName,
    fields: {
      getTextInputValue: (id) => fields[id] ?? '',
      getCheckboxGroup: (id) => fields[id] ?? [],
    },
    message,
    replies: [],
    updates: [],
    modals: [],
    followUps: [],
    edits: [],
    deferred: false,
    replied: false,
    isChatInputCommand: () => kind === 'command',
    isButton: () => kind === 'button',
    isAnySelectMenu: () => kind === 'select',
    isModalSubmit: () => kind === 'modal',
    isRepliable: () => true,
  };

  const record = (list) => (payload) => {
    list.push(payload);
    interaction.replied = true;
    return Promise.resolve(payload);
  };

  interaction.reply = record(interaction.replies);
  interaction.update = async (payload) => {
    interaction.updates.push(payload);
    return payload;
  };
  interaction.followUp = record(interaction.followUps);
  interaction.editReply = async (payload) => {
    interaction.edits.push(payload);
    return payload;
  };
  interaction.deferReply = async () => {
    interaction.deferred = true;
  };
  interaction.deferUpdate = async () => {
    interaction.deferred = true;
  };
  interaction.showModal = async (modal) => {
    interaction.modals.push(modal);
    return modal;
  };
  return interaction;
}

/** Nachricht mit Components V2 (für Feedback-Tests). */
function makeComponentMessage({ id = uid('logmsg'), payload }) {
  const message = {
    id,
    edits: [],
    components: payload?.components || [],
    payload,
    edit: async (body) => {
      message.edits.push(body);
      message.components = body.components || message.components;
      return message;
    },
  };
  return message;
}

/** Alle Textinhalt aus einer Components-V2-Nachricht holen. */
function textsOf(payload) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (!node) continue;
      if (typeof node.content === 'string') out.push(node.content);
      if (node.components) walk(node.components);
      if (node.accessory) walk([node.accessory]);
    }
  };
  walk(payload?.components || (Array.isArray(payload) ? payload : []));
  return out.join('\n');
}

function allComponentsOf(payload) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (!node) continue;
      out.push(node);
      if (node.components) walk(node.components);
      if (node.accessory) walk([node.accessory]);
    }
  };
  walk(payload?.components || []);
  return out;
}

module.exports = {
  uid,
  fakePermissions,
  makeRole,
  makeMember,
  makeMessage,
  makeChannel,
  makeGuild,
  makeCtx,
  makeInteraction,
  makeComponentMessage,
  textsOf,
  allComponentsOf,
  PermissionFlagsBits,
  silent,
};
