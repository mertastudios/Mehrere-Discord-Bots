/**
 * Security Store – RAM-first mit Turso Persistenz und Datei-Fallback.
 *
 * Speichert:
 *  - Gildenkonfiguration (Gemini API-Key, Prompt, Log-Kanal, Sprache)
 *  - Gesammelte Chat-Nachrichten: entweder im offenen Buffer (batch_id NULL)
 *    oder einem fest zugeordneten Batch (für Retry-Persistenz über Neustarts)
 *  - Batch-Metadaten (Retry-Zähler, nächster Versuch) pro Gilde
 *  - Strafenregister (alle Moderationen der letzten Tage)
 *
 * Schreibvorgänge laufen über Dirty-Tracking gebündelt in die Datenbank –
 * ein Absturz verliert maximal das letzte ungespeicherte Intervall.
 */

const fs = require('fs');
const path = require('path');

function parseJsonCol(val, fallback = null) {
  if (val == null || val === '') return fallback;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

function cleanString(value, max = 200) {
  if (value == null) return null;
  const out = String(value).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return out ? out.slice(0, max) : null;
}

function normalizeIdentityMeta(raw, fallbackId = null) {
  if (!raw || typeof raw !== 'object') return null;
  const meta = {
    id: cleanString(raw.id || fallbackId, 40),
    displayName: cleanString(raw.displayName || raw.authorName || raw.name, 100),
    serverNickname: cleanString(raw.serverNickname || raw.nickname || raw.nick, 100),
    globalName: cleanString(raw.globalName || raw.global_name, 100),
    username: cleanString(raw.username || raw.userName, 100),
  };
  if (!meta.id && fallbackId) meta.id = String(fallbackId);
  return Object.values(meta).some(Boolean) ? meta : null;
}

function normalizeMentionsMeta(raw) {
  const source = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const item of source) {
    const meta = normalizeIdentityMeta(item, item?.id);
    if (!meta?.id || seen.has(meta.id)) continue;
    seen.add(meta.id);
    out.push(meta);
    if (out.length >= 20) break;
  }
  return out;
}

function normalizeReplyMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const meta = {
    messageId: cleanString(raw.messageId || raw.message_id, 40),
    channelId: cleanString(raw.channelId || raw.channel_id, 40),
    guildId: cleanString(raw.guildId || raw.guild_id, 40),
    author: normalizeIdentityMeta(raw.author, raw.authorId || raw.author_id),
    content: cleanString(raw.content, 500),
    createdAt: Number(raw.createdAt || raw.created_at) || null,
  };
  return Object.values(meta).some(Boolean) ? meta : null;
}

// ---------- Limits ----------
const MAX_CONTENT_CHARS = 1500;     // Pro Nachricht gekürzt (Discord-Caps reichen eh)
const MAX_BUFFER_MESSAGES = 500;    // Sicherheitsobergrenze pro Buffer
const PENALTY_RETENTION_DAYS = 30;  // Register hart löschen nach 30 Tagen
const BATCH_MAX_AGE_DAYS = 30;      // Batches älter als 30 Tage aufgeben (Datenhygiene)

function normalizeGuildConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cfg = {
    guildId: String(raw.guildId),
    geminiApiKey: raw.geminiApiKey ? String(raw.geminiApiKey).trim() : null,
    prompt: raw.prompt ? String(raw.prompt).slice(0, 4000) : null,
    logChannelId: raw.logChannelId ? String(raw.logChannelId) : null,
    lang: raw.lang || 'de',
    // Anti-Delete: gelöschte letzte Nachrichten echter Nutzer per Webhook erneut senden
    antiDeleteEnabled: Boolean(raw.antiDeleteEnabled),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
  return cfg;
}

