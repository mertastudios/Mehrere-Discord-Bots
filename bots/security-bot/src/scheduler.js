/**
 * Scheduler für den Sicherheitsbot.
 *
 * - Alle 30 Sekunden: Prüft pro Gilde, ob fällige Retry-Batches vorhanden sind
 *   (Backoff der fehlgeschlagenen Gemini-Analysen) und stößt sie an.
 * - Adaptiver Flush: Kleine Verläufe werden nach kurzer Ruhephase/Maximalalter
 *   analysiert, und Risikosignale (z. B. Beleidigung, RIP-/Todessprache,
 *   wiederholte Mentions/Dogpiling) starten deutlich schneller eine Prüfung.
 * - 2-Stunden-Sicherheitsnetz (Zeitzone der Serversprache, volle Slots 0, 2, 4,
 *   … 22 Uhr): Falls weder Token-Limit noch adaptive Policy anschlagen, wird der
 *   offene Buffer trotzdem regelmäßig analysiert. Der 0-Uhr-Lauf ist weiterhin
 *   enthalten.
 * - Neustart-Sicherheit: Wurde ein Slot verpasst (Render-Restart, Deploy), löst
 *   ein alter Buffer den Flush direkt beim nächsten Tick aus – ohne auf den
 *   nächsten Slot zu warten.
 * - Stündlich: Alte Strafen/Batches aufräumen + Store flushen.
 */

const { tzFor } = require('./languages');
const { flushBuffer, processGuild } = require('./moderator');
const { estimateTokens } = require('./gemini');
const { shouldFlushBuffer } = require('./batch-policy');
const { buildDropContainer } = require('./embed-builder');
const { sendLogNotice } = require('./notices');

const TICK_MS = 30_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// Sicherheitsnetz: regelmäßige Auswertung des offenen Buffers alle 2 Stunden.
const FLUSH_INTERVAL_HOURS = 2;
const FLUSH_INTERVAL_MS = FLUSH_INTERVAL_HOURS * 60 * 60 * 1000;

function dayKeyInTz(date, tz) {
  try {
    // en-CA liefert zuverlässig YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);
  } catch {
    return new Date(date).toISOString().slice(0, 10);
  }
}

/** Stunde (0-23) in der angegebenen Zeitzone. */
function hourInTz(date, tz) {
  try {
    const raw = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false,
    }).format(date);
    // "24" kommt bei manchen ICU-Versionen für Mitternacht zurück
    return Number.parseInt(raw, 10) % 24;
  } catch {
    return new Date(date).getUTCHours();
  }
}

/**
 * Eindeutiger Schlüssel des aktuellen 2-Stunden-Slots in der Gilden-Zeitzone,
 * z. B. "2026-09-11#7" für 14:00–15:59 Uhr. Wechselt der Schlüssel zwischen
 * zwei Ticks, ist ein neuer Slot angebrochen -> Buffer auswerten.
 * Der Slot 0 beginnt exakt um 0 Uhr, der bisherige Mitternachts-Flush bleibt
 * damit vollständig erhalten.
 */
function slotKeyInTz(date, tz, intervalHours = FLUSH_INTERVAL_HOURS) {
  const hours = Math.max(1, Number(intervalHours) || FLUSH_INTERVAL_HOURS);
  return `${dayKeyInTz(date, tz)}#${Math.floor(hourInTz(date, tz) / hours)}`;
}

/** Zeitstempel der ältesten Nachricht im offenen Buffer (oder null). */
function oldestBufferedAt(ctx, guildId) {
  const buffer = ctx.store.getBuffer?.(guildId) || [];
  let oldest = null;
  for (const rec of buffer) {
    const at = Number(rec?.sentAt);
    if (!Number.isFinite(at)) continue;
    if (oldest == null || at < oldest) oldest = at;
  }
  return oldest;
}

/**
 * Ein Scheduler-Tick (für Tests einzeln aufrufbar).
 * schedulerState liegt im ctx, damit Neustarts/Tests kontrollierbar bleiben.
 */
