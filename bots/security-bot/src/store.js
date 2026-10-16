/**
 * ============================================================================
 *  Datenspeicher – RAM-first, Turso (libSQL) persistent, Datei als Fallback
 *
 *  Gespeichert wird pro Server:
 *   - Konfiguration (Sprache, Kanäle, immune Rollen, Regelwerk, Anweisungen,
 *     erlaubte Maßnahmen, Log-Kanal, Groq-Key, Setup-Fortschritt)
 *   - Strafregister (jede Moderation mit Regel, Maßnahme, Zitat)
 *   - Nachrichten-Puffer (überlebt Neustarts, damit nichts verloren geht)
 *
 *  Alle Zugriffe laufen über den RAM; geschrieben wird gesammelt (dirty-Flags).
 *  Ohne Turso-Konfiguration landen die Daten in einer JSON-Datei, damit lokal
 *  alles genauso funktioniert.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const EMPTY_ALLOW = { ban: false, kick: false, timeout: true };
const SETUP_STEPS = 7;
const MAX_BUFFER = 120; // maximal gepufferte Nachrichten pro Server

function defaultSetup() {
  return { step: 1, furthest: 1, done: false, updatedAt: null, completedAt: null };
}

function defaultGuildConfig(guildId) {
  const now = Date.now();
  return {
    guildId: String(guildId),
    lang: 'de',
    channels: [],
    immuneRoles: [],
    rulesMode: null,
    rules: '',
    instructions: '',
    allow: { ...EMPTY_ALLOW },
    logChannelId: null,
    logAuto: false,
    groqKey: null,
    setup: defaultSetup(),
    createdAt: now,
    updatedAt: now,
  };
}

/** Setup-Stand normalisieren (Schritt 1–7, „weitestes“ nie kleiner als 1). */
function normalizeSetup(raw = {}) {
  const step = Number(raw.step);
  const furthest = Number(raw.furthest);
  return {
    step: Number.isFinite(step) ? Math.min(SETUP_STEPS, Math.max(1, Math.trunc(step))) : 1,
    furthest: Number.isFinite(furthest) ? Math.min(SETUP_STEPS, Math.max(1, Math.trunc(furthest))) : 1,
    done: Boolean(raw.done),
    updatedAt: raw.updatedAt || null,
    completedAt: raw.completedAt || null,
  };
}

function normalizeGuildConfig(raw = {}) {
  const base = defaultGuildConfig(raw.guildId || raw.guild_id || '0');
  const allow = raw.allow && typeof raw.allow === 'object' ? raw.allow : {};
  return {
    ...base,
    lang: typeof raw.lang === 'string' && raw.lang ? raw.lang : base.lang,
    channels: Array.isArray(raw.channels) ? raw.channels.map(String) : [],
    immuneRoles: Array.isArray(raw.immuneRoles) ? raw.immuneRoles.map(String) : [],
    rulesMode: ['manual', 'skip', 'import'].includes(raw.rulesMode) ? raw.rulesMode : null,
    rules: typeof raw.rules === 'string' ? raw.rules : '',
    instructions: typeof raw.instructions === 'string' ? raw.instructions : '',
    allow: {
      // Verwarnen ist die Pflicht-Mindestmaßnahme und immer erlaubt.
      ban: Boolean(allow.ban),
      kick: Boolean(allow.kick),
      timeout: allow.timeout === undefined ? true : Boolean(allow.timeout),
    },
    logChannelId: raw.logChannelId ? String(raw.logChannelId) : null,
    logAuto: Boolean(raw.logAuto),
    groqKey: raw.groqKey ? String(raw.groqKey).trim() : null,
    setup: normalizeSetup(raw.setup),
    createdAt: Number(raw.createdAt) || base.createdAt,
    updatedAt: Number(raw.updatedAt) || base.updatedAt,
  };
}

function penaltyKey(penalty) {
  return String(penalty?.id || penalty?.key || '');
}