function createSecurityStore({ logger, env } = {}) {
  const guilds = new Map();       // guildId -> config
  const messages = new Map();     // key -> message record
  const bufferByGuild = new Map(); // guildId -> [records] (offener Buffer, batch_id null)
  const batchesByGuild = new Map(); // guildId -> [{id, createdAt, retryCount, nextRetryAt, lastError, failuresNotified, size}]
  const messagesByBatch = new Map(); // `${guildId}:${batchId}` -> [records]
  const penalties = new Map();    // key -> penalty record

  let ordCounter = 0;
  let dirtyMetadata = false;

  const dirtyGuilds = new Set();
  const dirtyMessages = new Set();
  const deletedMessages = new Set();
  const dirtyPenalties = new Set();
  const deletedPenalties = new Set();
  const dirtyBatches = new Set();
  const deletedBatches = new Set();
  let commandIds = {};
  const guildCommandIds = new Map();

  let db = null;
  let flushInProgress = false;
  let flushRequested = false;

  const localFallback = path.join(__dirname, '..', 'security-gemini-data.json');
  const sharedFallback = path.join(__dirname, '..', '..', '..', 'data', 'security-gemini-store.json');

  const envFn = typeof env === 'function' ? env : ((key, fb = '') => process.env[key] ?? fb);
  const tursoUrl = envFn('TURSO_DATABASE_URL', '') ||
    envFn('SECURITY_BOT_TURSO_URL', '') ||
    envFn('SECURITY_TURSO_DATABASE_URL', '') ||
    envFn('XP_BOT_TURSO_URL', '') ||
    '';
  const tursoToken = envFn('TURSO_AUTH_TOKEN', '') ||
    envFn('SECURITY_BOT_TURSO_AUTH_TOKEN', '') ||
    envFn('SECURITY_TURSO_AUTH_TOKEN', '') ||
    envFn('XP_BOT_TURSO_AUTH_TOKEN', '') ||
    '';
  const disableFileBackup = envFn('SECURITY_STORE_DISABLE_FILE_BACKUP', '') === 'true';

  function nextOrd() {
    // Zeitbasiert + Laufzähler: sortierbar über Prozessgrenzen, kollisionsfrei genug.
    ordCounter = (ordCounter + 1) % 100;
    return Date.now() * 100 + ordCounter;
  }

  // ----------------- Init / Persistenz -----------------
  async function init() {
    if (tursoUrl) {
      try {
        const { createClient } = require('@libsql/client');
        db = createClient({ url: tursoUrl, authToken: tursoToken || undefined });
        logger?.info?.('[security-bot] Verbinde zu Turso...');
        await ensureTables();
        await loadFromDb();
        logger?.info?.(
          `[security-bot] Turso geladen: ${guilds.size} Gilden, ${bufferByGuild.size} Buffer, ` +
            `${[...batchesByGuild.values()].reduce((n, b) => n + b.length, 0)} Batches, ${penalties.size} Strafen`
        );
        return;
      } catch (e) {
        logger?.error?.('[security-bot] Turso Verbindung fehlgeschlagen, fallback auf RAM+File:', e.message);
        db = null;
      }
    } else {
      logger?.warn?.('[security-bot] Keine TURSO_DATABASE_URL gesetzt – nutze RAM + Datei-Fallback.');
    }
    tryLoadFile();
  }

  async function ensureTables() {
    if (!db) return;
    await db.execute(`CREATE TABLE IF NOT EXISTS secgem_guilds (
      guild_id TEXT PRIMARY KEY,
      gemini_api_key TEXT,
      prompt TEXT,
      log_channel_id TEXT,
      lang TEXT NOT NULL,
      created_at INTEGER,
      updated_at INTEGER
    );`);
    // Migration für bestehende Tabellen (Spalte anti_delete nachrüsten)
    try {
      await db.execute('ALTER TABLE secgem_guilds ADD COLUMN anti_delete INTEGER DEFAULT 0');
    } catch {}
    await db.execute(`CREATE TABLE IF NOT EXISTS secgem_messages (
      key TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      batch_id TEXT,
      seq INTEGER,
      ord INTEGER NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      discord_message_id TEXT,
      sent_at INTEGER NOT NULL,
      is_admin INTEGER DEFAULT 0,
      author_meta TEXT,
      reply_meta TEXT,
      mentions_meta TEXT
    );`);
    // Migration für bestehende Tabellen (Spalte is_admin + Kontext-Metadaten nachrüsten)
    try {
      await db.execute('ALTER TABLE secgem_messages ADD COLUMN is_admin INTEGER DEFAULT 0');
    } catch {}
    try {
      await db.execute('ALTER TABLE secgem_messages ADD COLUMN author_meta TEXT');
    } catch {}
    try {
      await db.execute('ALTER TABLE secgem_messages ADD COLUMN reply_meta TEXT');
    } catch {}
    try {
      await db.execute('ALTER TABLE secgem_messages ADD COLUMN mentions_meta TEXT');
    } catch {}
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_secgem_msg_guild ON secgem_messages(guild_id, batch_id);`);
    await db.execute(`CREATE TABLE IF NOT EXISTS secgem_penalties (
      key TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      action TEXT NOT NULL,
      duration TEXT,
      duration_seconds INTEGER DEFAULT 0,
      reason TEXT,
      message_excerpt TEXT,
      is_primary INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_secgem_pen_guild_user ON secgem_penalties(guild_id, user_id);`);
    await db.execute(`CREATE TABLE IF NOT EXISTS secgem_batches (
      guild_id TEXT PRIMARY KEY,
      batches TEXT NOT NULL,
      updated_at INTEGER
    );`);
    await db.execute(`CREATE TABLE IF NOT EXISTS security_bot_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );`);
  }

  async function loadFromDb() {
    if (!db) return;

    const gRes = await db.execute('SELECT * FROM secgem_guilds');
    for (const row of gRes.rows) {
      const cfg = normalizeGuildConfig({
        guildId: row.guild_id,
        geminiApiKey: row.gemini_api_key || null,
        prompt: row.prompt || null,
        logChannelId: row.log_channel_id || null,
        lang: row.lang || 'de',
        antiDeleteEnabled: Boolean(Number(row.anti_delete) || 0),
        createdAt: row.created_at ? Number(row.created_at) : Date.now(),
        updatedAt: row.updated_at ? Number(row.updated_at) : Date.now(),
      });
      if (cfg) guilds.set(cfg.guildId, cfg);
    }

    const mRes = await db.execute('SELECT * FROM secgem_messages ORDER BY ord ASC, key ASC');
    for (const row of mRes.rows) {
      const rec = {
        key: String(row.key),
        guildId: String(row.guild_id),
        batchId: row.batch_id ? String(row.batch_id) : null,
        seq: row.seq != null ? Number(row.seq) : null,
        ord: Number(row.ord) || 0,
        channelId: String(row.channel_id),
        channelName: row.channel_name || 'unbekannt',
        authorId: String(row.author_id),
        authorName: row.author_name || 'Unbekannt',
        content: String(row.content || ''),
        discordMessageId: row.discord_message_id ? String(row.discord_message_id) : null,
        sentAt: Number(row.sent_at) || Date.now(),
        isAdmin: Boolean(Number(row.is_admin) || 0),
        authorMeta: normalizeIdentityMeta(parseJsonCol(row.author_meta, null), row.author_id),
        replyMeta: normalizeReplyMeta(parseJsonCol(row.reply_meta, null)),
        mentionsMeta: normalizeMentionsMeta(parseJsonCol(row.mentions_meta, [])),
      };
      messages.set(rec.key, rec);
      if (rec.batchId) {
        const mapKey = `${rec.guildId}:${rec.batchId}`;
        if (!messagesByBatch.has(mapKey)) messagesByBatch.set(mapKey, []);
        messagesByBatch.get(mapKey).push(rec);
      } else {
        if (!bufferByGuild.has(rec.guildId)) bufferByGuild.set(rec.guildId, []);
        bufferByGuild.get(rec.guildId).push(rec);
      }
    }

    const pRes = await db.execute('SELECT * FROM secgem_penalties');
    for (const row of pRes.rows) {
      penalties.set(String(row.key), {
        key: String(row.key),
        guildId: String(row.guild_id),
        userId: String(row.user_id),
        userName: row.user_name || null,
        action: row.action || 'warn',
        duration: row.duration || null,
        durationSeconds: Number(row.duration_seconds) || 0,
        reason: row.reason || '',
        messageExcerpt: row.message_excerpt || '',
        isPrimary: Boolean(row.is_primary),
        createdAt: Number(row.created_at) || Date.now(),
      });
    }

    const bRes = await db.execute('SELECT * FROM secgem_batches');
    for (const row of bRes.rows) {
      const list = parseJsonCol(row.batches, []);
      if (Array.isArray(list)) batchesByGuild.set(String(row.guild_id), list);
    }

    try {
      const metaRes = await db.execute(
        "SELECT key, value FROM security_bot_metadata WHERE key IN ('secgem_command_ids', 'secgem_guild_command_ids')"
      );
      for (const row of metaRes.rows) {
        const parsed = parseJsonCol(row.value, null);
        if (!parsed || typeof parsed !== 'object') continue;
        if (row.key === 'secgem_command_ids') commandIds = { ...parsed };
        else if (row.key === 'secgem_guild_command_ids') {
          for (const [gid, ids] of Object.entries(parsed)) guildCommandIds.set(gid, ids);
        }
      }
    } catch (e) {
      logger?.warn?.('[security-bot] Metadata load fail:', e.message);
    }
  }

  function serialize() {
    return {
      guilds: Object.fromEntries([...guilds.entries()]),
      messages: Object.fromEntries([...messages.entries()]),
      penalties: Object.fromEntries([...penalties.entries()]),
      batches: Object.fromEntries([...batchesByGuild.entries()]),
      commandIds,
      guildCommandIds: Object.fromEntries([...guildCommandIds.entries()]),
    };
  }

  function tryLoadFile() {
    if (disableFileBackup) return;
    let data = null;
    for (const p of [localFallback, sharedFallback]) {
      try {
        if (fs.existsSync(p)) {
          data = JSON.parse(fs.readFileSync(p, 'utf8'));
          logger?.info?.(`[security-bot] Fallback-Datei geladen: ${p}`);
          break;
        }
      } catch {}
    }
    if (!data) return;
    try {
      if (data.guilds && typeof data.guilds === 'object') {
        for (const [gid, cfg] of Object.entries(data.guilds)) {
          const norm = normalizeGuildConfig({ ...cfg, guildId: gid });
          if (norm) guilds.set(String(gid), norm);
        }
      }
      if (data.messages && typeof data.messages === 'object') {
        for (const rec of Object.values(data.messages)) {
          if (!rec?.guildId || typeof rec.content !== 'string') continue;
          rec.authorMeta = normalizeIdentityMeta(rec.authorMeta, rec.authorId);
          rec.replyMeta = normalizeReplyMeta(rec.replyMeta);
          rec.mentionsMeta = normalizeMentionsMeta(rec.mentionsMeta);
          messages.set(String(rec.key), rec);
          if (rec.batchId) {
            const mapKey = `${rec.guildId}:${rec.batchId}`;
            if (!messagesByBatch.has(mapKey)) messagesByBatch.set(mapKey, []);
            messagesByBatch.get(mapKey).push(rec);
          } else {
            if (!bufferByGuild.has(rec.guildId)) bufferByGuild.set(rec.guildId, []);
            bufferByGuild.get(rec.guildId).push(rec);
          }
        }
      }
      if (data.penalties && typeof data.penalties === 'object') {
        for (const [key, pen] of Object.entries(data.penalties)) {
          if (pen && typeof pen === 'object') penalties.set(String(key), pen);
        }
      }
      if (data.batches && typeof data.batches === 'object') {
        for (const [gid, list] of Object.entries(data.batches)) {
          if (Array.isArray(list)) batchesByGuild.set(String(gid), list);
        }
      }
      if (data.commandIds && typeof data.commandIds === 'object') commandIds = { ...data.commandIds };
      if (data.guildCommandIds && typeof data.guildCommandIds === 'object') {
        for (const [gid, ids] of Object.entries(data.guildCommandIds)) guildCommandIds.set(gid, ids);
      }
    } catch (e) {
      logger?.warn?.('[security-bot] Fallback-Datei korrupt:', e.message);
    }
  }

  function saveToFile() {
    if (disableFileBackup) return;
    const json = JSON.stringify(serialize());
    for (const p of [localFallback, sharedFallback]) {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, json);
      } catch {}
    }
  }

  // ----------------- Guild Configuration API -----------------
  function getGuild(guildId) {
    return guilds.get(String(guildId)) || null;
  }

  function ensureGuild(guildId) {
    const id = String(guildId);
    let cfg = guilds.get(id);
    if (!cfg) {
      cfg = normalizeGuildConfig({ guildId: id, lang: 'de', createdAt: Date.now(), updatedAt: Date.now() });
      guilds.set(id, cfg);
      dirtyGuilds.add(id);
      // Falls die Gilde vorher gelöscht wurde, darf der anstehende Guild-Delete
      // die frischen Daten nicht mehr wegblasen.
      deletedBatches.delete(id);
    }
    return cfg;
  }

  function setGuild(cfg) {
    if (!cfg?.guildId) return;
    const normalized = normalizeGuildConfig(cfg);
    if (!normalized) return;
    normalized.updatedAt = Date.now();
    guilds.set(normalized.guildId, normalized);
    dirtyGuilds.add(normalized.guildId);
  }

  function deleteGuild(guildId) {
    const id = String(guildId);
    guilds.delete(id);
    guildCommandIds.delete(id);
    dirtyGuilds.delete(id);
    batchesByGuild.delete(id);
    bufferByGuild.delete(id);
    deletedBatches.add(id);
    for (const [key, rec] of messages.entries()) {
      if (rec.guildId === id) {
        messages.delete(key);
        dirtyMessages.delete(key);
        deletedMessages.add(key);
      }
    }
    for (const [key, pen] of penalties.entries()) {
      if (pen.guildId === id) {
        penalties.delete(key);
        dirtyPenalties.delete(key);
        deletedPenalties.add(key);
      }
    }
  }

  function getAllGuilds() {
    return [...guilds.values()];
  }

  function getApiKey(guildId) {
    return guilds.get(String(guildId))?.geminiApiKey || null;
  }

  function setApiKey(guildId, apiKey) {
    const cfg = ensureGuild(guildId);
    cfg.geminiApiKey = apiKey ? String(apiKey).trim() : null;
    cfg.updatedAt = Date.now();
    dirtyGuilds.add(cfg.guildId);
  }

  function getPrompt(guildId) {
    return guilds.get(String(guildId))?.prompt || null;
  }

  function setPrompt(guildId, prompt) {
    const cfg = ensureGuild(guildId);
    cfg.prompt = prompt ? String(prompt).slice(0, 4000) : null;
    cfg.updatedAt = Date.now();
    dirtyGuilds.add(cfg.guildId);
  }

  function getLogChannelId(guildId) {
    return guilds.get(String(guildId))?.logChannelId || null;
  }

  function setLogChannelId(guildId, channelId) {
    const cfg = ensureGuild(guildId);
    cfg.logChannelId = channelId ? String(channelId) : null;
    cfg.updatedAt = Date.now();
    dirtyGuilds.add(cfg.guildId);
  }

  function getAntiDeleteEnabled(guildId) {
    return Boolean(guilds.get(String(guildId))?.antiDeleteEnabled);
  }

  function setAntiDeleteEnabled(guildId, enabled) {
    const cfg = ensureGuild(guildId);
    cfg.antiDeleteEnabled = Boolean(enabled);
    cfg.updatedAt = Date.now();
    dirtyGuilds.add(cfg.guildId);
  }

  function getLanguage(guildId) {
    return guilds.get(String(guildId))?.lang || 'de';
  }

  function setLanguage(guildId, lang) {
    const cfg = ensureGuild(guildId);
    cfg.lang = lang || 'de';
    cfg.updatedAt = Date.now();
    dirtyGuilds.add(cfg.guildId);
  }

  // ----------------- Message Buffer API -----------------
  function addBufferMessage(guildId, data) {
    const id = String(guildId);
    if (!bufferByGuild.has(id)) bufferByGuild.set(id, []);
    const buffer = bufferByGuild.get(id);
    if (buffer.length >= MAX_BUFFER_MESSAGES) return null;

    const rec = {
      key: `${id}:buffer:m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      guildId: id,
      batchId: null,
      seq: null,
      ord: nextOrd(),
      channelId: String(data.channelId),
      channelName: String(data.channelName || 'unbekannt').slice(0, 100),
      authorId: String(data.authorId),
      authorName: String(data.authorName || 'Unbekannt').slice(0, 100),
      content: String(data.content || '').slice(0, MAX_CONTENT_CHARS),
      discordMessageId: data.discordMessageId ? String(data.discordMessageId) : null,
      sentAt: Number(data.sentAt) || Date.now(),
      isAdmin: Boolean(data.isAdmin),
      authorMeta: normalizeIdentityMeta(data.authorMeta, data.authorId),
      replyMeta: normalizeReplyMeta(data.replyMeta),
      mentionsMeta: normalizeMentionsMeta(data.mentionsMeta),
    };
    buffer.push(rec);
    messages.set(rec.key, rec);
    dirtyMessages.add(rec.key);
    return rec;
  }

  function getBuffer(guildId) {
    return bufferByGuild.get(String(guildId)) || [];
  }

  function getBufferTokenEstimate(guildId, estimateTokensFn) {
    const estimate = typeof estimateTokensFn === 'function'
      ? estimateTokensFn
      : (text) => Math.ceil(String(text || '').length / 3);
    return getBuffer(guildId).reduce((sum, m) => {
      const metaText = [
        m.content,
        m.authorName,
        m.authorMeta ? JSON.stringify(m.authorMeta) : '',
        m.replyMeta ? JSON.stringify(m.replyMeta) : '',
        Array.isArray(m.mentionsMeta) && m.mentionsMeta.length ? JSON.stringify(m.mentionsMeta) : '',
      ].filter(Boolean).join('\n');
      return sum + estimate(metaText);
    }, 0);
  }

  /**
   * Verschiebt den kompletten offenen Buffer in einen neuen Batch und vergibt
   * die Gemini-Nachrichten-IDs (seq) ab 1 in chronologischer Reihenfolge.
   * Admin-Nachrichten bleiben im Batch (Kontext), bekommen aber KEINE seq –
   * sie sind damit für Gemini nicht referenzierbar und nie moderierbar.
   */
  function buildBatchFromBuffer(guildId) {
    const id = String(guildId);
    const buffer = bufferByGuild.get(id) || [];
    if (buffer.length === 0) return null;

    const batchId = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const ordered = [...buffer].sort((a, b) => a.ord - b.ord);
    const mapKey = `${id}:${batchId}`;
    const list = [];
    let seq = 0;
    for (const rec of ordered) {
      rec.batchId = batchId;
      rec.seq = rec.isAdmin ? null : ++seq;
      dirtyMessages.add(rec.key);
      list.push(rec);
    }
    messagesByBatch.set(mapKey, list);
    bufferByGuild.set(id, []);

    const meta = {
      id: batchId,
      createdAt: Date.now(),
      retryCount: 0,
      nextRetryAt: 0,
      lastError: null,
      failuresNotified: 0,
      size: list.length,
      moderatable: seq,
    };
    const batches = batchesByGuild.get(id) || [];
    batches.push(meta);
    batchesByGuild.set(id, batches);
    dirtyBatches.add(id);

    logger?.info?.(
      `[security-bot] Batch ${batchId} für Gilde ${id} erstellt: ${list.length} Nachrichten ` +
        `(${seq} moderierbar mit IDs 1-${seq}, ${list.length - seq} Admin-Kontext)`
    );
    return meta;
  }

  function getBatches(guildId) {
    return batchesByGuild.get(String(guildId)) || [];
  }

  function setBatches(guildId, list) {
    const id = String(guildId);
    if (Array.isArray(list)) {
      batchesByGuild.set(id, list);
      dirtyBatches.add(id);
    }
  }

  function getBatchMessages(guildId, batchId) {
    const list = messagesByBatch.get(`${String(guildId)}:${String(batchId)}`) || [];
    // Chronologisch (ord) – Admin-Nachrichten haben keine seq, gehören aber
    // an ihre echte Position im Gespräch.
    return [...list].sort((a, b) => (a.ord || 0) - (b.ord || 0));
  }

  function deleteBatch(guildId, batchId) {
    const id = String(guildId);
    const mapKey = `${id}:${String(batchId)}`;
    const recs = messagesByBatch.get(mapKey) || [];
    for (const rec of recs) {
      messages.delete(rec.key);
      dirtyMessages.delete(rec.key);
      deletedMessages.add(rec.key);
    }
    messagesByBatch.delete(mapKey);
    const batches = (batchesByGuild.get(id) || []).filter((b) => b.id !== String(batchId));
    batchesByGuild.set(id, batches);
    dirtyBatches.add(id);
  }

  function countPendingMessages(guildId) {
    const id = String(guildId);
    const buffered = (bufferByGuild.get(id) || []).length;
    const inBatches = (batchesByGuild.get(id) || []).reduce(
      (sum, b) => sum + (messagesByBatch.get(`${id}:${b.id}`)?.length || 0),
      0
    );
    return buffered + inBatches;
  }

  // ----------------- Strafenregister API -----------------
  function addPenalty(data) {
    if (!data?.guildId || !data?.userId) return null;
    const rec = {
      key: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      guildId: String(data.guildId),
      userId: String(data.userId),
      userName: data.userName ? String(data.userName).slice(0, 100) : null,
      action: String(data.action || 'warn'),
      duration: data.duration ? String(data.duration) : null,
      durationSeconds: Number(data.durationSeconds) || 0,
      reason: String(data.reason || '').slice(0, 1000),
      messageExcerpt: String(data.messageExcerpt || '').slice(0, 300),
      isPrimary: Boolean(data.isPrimary),
      createdAt: Number(data.createdAt) || Date.now(),
    };
    penalties.set(rec.key, rec);
    dirtyPenalties.add(rec.key);
    return rec;
  }

  /**
   * Strafenübersicht pro Nutzer: count + letzter Eintrag, begrenzt auf die
   * letzten `days` Tage (Standard 20 – genau das Fenster, das Gemini sieht).
   */
  function getPenaltySummary(guildId, { days = 20, now = Date.now() } = {}) {
    const gid = String(guildId);
    const cutoff = now - days * 86400 * 1000;
    const summary = new Map();
    for (const pen of penalties.values()) {
      if (pen.guildId !== gid || pen.createdAt < cutoff) continue;
      const entry = summary.get(pen.userId) || { count: 0, lastAt: 0, lastAction: null };
      entry.count += 1;
      if (pen.createdAt > entry.lastAt) {
        entry.lastAt = pen.createdAt;
        entry.lastAction = pen.action;
      }
      summary.set(pen.userId, entry);
    }
    return summary;
  }

  function countPenaltiesSince(guildId, userId, days = 20, now = Date.now()) {
    const cutoff = now - days * 86400 * 1000;
    let count = 0;
    for (const pen of penalties.values()) {
      if (pen.guildId === String(guildId) && pen.userId === String(userId) && pen.createdAt >= cutoff) count++;
    }
    return count;
  }

  function prune(now = Date.now()) {
    let prunedPenalties = 0;
    const penaltyCutoff = now - PENALTY_RETENTION_DAYS * 86400 * 1000;
    for (const [key, pen] of penalties.entries()) {
      if (pen.createdAt < penaltyCutoff) {
        penalties.delete(key);
        dirtyPenalties.delete(key);
        deletedPenalties.add(key);
        prunedPenalties++;
      }
    }

    // Sehr alte Batches aufgeben (Datenhygiene) – der Moderator meldet das im Log-Kanal.
    const dropped = [];
    const batchCutoff = now - BATCH_MAX_AGE_DAYS * 86400 * 1000;
    for (const [gid, batches] of batchesByGuild.entries()) {
      for (const batch of batches) {
        if ((batch.createdAt || 0) < batchCutoff) {
          const msgs = getBatchMessages(gid, batch.id);
          dropped.push({ guildId: gid, batch, count: msgs.length });
          deleteBatch(gid, batch.id);
        }
      }
    }
    return { prunedPenalties, dropped };
  }

  // ----------------- Command IDs API -----------------
  function getCommandIds() {
    return { ...commandIds };
  }
  function getCommandId(name) {
    return commandIds[name] || null;
  }
  function setCommandIds(ids) {
    if (ids && typeof ids === 'object') {
      commandIds = { ...ids };
      dirtyMetadata = true;
      try { saveToFile(); } catch {}
    }
  }
  function getGuildCommandIds(guildId) {
    return guildCommandIds.get(String(guildId)) || null;
  }
  function setGuildCommandIds(guildId, ids) {
    if (guildId && ids && typeof ids === 'object') {
      guildCommandIds.set(String(guildId), { ...ids });
      dirtyMetadata = true;
      try { saveToFile(); } catch {}
    }
  }
  function clearGuildCommandIds() {
    guildCommandIds.clear();
    dirtyMetadata = true;
  }

  // ----------------- Flush -----------------
  async function flush({ force = false } = {}) {
    if (flushInProgress) {
      flushRequested = true;
      return;
    }
    const hasWork =
      dirtyGuilds.size || dirtyMessages.size || deletedMessages.size ||
      dirtyPenalties.size || deletedPenalties.size ||
      dirtyBatches.size || deletedBatches.size || dirtyMetadata;
    if (!hasWork && !force) return;

    flushInProgress = true;
    flushRequested = false;
    const start = Date.now();

    const pendingGuilds = new Set(dirtyGuilds);
    const pendingMessages = new Set(dirtyMessages);
    const pendingDeletedMessages = new Set(deletedMessages);
    const pendingPenalties = new Set(dirtyPenalties);
    const pendingDeletedPenalties = new Set(deletedPenalties);
    const pendingBatches = new Set(dirtyBatches);
    const pendingDeletedBatches = new Set(deletedBatches);
    const pendingMetadata = dirtyMetadata;

    for (const k of pendingGuilds) dirtyGuilds.delete(k);
    for (const k of pendingMessages) dirtyMessages.delete(k);
    for (const k of pendingDeletedMessages) deletedMessages.delete(k);
    for (const k of pendingPenalties) dirtyPenalties.delete(k);
    for (const k of pendingDeletedPenalties) deletedPenalties.delete(k);
    for (const k of pendingBatches) dirtyBatches.delete(k);
    for (const k of pendingDeletedBatches) deletedBatches.delete(k);
    if (pendingMetadata) dirtyMetadata = false;

    let success = false;
    try {
      if (db) {
        const statements = [];

        for (const gid of pendingDeletedBatches) {
          statements.push({ sql: 'DELETE FROM secgem_guilds WHERE guild_id = ?', args: [gid] });
          statements.push({ sql: 'DELETE FROM secgem_messages WHERE guild_id = ?', args: [gid] });
          statements.push({ sql: 'DELETE FROM secgem_penalties WHERE guild_id = ?', args: [gid] });
          statements.push({ sql: 'DELETE FROM secgem_batches WHERE guild_id = ?', args: [gid] });
        }
        for (const key of pendingDeletedMessages) {
          statements.push({ sql: 'DELETE FROM secgem_messages WHERE key = ?', args: [key] });
        }
        for (const key of pendingDeletedPenalties) {
          statements.push({ sql: 'DELETE FROM secgem_penalties WHERE key = ?', args: [key] });
        }

        for (const gid of pendingGuilds) {
          const g = guilds.get(gid);
          if (!g) continue;
          statements.push({
            sql: `INSERT INTO secgem_guilds (guild_id, gemini_api_key, prompt, log_channel_id, lang, anti_delete, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(guild_id) DO UPDATE SET
                    gemini_api_key=excluded.gemini_api_key,
                    prompt=excluded.prompt,
                    log_channel_id=excluded.log_channel_id,
                    lang=excluded.lang,
                    anti_delete=excluded.anti_delete,
                    updated_at=excluded.updated_at`,
            args: [
              g.guildId,
              g.geminiApiKey || null,
              g.prompt || null,
              g.logChannelId || null,
              g.lang || 'de',
              g.antiDeleteEnabled ? 1 : 0,
              g.createdAt || Date.now(),
              g.updatedAt || Date.now(),
            ],
          });
        }

        for (const key of pendingMessages) {
          const m = messages.get(key);
          if (!m) continue;
          statements.push({
            sql: `INSERT INTO secgem_messages (key, guild_id, batch_id, seq, ord, channel_id, channel_name,
                    author_id, author_name, content, discord_message_id, sent_at, is_admin,
                    author_meta, reply_meta, mentions_meta)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET
                    batch_id=excluded.batch_id,
                    seq=excluded.seq,
                    content=excluded.content,
                    author_meta=excluded.author_meta,
                    reply_meta=excluded.reply_meta,
                    mentions_meta=excluded.mentions_meta`,
            args: [
              m.key, m.guildId, m.batchId, m.seq, m.ord, m.channelId, m.channelName,
              m.authorId, m.authorName, m.content, m.discordMessageId, m.sentAt,
              m.isAdmin ? 1 : 0,
              m.authorMeta ? JSON.stringify(m.authorMeta) : null,
              m.replyMeta ? JSON.stringify(m.replyMeta) : null,
              Array.isArray(m.mentionsMeta) && m.mentionsMeta.length ? JSON.stringify(m.mentionsMeta) : null,
            ],
          });
        }

        for (const key of pendingPenalties) {
          const p = penalties.get(key);
          if (!p) continue;
          statements.push({
            sql: `INSERT INTO secgem_penalties (key, guild_id, user_id, user_name, action, duration,
                    duration_seconds, reason, message_excerpt, is_primary, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET
                    user_name=excluded.user_name`,
            args: [
              p.key, p.guildId, p.userId, p.userName, p.action, p.duration,
              p.durationSeconds, p.reason, p.messageExcerpt, p.isPrimary ? 1 : 0, p.createdAt,
            ],
          });
        }

        for (const gid of pendingBatches) {
          if (deletedBatches.has(gid) && !batchesByGuild.has(gid)) continue;
          statements.push({
            sql: `INSERT INTO secgem_batches (guild_id, batches, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(guild_id) DO UPDATE SET batches=excluded.batches, updated_at=excluded.updated_at`,
            args: [gid, JSON.stringify(batchesByGuild.get(gid) || []), Date.now()],
          });
        }

        if (pendingMetadata) {
          statements.push({
            sql: `INSERT INTO security_bot_metadata (key, value) VALUES ('secgem_command_ids', ?)
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
            args: [JSON.stringify(commandIds)],
          });
          statements.push({
            sql: `INSERT INTO security_bot_metadata (key, value) VALUES ('secgem_guild_command_ids', ?)
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
            args: [JSON.stringify(Object.fromEntries([...guildCommandIds.entries()]))],
          });
        }

        if (statements.length > 0) {
          const chunk = 50;
          for (let i = 0; i < statements.length; i += chunk) {
            await db.batch(statements.slice(i, i + chunk));
          }
          logger?.info?.(
            `[security-bot] Flush: ${statements.length} ops in ${Date.now() - start}ms ` +
              `(guilds:${pendingGuilds.size} msgs:${pendingMessages.size} pens:${pendingPenalties.size})`
          );
        }
        try { saveToFile(); } catch {}
      } else {
        saveToFile();
      }
      success = true;
    } catch (e) {
      for (const gid of pendingGuilds) if (guilds.has(gid) && !deletedBatches.has(gid)) dirtyGuilds.add(gid);
      for (const key of pendingMessages) if (messages.has(key) && !deletedMessages.has(key)) dirtyMessages.add(key);
      for (const key of pendingPenalties) if (penalties.has(key) && !deletedPenalties.has(key)) dirtyPenalties.add(key);
      for (const gid of pendingBatches) if (batchesByGuild.has(gid) && !deletedBatches.has(gid)) dirtyBatches.add(gid);
      if (pendingMetadata) dirtyMetadata = true;
      logger?.error?.('[security-bot] Flush fehlgeschlagen:', e.message);
    } finally {
      flushInProgress = false;
      const needsMore =
        flushRequested || dirtyGuilds.size || dirtyMessages.size || deletedMessages.size ||
        dirtyPenalties.size || deletedPenalties.size || dirtyBatches.size || deletedBatches.size || dirtyMetadata;
      flushRequested = false;
      if (success && needsMore) queueMicrotask(() => void flush());
    }
  }

  let backupTimer = null;
  function startBackupInterval(ms = 5 * 60 * 1000) {
    if (backupTimer) clearInterval(backupTimer);
    backupTimer = setInterval(() => { void flush(); }, ms);
    if (backupTimer.unref) backupTimer.unref();
  }
  function stopBackupInterval() {
    if (backupTimer) clearInterval(backupTimer);
  }

  return {
    init,
    flush,
    startBackupInterval,
    stopBackupInterval,
    getGuild,
    ensureGuild,
    setGuild,
    deleteGuild,
    getAllGuilds,
    getApiKey,
    setApiKey,
    getPrompt,
    setPrompt,
    getLogChannelId,
    setLogChannelId,
    getAntiDeleteEnabled,
    setAntiDeleteEnabled,
    getLanguage,
    setLanguage,
    addBufferMessage,
    getBuffer,
    getBufferTokenEstimate,
    buildBatchFromBuffer,
    getBatches,
    setBatches,
    getBatchMessages,
    deleteBatch,
    countPendingMessages,
    addPenalty,
    getPenaltySummary,
    countPenaltiesSince,
    prune,
    getCommandIds,
    getCommandId,
    setCommandIds,
    getGuildCommandIds,
    setGuildCommandIds,
    clearGuildCommandIds,
    _guilds: guilds,
    _messages: messages,
    _penalties: penalties,
    _db: () => db,
  };
}

module.exports = {
  createSecurityStore,
  MAX_CONTENT_CHARS,
  MAX_BUFFER_MESSAGES,
  PENALTY_RETENTION_DAYS,
  BATCH_MAX_AGE_DAYS,
};
