/**
 * Scheduler des XP-Bots.
 *
 * Die drei zeitkritischen Aufgaben laufen absichtlich unabhängig voneinander:
 *  1. täglicher Decay / Command-Selbstheilung / Backup
 *  2. geplante Bonus-Drops
 *  3. stündliches Leaderboard
 *
 * Dadurch kann ein langsamer Discord-Request beim Leaderboard weder Bonus-Drops
 * noch den Tageswechsel blockieren. Ebenso besitzt das stündliche Leaderboard
 * einen EIGENEN, persistierten Zeitstempel. Level-Up-Refreshes verändern diesen
 * Zeitstempel nicht – genau diese Vermischung war die Ursache dafür, dass das
 * Board trotz angeblichem Stunden-Timer über viele Stunden stehen blieb.
 */

const {
  todayKey,
  missedDailyDecayDays,
  MAX_DECAY_CATCHUP_DAYS,
} = require('./logic');
const { buildLeaderboardEmbed } = require('./embed-builder');
const { componentsV2Payload } = require('./message-payload');
const { syncLevelRolesForUser } = require('./level-roles');
const { refreshRankNicknames } = require('./nicknames');
const { sendLevelAnnouncement } = require('./level-announcements');

const MINUTE_MS = 60_000;
const LEADERBOARD_MIN_REFRESH_MS = 10 * 60 * 1000;
// Leaderboard-Nachrichten dürfen NIEMALS benachrichtigen. Die Top-15-Zeilen
// enthalten <@id>-Mentions (anklickbare Namen); Discord pingt bei Components V2
// jede Mention in einem TextDisplay, sobald eine Nachricht NEU gesendet wird.
// Genau das hat im kombinierten Kanal bei jedem Neu-Senden alle 15 Nutzer
// gepingt („200 Erwähnungen nach einer Stunde offline“). parse: [] rendert die
// Namen weiterhin, löst aber keine Benachrichtigung aus – bei send UND edit.
const LEADERBOARD_ALLOWED_MENTIONS = Object.freeze({ parse: [] });
// Prüfung erfolgt minütlich. 55 Minuten geben ausreichend Toleranz für einen
// verzögerten Event-Loop und halten den sichtbaren Zeitstempel sicher frisch.
const LEADERBOARD_HOURLY_MS = 55 * 60 * 1000;
const LEADERBOARD_HOURLY_RETRY_MS = 2 * 60 * 1000;
const COMMAND_RETRY_EVERY_TICKS = 15;
// Kein einzelner Discord-/Netzwerk-Request darf einen Scheduler dauerhaft
// einfrieren. Nach 45s wird der Lock freigegeben; der nächste Tick kann heilen.
const SCHEDULER_GUILD_TASK_TIMEOUT_MS = 45_000;

// Allgemeiner letzter erfolgreicher Edit (Throttle für Level-Up/-Down).
const lastLeaderboardRefresh = new Map();
// Ausschließlich letzter erfolgreicher Stunden-/Startup-/Decay-Edit.
const lastHourlyRefresh = new Map();
// Ausschließlich letzter VERSUCH des Stunden-Refreshs.
const lastLeaderboardAttempt = new Map();
// Manueller /update_leaderboard-Cooldown (5 Minuten pro Server).
const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const lastManualRefresh = new Map();

/**
 * 5-Minuten-Cooldown für /update_leaderboard.
 * Rückgabe: 0 = sofort erlaubt, sonst verbleibende Millisekunden.
 */
function isManualRefreshDue(guildId, now = Date.now()) {
  const last = lastManualRefresh.get(guildId) || 0;
  const remaining = MANUAL_REFRESH_COOLDOWN_MS - (now - last);
  return remaining > 0 ? remaining : 0;
}

function noteManualRefresh(guildId, now = Date.now()) {
  lastManualRefresh.set(guildId, now);
}