function createSecurityStore({ logger, env, filePath = null } = {}) {
  const guilds = new Map(); // guildId -> cfg
  const penalties = new Map(); // guildId -> penalty[]
  const buffer = new Map(); // guildId -> record[]
  const dirty = { guilds: new Set(), penalties: new Set(), buffer: new Set() };

  let db = null;
  let backupTimer = null;
  const localFile =
    filePath ||
    env?.('SECURITY_BOT_DATA_FILE', '') ||
    path.join(__dirname, '..', 'security-bot-data.json');
  const fileBackupEnabled = String(env?.('SECURITY_STORE_DISABLE_FILE_BACKUP', '') || '') !== '1';

  function markGuildDirty(guildId) {
    dirty.guilds.add(String(guildId));
    dirty.penalties.add(String(guildId));
    dirty.buffer.add(String(guildId));
  }

  // ------------------------------ Persistenz ------------------------------

  async function ensureTables() {
    if (!db) return;
    await db.execute(`CREATE TABLE IF NOT EXISTS sec_guilds (
      guild_id TEXT PRIMARY KEY,
      cfg TEXT NOT NULL,
      updated_at INTEGER
    );`);
    await db.execute(`CREATE TABLE IF NOT EXISTS sec_penalties (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      action TEXT NOT NULL,
      duration TEXT,
      rule_id TEXT,
      rule_label TEXT,
      reason TEXT,
      excerpt TEXT,
      channel_id TEXT,
      message_id TEXT,
      source TEXT,
      forced_by TEXT,
      created_at INTEGER NOT NULL
    );`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_sec_pen_guild_user ON sec_penalties(guild_id, user_id);`);
    await db.execute(`CREATE TABLE IF NOT EXISTS sec_buffer (
      key TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      record TEXT NOT NULL,
      ord INTEGER,
      created_at INTEGER
    );`);
    await db.execute(`CREATE TABLE IF NOT EXISTS sec_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }

  async function loadFromDb() {
    if (!db) return;
    const g = await db.execute('SELECT guild_id, cfg FROM sec_guilds');
    for (const row of g.rows) {
      try {
        guilds.set(String(row.guild_id), normalizeGuildConfig(JSON.parse(String(row.cfg))));
      } catch {
        /* kaputter Eintrag → ignorieren (wird beim nächsten Speichern ersetzt) */
      }
    }
    const p = await db.execute('SELECT * FROM sec_penalties ORDER BY created_at ASC');
    for (const row of p.rows) {
      const guildId = String(row.guild_id);
      if (!penalties.has(guildId)) penalties.set(guildId, []);
      penalties.get(guildId).push({
        id: String(row.id),
        guildId,
        userId: String(row.user_id),
        userName: row.user_name ? String(row.user_name) : null,
        action: String(row.action),
        duration: row.duration ? String(row.duration) : null,
        ruleId: row.rule_id ? String(row.rule_id) : null,
        ruleLabel: row.rule_label ? String(row.rule_label) : null,
        reason: row.reason ? String(row.reason) : null,
        excerpt: row.excerpt ? String(row.excerpt) : null,
        channelId: row.channel_id ? String(row.channel_id) : null,
        messageId: row.message_id ? String(row.message_id) : null,
        source: row.source ? String(row.source) : 'ai',
        forcedBy: row.forced_by ? String(row.forced_by) : null,
        createdAt: Number(row.created_at) || Date.now(),
      });
    }
    const b = await db.execute('SELECT guild_id, record FROM sec_buffer ORDER BY ord ASC');
    for (const row of b.rows) {
      const guildId = String(row.guild_id);
      if (!buffer.has(guildId)) buffer.set(guildId, []);
      try {
        buffer.get(guildId).push(JSON.parse(String(row.record)));
      } catch {
        /* kaputter Puffer-Eintrag → ignorieren */
      }
    }
  }

  function saveFile() {
    if (!fileBackupEnabled) return;
    try {
      const data = {
        savedAt: Date.now(),
        guilds: [...guilds.values()],
        penalties: [...penalties.entries()].flatMap(([guildId, list]) => list.map((p) => ({ ...p, guildId }))),
        buffer: [...buffer.entries()].flatMap(([guildId, list]) => list.map((r) => ({ ...r, guildId }))),
      };
      fs.writeFileSync(localFile, JSON.stringify(data, null, 2));
    } catch (err) {
      logger?.warn?.('[security-bot] Datei-Backup fehlgeschlagen:', err.message);
    }
  }

  function loadFile() {
    if (!fileBackupEnabled || !fs.existsSync(localFile)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(localFile, 'utf8'));
      for (const cfg of data.guilds || []) guilds.set(String(cfg.guildId), normalizeGuildConfig(cfg));
      for (const p of data.penalties || []) {
        const guildId = String(p.guildId);
        if (!penalties.has(guildId)) penalties.set(guildId, []);
        penalties.get(guildId).push(p);
      }
      for (const r of data.buffer || []) {
        const guildId = String(r.guildId);
        if (!buffer.has(guildId)) buffer.set(guildId, []);
        buffer.get(guildId).push(r);
      }
      return true;
    } catch (err) {
      logger?.warn?.('[security-bot] Datei-Backup unlesbar:', err.message);
      return false;
    }
  }

  async function flush({ force = false } = {}) {
    if (!db) {
      if (force || dirty.guilds.size) saveFile();
      dirty.guilds.clear();
      dirty.penalties.clear();
      dirty.buffer.clear();
      return;
    }
    const gids = [...new Set([...dirty.guilds, ...dirty.penalties, ...dirty.buffer])];
    if (!gids.length && !force) return;

    for (const guildId of gids) {
      const cfg = guilds.get(guildId);
      if (cfg) {
        await db.execute({
          sql: `INSERT INTO sec_guilds (guild_id, cfg, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(guild_id) DO UPDATE SET cfg=excluded.cfg, updated_at=excluded.updated_at`,
          args: [guildId, JSON.stringify(cfg), Date.now()],
        });
      } else {
        await db.execute({ sql: 'DELETE FROM sec_guilds WHERE guild_id = ?', args: [guildId] });
      }

      await db.execute({ sql: 'DELETE FROM sec_penalties WHERE guild_id = ?', args: [guildId] });
      for (const p of penalties.get(guildId) || []) {
        await db.execute({
          sql: `INSERT OR REPLACE INTO sec_penalties
                (id, guild_id, user_id, user_name, action, duration, rule_id, rule_label, reason, excerpt, channel_id, message_id, source, forced_by, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [
            penaltyKey(p), guildId, String(p.userId), p.userName || null, String(p.action), p.duration || null,
            p.ruleId || null, p.ruleLabel || null, p.reason || null, p.excerpt || null, p.channelId || null,
            p.messageId || null, p.source || 'ai', p.forcedBy || null, Number(p.createdAt) || Date.now(),
          ],
        });
      }

      await db.execute({ sql: 'DELETE FROM sec_buffer WHERE guild_id = ?', args: [guildId] });
      let ord = 0;
      for (const record of buffer.get(guildId) || []) {
        await db.execute({
          sql: 'INSERT OR REPLACE INTO sec_buffer (key, guild_id, record, ord, created_at) VALUES (?,?,?,?,?)',
          args: [String(record.key), guildId, JSON.stringify(record), ord++, Number(record.createdAt) || Date.now()],
        });
      }
    }
    dirty.guilds.clear();
    dirty.penalties.clear();
    dirty.buffer.clear();
    if (fileBackupEnabled) saveFile();
  }

  // ------------------------------ Guild-Config ------------------------------

  function getGuild(guildId) {
    const id = String(guildId);
    if (!guilds.has(id)) guilds.set(id, defaultGuildConfig(id));
    return guilds.get(id);
  }

  function updateGuild(guildId, patch = {}) {
    const cfg = getGuild(guildId);
    const next = normalizeGuildConfig({ ...cfg, ...patch, guildId: cfg.guildId });
    next.updatedAt = Date.now();
    if (patch.setup) {
      next.setup = normalizeSetup({ ...cfg.setup, ...patch.setup, updatedAt: Date.now() });
    }
    guilds.set(cfg.guildId, next);
    dirty.guilds.add(cfg.guildId);
    return next;
  }

  function deleteGuild(guildId) {
    const id = String(guildId);
    guilds.delete(id);
    penalties.delete(id);
    buffer.delete(id);
    markGuildDirty(id);
  }

  function getAllGuilds() {
    return [...guilds.keys()];
  }

  // ------------------------------ Strafregister ------------------------------

  function newPenaltyId() {
    return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  function addPenalty(penalty) {
    const guildId = String(penalty.guildId);
    const entry = {
      id: penalty.id || newPenaltyId(),
      guildId,
      userId: String(penalty.userId),
      userName: penalty.userName || null,
      action: String(penalty.action),
      duration: penalty.duration || null,
      ruleId: penalty.ruleId || null,
      ruleLabel: penalty.ruleLabel || null,
      reason: penalty.reason ? String(penalty.reason).slice(0, 500) : null,
      excerpt: penalty.excerpt ? String(penalty.excerpt).slice(0, 400) : null,
      channelId: penalty.channelId || null,
      messageId: penalty.messageId || null,
      source: penalty.source || 'ai',
      forcedBy: penalty.forcedBy || null,
      createdAt: Number(penalty.createdAt) || Date.now(),
    };
    if (!penalties.has(guildId)) penalties.set(guildId, []);
    penalties.get(guildId).push(entry);
    markGuildDirty(guildId);
    return entry;
  }

  function getPenalty(id) {
    for (const list of penalties.values()) {
      const found = list.find((p) => p.id === String(id));
      if (found) return found;
    }
    return null;
  }

  function removePenalty(id) {
    for (const [guildId, list] of penalties.entries()) {
      const index = list.findIndex((p) => p.id === String(id));
      if (index >= 0) {
        const [removed] = list.splice(index, 1);
        markGuildDirty(guildId);
        return removed;
      }
    }
    return null;
  }

  function listPenalties(guildId, { userId = null, sinceMs = null, limit = null } = {}) {
    const list = (penalties.get(String(guildId)) || [])
      .filter((p) => (userId ? p.userId === String(userId) : true))
      .filter((p) => (sinceMs ? p.createdAt >= sinceMs : true))
      .sort((a, b) => a.createdAt - b.createdAt);
    return limit ? list.slice(-limit) : list;
  }

  /** Strafregister-Text für den Prompt (eine Zeile pro Eintrag). */
  function registerForPrompt(guildId, { userIds = [], sinceMs, maxPerUser = 8 } = {}) {
    const lines = [];
    for (const userId of userIds) {
      const list = listPenalties(guildId, { userId, sinceMs });
      if (!list.length) continue;
      const name = list[list.length - 1].userName || userId;
      lines.push(`${name} (user_id=${userId}): ${list.length} Eintrag/Einträge`);
      for (const p of list.slice(-maxPerUser)) {
        const when = new Date(p.createdAt).toISOString().slice(0, 10);
        const rule = p.ruleLabel || p.ruleId || 'ohne Regel';
        lines.push(`  · ${when} · ${rule} · ${p.action}${p.duration ? ` (${p.duration})` : ''}${p.reason ? ` · ${String(p.reason).slice(0, 90)}` : ''}`);
      }
    }
    return lines.join('\n');
  }

  // ------------------------------ Puffer ------------------------------

  function addBuffered(guildId, record) {
    const id = String(guildId);
    if (!buffer.has(id)) buffer.set(id, []);
    const list = buffer.get(id);
    list.push(record);
    while (list.length > MAX_BUFFER) list.shift();
    dirty.buffer.add(id);
    return record;
  }

  function getBuffer(guildId) {
    return buffer.get(String(guildId)) || [];
  }

  function dropBuffered(guildId, keys) {
    const id = String(guildId);
    const list = buffer.get(id);
    if (!list) return 0;
    const keySet = new Set(keys.map(String));
    const before = list.length;
    buffer.set(id, list.filter((r) => !keySet.has(String(r.key))));
    dirty.buffer.add(id);
    return before - buffer.get(id).length;
  }

  function clearBuffer(guildId) {
    buffer.set(String(guildId), []);
    dirty.buffer.add(String(guildId));
  }

  function pendingCount(guildId) {
    return getBuffer(guildId).length;
  }

  function commit() {
    return flush();
  }

  // ------------------------------ Init/Intervalle ------------------------------

  async function init() {
    const url = String(
      env?.('SECURITY_BOT_TURSO_URL', '') || env?.('SECURITY_TURSO_DATABASE_URL', '') || env?.('TURSO_DATABASE_URL', '') || ''
    ).trim();
    const authToken = String(
      env?.('SECURITY_BOT_TURSO_AUTH_TOKEN', '') || env?.('SECURITY_TURSO_AUTH_TOKEN', '') || env?.('TURSO_AUTH_TOKEN', '') || ''
    ).trim();

    if (url) {
      try {
        const { createClient } = require('@libsql/client');
        db = createClient({ url, authToken: authToken || undefined });
        await ensureTables();
        await loadFromDb();
        logger?.info?.(`[security-bot] Turso verbunden (${guilds.size} Server, ${[...penalties.values()].reduce((n, l) => n + l.length, 0)} Register-Einträge).`);
      } catch (err) {
        db = null;
        logger?.error?.('[security-bot] Turso nicht erreichbar – nutze Datei-Backup:', err.message);
      }
    } else {
      logger?.warn?.('[security-bot] Keine Turso-URL gesetzt – nutze Datei-Backup.');
    }
    if (!db) loadFile();
    return { mode: db ? 'turso' : 'file' };
  }

  function startBackupInterval(ms = 30_000) {
    if (backupTimer) return;
    backupTimer = setInterval(() => {
      void flush().catch((err) => logger?.warn?.('[security-bot] Flush fehlgeschlagen:', err.message));
    }, ms);
    backupTimer.unref?.();
  }

  function stopBackupInterval() {
    if (backupTimer) clearInterval(backupTimer);
    backupTimer = null;
  }

  return {
    init,
    flush,
    commit,
    startBackupInterval,
    stopBackupInterval,
    getGuild,
    updateGuild,
    deleteGuild,
    getAllGuilds,
    addPenalty,
    getPenalty,
    removePenalty,
    listPenalties,
    registerForPrompt,
    addBuffered,
    getBuffer,
    dropBuffered,
    clearBuffer,
    pendingCount,
    raw: { guilds, penalties, buffer, dirty },
    SETUP_STEPS,
  };
}

module.exports = {
  createSecurityStore,
  defaultGuildConfig,
  normalizeGuildConfig,
  normalizeSetup,
  defaultSetup,
  SETUP_STEPS,
  MAX_BUFFER,
};