function tickOnce(ctx, now = Date.now()) {
  const state =
    ctx.schedulerState ||
    (ctx.schedulerState = { lastSlotByGuild: new Map(), lastPrune: now });
  if (!state.lastSlotByGuild) state.lastSlotByGuild = new Map();
  let flushedGuilds = 0;

  for (const cfg of ctx.store.getAllGuilds()) {
    const gid = cfg.guildId;

    // 1) Adaptiver Flush + 2-Stunden-Sicherheitsnetz (Gilden-Zeitzone)
    const tz = tzFor(cfg.lang || 'de');
    const slot = slotKeyInTz(now, tz);
    const lastSlot = state.lastSlotByGuild.get(gid);

    // Neustart-Sicherheit: Nach einem Deploy kennt der Scheduler den letzten
    // Slot nicht mehr. Liegt im Buffer bereits eine Nachricht, die älter als
    // das Intervall ist, wurde offensichtlich ein Slot verpasst -> sofort
    // auswerten, statt bis zu 2 Stunden zu verschenken.
    const oldest = oldestBufferedAt(ctx, gid);
    const overdue = oldest != null && now - oldest >= FLUSH_INTERVAL_MS;

    const buffer = ctx.store.getBuffer?.(gid) || [];
    const fastPolicy = shouldFlushBuffer({
      buffer,
      env: ctx.env,
      estimateTokensFn: estimateTokens,
      now,
    });

    if ((lastSlot && lastSlot !== slot) || overdue || fastPolicy.flush) {
      const batch = flushBuffer(ctx, gid);
      if (batch) {
        flushedGuilds++;
        const reason = fastPolicy.flush
          ? `schneller Flush (${fastPolicy.reason})`
          : `${FLUSH_INTERVAL_HOURS}h-Flush`;
        ctx.logger?.info?.(
          `[security-bot] ${reason} für Gilde ${gid} (${tz}, Slot ${slot}` +
            `${overdue && lastSlot === slot ? ', überfälliger Buffer nach Neustart' : ''}): ` +
            `Batch ${batch.id} mit ${batch.size} Nachrichten gestartet.`
        );
      }
    }
    state.lastSlotByGuild.set(gid, slot);

    // 2) Fällige Retries anstoßen (processGuild selbst entscheidt über Ein-Flug & Fälligkeit)
    if (ctx.store.getBatches(gid).length > 0) {
      void processGuild(ctx, gid);
    }
  }

  // 3) Stündlich aufräumen
  if (now - (state.lastPrune || 0) >= PRUNE_INTERVAL_MS) {
    state.lastPrune = now;
    try {
      const { prunedPenalties, dropped } = ctx.store.prune(now);
      if (prunedPenalties > 0 || dropped.length > 0) {
        ctx.logger?.info?.(
          `[security-bot] Aufräumen: ${prunedPenalties} alte Strafen entfernt, ${dropped.length} veraltete Batches verworfen.`
        );
        // Verworfene Verläufe im Log-Kanal transparent machen (Fire-and-forget)
        for (const drop of dropped) {
          const lang = ctx.store.getLanguage(drop.guildId) || 'de';
          void sendLogNotice(
            ctx,
            drop.guildId,
            buildDropContainer({ lang, count: drop.count })
          );
        }
        void ctx.store.flush();
      }
    } catch (e) {
      ctx.logger?.warn?.('[security-bot] Aufräum-Fehler:', e?.message || e);
    }
  }

  return flushedGuilds;
}

function startScheduler({ ctx }) {
  const timer = setInterval(() => {
    try {
      tickOnce(ctx);
    } catch (e) {
      ctx.logger?.warn?.('[security-bot] Scheduler-Fehler:', e?.message || e);
    }
  }, TICK_MS);
  if (timer.unref) timer.unref();

  return () => {
    clearInterval(timer);
  };
}

module.exports = {
  startScheduler,
  tickOnce,
  dayKeyInTz,
  hourInTz,
  slotKeyInTz,
  oldestBufferedAt,
  TICK_MS,
  FLUSH_INTERVAL_HOURS,
  FLUSH_INTERVAL_MS,
};