function asTimestamp(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isLeaderboardRefreshDue(guildId, now = Date.now()) {
  const last = lastLeaderboardRefresh.get(guildId) || 0;
  return now - last >= LEADERBOARD_MIN_REFRESH_MS;
}

function isHourlyRefreshDue(guildId, now = Date.now()) {
  const last = lastHourlyRefresh.get(guildId) || 0;
  return now - last >= LEADERBOARD_HOURLY_MS;
}

function noteLeaderboardRefresh(guildId, now = Date.now()) {
  lastLeaderboardRefresh.set(guildId, now);
}

function noteHourlyRefresh(guildId, now = Date.now()) {
  lastHourlyRefresh.set(guildId, now);
  // Ein Stunden-Edit ist natürlich zugleich ein allgemeiner Edit.
  lastLeaderboardRefresh.set(guildId, now);
}

/**
 * Lädt die beiden UNABHÄNGIGEN Zeitstempel aus der Persistenz.
 *
 * Wichtig: Für `lastHourlyRefresh` gibt es absichtlich KEINEN Fallback auf das
 * alte Feld `lastLeaderboardRefresh`. Das alte Feld wurde von Level-Ups
 * überschrieben und ist daher als Stunden-Zeitstempel unbrauchbar. Bestehende
 * Installationen ohne das neue Feld erhalten beim nächsten Start sofort einen
 * frischen Stunden-Refresh und sind danach sauber migriert.
 */
function syncMapsFromEntry(entry) {
  if (!entry?.guildId) return;

  const persistedGeneral = asTimestamp(entry.lastLeaderboardRefresh || entry.lastLeaderboardUpdate);
  if (persistedGeneral > (lastLeaderboardRefresh.get(entry.guildId) || 0)) {
    lastLeaderboardRefresh.set(entry.guildId, persistedGeneral);
  }

  const persistedHourly = asTimestamp(entry.lastHourlyLeaderboardRefresh);
  if (persistedHourly > (lastHourlyRefresh.get(entry.guildId) || 0)) {
    lastHourlyRefresh.set(entry.guildId, persistedHourly);
  }
}

/**
 * Holt eine Gilde robust. Nur Discord-Code 10004 bedeutet definitiv, dass der
 * Bot entfernt wurde; bei Netz-/Cachefehlern bleibt die Konfiguration erhalten.
 */
async function resolveGuild(ctx, guildId) {
  const cached = ctx.client.guilds.cache.get(guildId);
  if (cached) return { guild: cached, gone: false };
  try {
    const guild = await ctx.client.guilds.fetch(guildId);
    return { guild: guild || null, gone: !guild };
  } catch (err) {
    if (err?.code === 10004) return { guild: null, gone: true };
    return { guild: null, gone: false };
  }
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} nach ${Math.round(ms / 1000)}s abgebrochen`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function forEachConfiguredGuild(ctx, taskName, handler) {
  const entries = ctx.store.getAllGuilds();
  const jobs = entries.map((entry) => {
    const job = (async () => {
      const { guild, gone } = await resolveGuild(ctx, entry.guildId);
      if (gone) {
        ctx.store.deleteGuild(entry.guildId);
        return;
      }
      if (!guild) {
        ctx.logger.warn(`[xp-level-bot] ${taskName}: Gilde ${entry.guildId} aktuell nicht erreichbar (Config bleibt)`);
        return;
      }
      await handler(entry, guild);
    })();
    return withTimeout(
      job,
      SCHEDULER_GUILD_TASK_TIMEOUT_MS,
      `${taskName} für Gilde ${entry.guildId}`
    );
  });
  const results = await Promise.allSettled(jobs);

  for (const result of results) {
    if (result.status === 'rejected') {
      ctx.logger.warn(`[xp-level-bot] ${taskName} fehlgeschlagen:`, result.reason?.message || result.reason);
    }
  }
}

async function runMaintenanceTick(ctx, counter, now = new Date()) {
  if (ctx.commandsRegistered === false && counter % COMMAND_RETRY_EVERY_TICKS === 1) {
    try {
      const { registerCommands } = require('./commands');
      await registerCommands(ctx);
    } catch (err) {
      ctx.logger.warn('[xp-level-bot] Command-Selbstheilung fehlgeschlagen:', err?.message || err);
    }
  }
  if (counter > 0 && counter % (24 * 60) === 0) ctx.commandsRegistered = false;

  await forEachConfiguredGuild(ctx, 'Maintenance', async (entry, guild) => {
    const dayKey = todayKey(entry.lang, now);
    if (entry.lastDailyDecay === dayKey) return;

    // WICHTIG (Fix „Level von 40 auf 1 nach 2 Tagen Offline“):
    // Der Tages-Stempel wird VOR der Abrechnung gesetzt und sofort persistiert.
    // Früher wurde erst der XP-Schwund angewendet (und die Nutzer geflusht)
    // und danach der Stempel gespeichert. Ein Absturz, SIGTERM oder ein
    // 45s-Timeout mitten im Decay hinterließ dann „Nutzer bereits bestraft,
    // aber Tag noch nicht abgehakt“ – beim nächsten Start/Retry lief die
    // Abrechnung erneut, mit jedem Lauf stieg der Inaktiv-Streak und der
    // Abzug wurde brutal (5 % → 8 % → … → 100 %). Das hat Level kaskadiert.
    const missedDays = missedDailyDecayDays(entry.lastDailyDecay, dayKey);
    entry.lastDailyDecay = dayKey;
    ctx.store.setGuild(entry);
    await ctx.store.flush().catch((err) =>
      ctx.logger.warn(
        `[xp-level-bot] Decay-Marker-Flush fehlgeschlagen (${guild.name}):`,
        err?.message || err
      )
    );

    // Nach Offline-Zeit höchstens die ersten beiden fehlenden Nächte nachholen
    // (Tag 1 = 5 %, Tag 2 = 8 %). Ohne bekannten Marker (Altbestand) wird
    // genau EINE Abrechnung angewendet wie bisher.
    const catchUpDays = missedDays > 0
      ? Math.min(missedDays, MAX_DECAY_CATCHUP_DAYS)
      : 1;

    await applyDailyDecayForGuild(ctx, entry, guild, { catchUpDays });
  });

  if (counter % 5 === 0) void ctx.store.flush().catch(() => {});
}

async function runGiveawayTick(ctx, now = new Date()) {
  if (!ctx.giveawayManager) return;
  await ctx.giveawayManager.tick(now);
}

async function runBonusTick(ctx, now = new Date()) {
  if (!ctx.bonusDropper) return;
  await forEachConfiguredGuild(ctx, 'Bonus-Scheduler', async (entry, guild) => {
    try {
      await ctx.bonusDropper.checkScheduled(entry, guild, now);
    } catch (err) {
      ctx.logger.warn(`[xp-level-bot] Bonus-Scheduler Fehler Gilde ${entry.guildId}:`, err?.message || err);
    }
  });
}

async function runLeaderboardTick(ctx, now = new Date(), { force = false } = {}) {
  const nowMs = now.getTime();
  await forEachConfiguredGuild(ctx, 'Leaderboard-Scheduler', async (entry, guild) => {
    syncMapsFromEntry(entry);
    const lastHourly = lastHourlyRefresh.get(entry.guildId) || asTimestamp(entry.lastHourlyLeaderboardRefresh);
    const lastAttempt = lastLeaderboardAttempt.get(entry.guildId) || 0;
    const hourlyDue = nowMs - lastHourly >= LEADERBOARD_HOURLY_MS;
    const attemptReady = nowMs - lastAttempt >= LEADERBOARD_HOURLY_RETRY_MS;

    if (!force && (!hourlyDue || !attemptReady)) return;
    lastLeaderboardAttempt.set(entry.guildId, nowMs);
    await refreshLeaderboard(ctx, entry, guild, now, { isHourly: true });
  });
}

/**
 * Rückwärtskompatibler kombinierter Tick (und nützlich für Integrationstests).
 * Im echten Scheduler werden die drei Funktionen getrennt gestartet.
 */
async function tick(ctx, counter = 1, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  await Promise.all([
    runMaintenanceTick(ctx, counter, now),
    runBonusTick(ctx, now),
    runGiveawayTick(ctx, now),
    runLeaderboardTick(ctx, now, { force: opts.forceHourly === true || counter === 0 }),
  ]);
}

function startScheduler({ ctx }) {
  try {
    for (const entry of ctx.store.getAllGuilds()) syncMapsFromEntry(entry);
  } catch {}

  let counter = 0;
  let stopped = false;
  const running = new Set();
  const timers = new Set();

  const launch = (name, fn) => {
    if (stopped || running.has(name)) return;
    running.add(name);
    void Promise.resolve()
      .then(fn)
      .catch((err) => ctx.logger.warn(`[xp-level-bot] Scheduler-Task ${name} fehlgeschlagen:`, err?.message || err))
      .finally(() => running.delete(name));
  };

  const heartbeat = (startup = false) => {
    if (stopped) return;
    counter += 1;
    const now = new Date();
    // Getrennte Locks: Ein hängender Task blockiert die beiden anderen nicht.
    launch('maintenance', () => runMaintenanceTick(ctx, counter, now));
    launch('bonus', () => runBonusTick(ctx, now));
    launch('giveaway', () => runGiveawayTick(ctx, now));
    launch('leaderboard', () => runLeaderboardTick(ctx, now, { force: startup }));
  };

  // Bonus-Drops dürfen den Event-Loop nicht verlieren: das Intervall bleibt
  // referenziert. Zusätzlich sofort ein erster Bonus-Tick, damit nach Deploy
  // nicht erst eine volle Minute (plus 5s Leaderboard-Start) verstreicht.
  const startupTimer = setTimeout(() => heartbeat(true), 5_000);
  startupTimer.unref?.();
  timers.add(startupTimer);

  const bonusKickoff = setTimeout(() => {
    if (stopped) return;
    launch('bonus', () => runBonusTick(ctx, new Date()));
  }, 1_500);
  timers.add(bonusKickoff);

  const interval = setInterval(() => heartbeat(false), MINUTE_MS);
  timers.add(interval);

  return () => {
    stopped = true;
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    timers.clear();
    // Offene Nachhol-Repins (kombinierter Kanal) dürfen nach dem Shutdown
    // nicht mehr feuern.
    resetRepinState();
  };
}

/**
 * Zusätzlicher Leaderboard-Edit nach Level-Up/-Down, max. alle 10 Minuten.
 * Dieser Pfad verändert ausschließlich den allgemeinen Throttle, niemals den
 * unabhängigen Stunden-Zeitstempel.
 */
async function maybeRefreshLeaderboard(ctx, entry, guild) {
  syncMapsFromEntry(entry);
  if (!isLeaderboardRefreshDue(entry.guildId)) return false;
  return refreshLeaderboard(ctx, entry, guild, new Date(), { isHourly: false });
}

/** Kombinierter Modus: Level-Chat und Leaderboard sind derselbe Kanal. */
function isCombinedLeaderboardChannel(entry) {
  if (!entry?.leaderboardChannelId || !entry?.mainChannelId) return false;
  return String(entry.mainChannelId) === String(entry.leaderboardChannelId);
}

/**
 * EINZIGER Einstieg für alle XP-/Level-Ereignisse (Chat, Voice, Bonus, Invite,
 * /give_xp). Entscheidet, ob das Board still editiert oder – nur im
 * kombinierten Modus – neu ans Kanalende gesendet wird.
 *
 * Regeln (Fix „Leaderboard wird ständig neu gesendet + pingt alle“):
 *  - Reine XP-Gewinne ohne Levelwechsel sind IMMER ein stiller In-Place-Edit,
 *    max. alle 10 Minuten – auch im kombinierten Modus. Früher lösten sie dort
 *    alle 5 Sekunden ein Neu-Senden aus (jede Chat-Nachricht aus JEDEM Kanal,
 *    jede Voice-Minute), und jedes Neu-Senden pingte die komplette Top 15.
 *  - Neu gesendet („repin“) wird ausschließlich, wenn der Bot soeben selbst
 *    eine Nachricht in den Leaderboard-Kanal geschrieben hat
 *    (`announcedInBoardChannel`, z. B. Level-Up/-Down-Ankündigung) – denn nur
 *    dann liegt das Board nicht mehr am Kanalende. Auch das höchstens alle
 *    10 Minuten; weitere Auslöser innerhalb des Fensters werden zu genau
 *    EINEM nachgeholten Repin am Fensterende zusammengefasst.
 *  - Im getrennten Modus gibt es weiterhin nur den 10-Minuten-Edit.
 */
async function refreshLeaderboardAfterActivity(ctx, entry, guild, { announcedInBoardChannel = false } = {}) {
  if (!entry?.leaderboardChannelId || !guild) return false;
  if (announcedInBoardChannel && isCombinedLeaderboardChannel(entry)) {
    return repinLeaderboard(ctx, entry, guild, { reason: 'announcement' });
  }
  return maybeRefreshLeaderboard(ctx, entry, guild);
}

/**
 * Ist `channelId` der Leaderboard-Kanal dieser Gilde? Hilft Aufrufern, aus dem
 * Ziel einer Ankündigung `announcedInBoardChannel` abzuleiten.
 */
function isLeaderboardChannel(entry, channelId) {
  if (!entry?.leaderboardChannelId || !channelId) return false;
  return String(channelId) === String(entry.leaderboardChannelId);
}

async function applyDailyDecayForGuild(ctx, entry, guild, opts = {}) {
  const lang = entry.lang || 'de';
  const users = ctx.store.getUsersForGuild(entry.guildId);
  if (!users.length) return;

  const { applyDailyDecay, nextDecayInfo, MAX_DECAY_CATCHUP_DAYS } = require('./logic');
  // 1 = normale 0-Uhr-Abrechnung; nach Offline-Zeit max. die ersten
  // MAX_DECAY_CATCHUP_DAYS Nächte (5 % → 8 %), niemals mehr.
  const catchUpDays = Math.max(
    1,
    Math.min(Math.floor(Number(opts.catchUpDays) || 1), MAX_DECAY_CATCHUP_DAYS)
  );
  let decayed = 0;
  const leveledDownUsers = [];
  for (const user of users) {
    // Korrupte Datensätze (NaN/undefined aus einer alten DB) dürfen niemals
    // eine Decay-Kaskade auslösen – sie werden unverändert übersprungen.
    const levelNum = Number(user.level);
    const xpNum = Number(user.xp);
    if (!Number.isFinite(levelNum) || !Number.isFinite(xpNum)) {
      ctx.logger.warn(
        `[xp-level-bot] Decay übersprungen: Nutzer ${user.userId} hat ungültige Level/XP-Werte (${user.level}/${user.xp})`
      );
      continue;
    }

    const before = { level: user.level, xp: user.xp };
    // applyDailyDecay mutiert den Nutzer NICHT selbst – jeder Nachhol-Tag muss
    // daher sofort zurückgeschrieben werden, sonst rechnet Tag 2 wieder vom
    // alten XP-Stand aus („nur 8 % statt 5 % + 8 %“).
    let res = null;
    for (let day = 0; day < catchUpDays; day++) {
      const info = nextDecayInfo(user, Date.now());
      user.inactiveDays = info.inactiveDays;
      res = applyDailyDecay(user, info.rate);
      user.level = res.level;
      user.xp = res.xp;
    }
    if (res && (res.level !== before.level || res.xp !== before.xp)) {
      decayed += 1;
      if (res.leveledDown) leveledDownUsers.push({ userId: user.userId, level: res.level, xp: res.xp });
    }
    ctx.store.setUser(user);
  }

  ctx.logger.info(
    `[xp-level-bot] Daily decay ${guild.name}: ${decayed} Nutzer angepasst, ` +
      `${leveledDownUsers.length} Level-Downs (Nachhol-Tage: ${catchUpDays})`
  );
  // Persistenz sofort parallel starten, aber auch Level-Down-Ankündigungen
  // niemals auf Turso warten lassen.
  const decayFlush = ctx.store
    .flush()
    .catch((err) => ctx.logger.warn('[xp-level-bot] Decay-Flush fehlgeschlagen:', err?.message || err));

  // Erst zuverlässig ankündigen, danach Nickname und Rollen nachziehen.
  for (const down of leveledDownUsers) {
    await sendLevelAnnouncement({
      ctx,
      guild,
      cfg: entry,
      userId: down.userId,
      res: { ...down, leveledUp: false, leveledDown: true, leveled: true },
      source: 'decay',
    });
    await Promise.allSettled([
      refreshRankNicknames(ctx, guild, down.userId, lang),
      syncLevelRolesForUser({ ctx, guild, userId: down.userId, level: down.level }),
    ]);
  }
  await decayFlush;

  if (entry.inactiveRoleId) {
    try {
      const { applyInactiveRolesAfterDecay } = require('./inactive-role');
      await applyInactiveRolesAfterDecay(ctx, guild, entry);
    } catch (err) {
      ctx.logger.warn(
        `[xp-level-bot] Inaktiv-Rolle nach Decay fehlgeschlagen (${guild.name}):`,
        err?.message || err
      );
    }
  }

  // Nach dem Decay ist das Board ohnehin frisch; das zählt legitim als
  // Stunden-Refresh und verhindert einen zweiten gleichzeitigen Mitternachts-Edit.
  await refreshLeaderboard(ctx, entry, guild, new Date(), { isHourly: true });
}

async function fetchLeaderboardChannel(ctx, entry, guild) {
  let channel = guild.channels?.cache?.get?.(entry.leaderboardChannelId) || null;
  if (!channel) {
    try {
      channel = await ctx.client.channels.fetch(entry.leaderboardChannelId);
    } catch {}
  }
  if (!channel) {
    try {
      channel = await guild.channels.fetch(entry.leaderboardChannelId);
    } catch {}
  }
  if (channel?.isTextBased?.()) return channel;

  // Self-Healing über den unsichtbaren Marker der bestehenden Nachricht.
  try {
    const found = await ctx.store.findLeaderboardMessage(guild, ctx.client);
    if (found?.channel?.isTextBased?.()) {
      entry.leaderboardChannelId = found.channel.id;
      entry.leaderboardMessageId = found.message.id;
      ctx.logger.info(
        `[xp-level-bot] Leaderboard-Kanal via Marker gefunden (${guild.name} → ${found.channel.id})`
      );
      return found.channel;
    }
  } catch {}
  return null;
}

async function refreshLeaderboard(ctx, entry, guild, now = new Date(), opts = {}) {
  // Ohne opts bleibt das historische Verhalten "hourly" erhalten. Alle internen
  // Level-Up-Aufrufe übergeben dagegen explizit isHourly:false.
  const treatAsHourly = opts.isHourly === true || Object.keys(opts).length === 0;
  try {
    const channel = await fetchLeaderboardChannel(ctx, entry, guild);
    if (!channel) {
      ctx.logger.warn(
        `[xp-level-bot] Leaderboard-Kanal ${entry.leaderboardChannelId} nicht erreichbar (${guild.name})`
      );
      return false;
    }

    const entries = ctx.store.getLeaderboard(entry.guildId, 15);
    const container = buildLeaderboardEmbed({ lang: entry.lang, entries, now, guildName: guild.name });
    const payload = componentsV2Payload([container], { allowedMentions: LEADERBOARD_ALLOWED_MENTIONS });

    let message = null;
    if (entry.leaderboardMessageId) {
      message = await channel.messages.fetch(entry.leaderboardMessageId).catch(() => null);
    }
    if (!message) {
      const found = await ctx.store.findLeaderboardMessage(guild, ctx.client).catch(() => null);
      if (found) {
        message = found.message;
        entry.leaderboardChannelId = found.channel.id;
        entry.leaderboardMessageId = found.message.id;
      }
    }

    let success = false;
    let staleMessage = null;
    if (message) {
      try {
        await message.edit(payload);
        success = true;
      } catch (err) {
        // Alte Nachricht erst löschen, NACHDEM die Ersatznachricht erfolgreich
        // gesendet wurde. So bleibt bei einem zweiten API-Fehler wenigstens das
        // bestehende Board sichtbar.
        staleMessage = message;
        message = null;
        ctx.logger.warn(
          `[xp-level-bot] Leaderboard-Edit fehlgeschlagen (${guild.name}): ${err.message} – sende Ersatz.`
        );
      }
    }

    if (!message) {
      const replacement = await channel.send(payload).catch((err) => {
        ctx.logger.warn(`[xp-level-bot] Leaderboard-Send fehlgeschlagen (${guild.name}): ${err.message}`);
        return null;
      });
      if (!replacement) return false;
      entry.leaderboardMessageId = replacement.id;
      success = true;
      if (staleMessage) await staleMessage.delete().catch(() => {});
    }

    if (!success) return false;

    const ts = Date.now();
    noteLeaderboardRefresh(entry.guildId, ts);
    entry.lastLeaderboardRefresh = ts;
    entry.lastLeaderboardUpdate = ts; // Kompatibilität mit alten File-Fallbacks
    if (treatAsHourly) {
      noteHourlyRefresh(entry.guildId, ts);
      entry.lastHourlyLeaderboardRefresh = ts;
    }
    ctx.store.setGuild(entry);
    void ctx.store.flush().catch(() => {});
    ctx.logger.info(
      `[xp-level-bot] Leaderboard aktualisiert (${guild.name})${treatAsHourly ? ' [stündlich]' : ' [level]'}`
    );
    return true;
  } catch (err) {
    ctx.logger.warn(`[xp-level-bot] Leaderboard refresh failed ${guild.name}:`, err?.message || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Repin: Leaderboard als NEUE Nachricht senden (nicht editieren) und die alte
// entfernen. Nur im kombinierten Modus (Level-Chat == Leaderboard-Kanal) und
// NUR, nachdem der Bot selbst eine Ankündigung (Level-Up/-Down, Bonus, Invite,
// /give_xp) in diesen Kanal geschrieben hat – erst dann liegt das Board nicht
// mehr am Kanalende.
//
// Gemeldeter Bug („alle 10 Sekunden Leaderboard-Pings“, „200 Erwähnungen nach
// einer Stunde offline“): Früher wurde bei JEDER fremden Nachricht im Kanal,
// bei jedem XP-Gewinn aus JEDEM Kanal und bei jeder Voice-Minute mit nur 5 s
// Throttle neu gesendet – und jedes Neu-Senden pingte alle 15 Nutzer aus der
// Top-Liste, weil die Mentions ohne allowedMentions benachrichtigten.
//
// Jetzt:
//  - fester 10-Minuten-Abstand zwischen zwei Neu-Sendungen pro Server,
//  - Auslöser innerhalb des Fensters werden zu genau EINEM nachgeholten Repin
//    am Fensterende zusammengefasst (kein Verlust, kein Spam),
//  - Neu-Senden entfällt, wenn das Board ohnehin schon die neueste Nachricht
//    ist (dann reicht ein stiller Edit),
//  - `allowedMentions: { parse: [] }` – niemals Benachrichtigungen.
//
// Pro Server genau EIN laufender Repin. Der Zeitstempel wird SOFORT (synchron,
// vor dem ersten await) gesetzt, damit der Abstand auch unter Last greift.
// ---------------------------------------------------------------------------
const repinInFlight = new Map(); // guildId -> true, solange ein Repin läuft
const lastRepin = new Map(); // guildId -> Start-Zeitstempel des letzten Repins
const pendingRepin = new Map(); // guildId -> Timer für den zusammengefassten Nachhol-Repin
const REPIN_MIN_INTERVAL_MS = LEADERBOARD_MIN_REFRESH_MS; // 10 Minuten

function clearPendingRepin(guildKey) {
  const timer = pendingRepin.get(guildKey);
  if (timer) clearTimeout(timer);
  pendingRepin.delete(guildKey);
}

/**
 * Innerhalb des 10-Minuten-Fensters: genau EINEN Nachhol-Repin am Fensterende
 * planen. Mehrere Auslöser (Level-Up-Serie, Bonus + Level-Up …) teilen sich
 * denselben Timer.
 */
function schedulePendingRepin(ctx, entry, guild, guildKey, delayMs) {
  if (pendingRepin.has(guildKey)) return;
  const timer = setTimeout(() => {
    pendingRepin.delete(guildKey);
    void repinLeaderboard(ctx, entry, guild, { reason: 'deferred' }).catch(() => {});
  }, Math.max(0, delayMs));
  timer.unref?.();
  pendingRepin.set(guildKey, timer);
}

/**
 * Liegt das aktuelle Board bereits ganz unten im Kanal? Dann wäre ein
 * Neu-Senden reine Unruhe (Löschen + neue Nachricht) – ein Edit reicht.
 * Bei unbekanntem Zustand (kein Cache) lieber `false` und normal neu senden.
 */
function boardIsAlreadyNewest(channel, entry) {
  const lastId = channel?.lastMessageId;
  if (!lastId || !entry?.leaderboardMessageId) return false;
  return String(lastId) === String(entry.leaderboardMessageId);
}

async function repinLeaderboard(ctx, entry, guild, { throttle = true, reason = 'manual' } = {}) {
  const guildKey = String(entry.guildId || guild?.id || '');
  const startedAt = Date.now();

  // Nebenläufigkeits-Schutz: läuft bereits ein Repin für diesen Server, ist
  // dieser Aufruf überflüssig – der laufende Send rendert ohnehin den
  // aktuellen Stand und landet danach als neueste Nachricht im Kanal.
  if (repinInFlight.get(guildKey)) return false;

  const previousRepinAt = lastRepin.get(guildKey) || 0;
  if (throttle) {
    const elapsed = startedAt - previousRepinAt;
    if (elapsed < REPIN_MIN_INTERVAL_MS) {
      // Nicht verwerfen, sondern zusammenfassen: Am Ende des Fensters wandert
      // das Board genau EINMAL nach unten – egal wie viele Auslöser kamen.
      schedulePendingRepin(ctx, entry, guild, guildKey, REPIN_MIN_INTERVAL_MS - elapsed);
      return false;
    }
  }

  // Stempel + Lock VOR dem ersten await setzen. Nur so greift der Abstand
  // auch unter Last (mehrere Auslöser innerhalb eines Event-Loop-Fensters).
  // Das Lock wird im finally freigegeben, damit ein Fehler den Server nicht
  // dauerhaft sperrt; der Zeitstempel bleibt bewusst auch bei Fehlern stehen
  // (schützt vor Send-Schleifen bei anhaltenden Discord-Problemen).
  repinInFlight.set(guildKey, true);
  lastRepin.set(guildKey, startedAt);
  clearPendingRepin(guildKey);
  try {
    const channel = await fetchLeaderboardChannel(ctx, entry, guild);
    if (!channel) {
      ctx.logger.warn(
        `[xp-level-bot] Leaderboard-Kanal ${entry.leaderboardChannelId} nicht erreichbar (${guild.name})`
      );
      return false;
    }

    // Board ist bereits die letzte Nachricht im Kanal → ein Neu-Senden wäre
    // reine Unruhe. Stattdessen stiller (10-Min-gedrosselter) Edit. Der
    // Repin-Zeitstempel wird zurückgesetzt, damit die nächste ECHTE
    // Ankündigung das Board sofort wieder nach unten holen darf.
    if (boardIsAlreadyNewest(channel, entry)) {
      lastRepin.set(guildKey, previousRepinAt);
      return maybeRefreshLeaderboard(ctx, entry, guild);
    }

    const entries = ctx.store.getLeaderboard(entry.guildId, 15);
    const container = buildLeaderboardEmbed({ lang: entry.lang, entries, now: new Date(), guildName: guild.name });
    const payload = componentsV2Payload([container], { allowedMentions: LEADERBOARD_ALLOWED_MENTIONS });

    const oldId = entry.leaderboardMessageId;
    const replacement = await channel.send(payload).catch((err) => {
      ctx.logger.warn(`[xp-level-bot] Leaderboard-Neuankündigung fehlgeschlagen (${guild.name}): ${err.message}`);
      return null;
    });
    if (!replacement) return false;

    entry.leaderboardMessageId = replacement.id;
    entry.leaderboardChannelId = channel.id;

    // Alte Leaderboard-Nachricht entfernen, damit nur die NEUESTE (die soeben
    // gesendete) im Kanal steht. Die Level-Veränderungs-Nachricht darüber
    // bleibt unangetastet.
    if (oldId && oldId !== replacement.id) {
      try {
        const old = await channel.messages.fetch(oldId).catch(() => null);
        if (old) await old.delete().catch(() => {});
      } catch {}
    }

    const now = Date.now();
    noteLeaderboardRefresh(entry.guildId, now);
    entry.lastLeaderboardRefresh = now;
    entry.lastLeaderboardUpdate = now;
    noteHourlyRefresh(entry.guildId, now);
    entry.lastHourlyLeaderboardRefresh = now;
    ctx.store.setGuild(entry);
    void ctx.store.flush().catch(() => {});
    ctx.logger.info(`[xp-level-bot] Leaderboard neu angesteckt (${guild.name}, Grund: ${reason})`);
    return true;
  } catch (err) {
    ctx.logger.warn(`[xp-level-bot] Leaderboard repin failed ${guild.name}:`, err?.message || err);
    return false;
  } finally {
    repinInFlight.delete(guildKey);
  }
}

/** Nur für Tests / Shutdown: offene Nachhol-Timer verwerfen. */
function resetRepinState(guildId = null) {
  if (guildId != null) {
    const key = String(guildId);
    clearPendingRepin(key);
    lastRepin.delete(key);
    repinInFlight.delete(key);
    return;
  }
  for (const key of [...pendingRepin.keys()]) clearPendingRepin(key);
  lastRepin.clear();
  repinInFlight.clear();
}

module.exports = {
  startScheduler,
  tick,
  runMaintenanceTick,
  runBonusTick,
  runGiveawayTick,
  runLeaderboardTick,
  refreshLeaderboard,
  maybeRefreshLeaderboard,
  refreshLeaderboardAfterActivity,
  isCombinedLeaderboardChannel,
  isLeaderboardChannel,
  repinLeaderboard,
  resetRepinState,
  isLeaderboardRefreshDue,
  isHourlyRefreshDue,
  noteLeaderboardRefresh,
  noteHourlyRefresh,
  syncMapsFromEntry,
  applyDailyDecayForGuild,
  isManualRefreshDue,
  noteManualRefresh,
  MANUAL_REFRESH_COOLDOWN_MS,
  LEADERBOARD_MIN_REFRESH_MS,
  LEADERBOARD_ALLOWED_MENTIONS,
  REPIN_MIN_INTERVAL_MS,
  LEADERBOARD_HOURLY_MS,
  LEADERBOARD_HOURLY_RETRY_MS,
  MAX_DECAY_CATCHUP_DAYS,
  _lastLeaderboardRefresh: lastLeaderboardRefresh,
  _lastHourlyRefresh: lastHourlyRefresh,
  _lastLeaderboardAttempt: lastLeaderboardAttempt,
  _lastManualRefresh: lastManualRefresh,
};
