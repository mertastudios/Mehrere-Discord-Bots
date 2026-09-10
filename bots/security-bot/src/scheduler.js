/**
 * Scheduler für den Sicherheitsbot.
 *
 * - Alle 30 Sekunden: Prüft pro Gilde, ob fällige Retry-Batches vorhanden sind
 *   (Backoff der fehlgeschlagenen Gemini-Analysen) und stößt sie an.
 * - Täglicher 0-Uhr-Flush in der Zeitzonen der Serversprache: Auch wenn das
 *   Token-Limit lange nicht erreicht wird (toter Server, wenige Nutzer),
 *   bekommt jeder Verlauf spätestens um Mitternacht seine Analyse – damit
 *   Nutzer ihre Verwarnungen nicht erst Tage später erhalten.
 * - Stündlich: Alte Strafen/Batches aufräumen + Store flushen.
 */

const { tzFor } = require('./languages');
const { flushBuffer, processGuild } = require('./moderator');
const { buildDropContainer } = require('./embed-builder');
const { sendLogNotice } = require('./notices');

const TICK_MS = 30_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

function dayKeyInTz(date, tz) {
  try {
    // en-CA liefert zuverlässig YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);
  } catch {
    return new Date(date).toISOString().slice(0, 10);
  }
}

/**
 * Ein Scheduler-Tick (für Tests einzeln aufrufbar).
 * schedulerState liegt im ctx, damit Neustarts/Tests kontrollierbar bleiben.
 */
function tickOnce(ctx, now = Date.now()) {
  const state = ctx.schedulerState || (ctx.schedulerState = { lastDayByGuild: new Map(), lastPrune: now });
  let flushedGuilds = 0;

  for (const cfg of ctx.store.getAllGuilds()) {
    const gid = cfg.guildId;

    // 1) Mitternachts-Flush: Hat sich das Datum (in der Gilden-Zeitzone) geändert?
    const tz = tzFor(cfg.lang || 'de');
    const today = dayKeyInTz(now, tz);
    const lastDay = state.lastDayByGuild.get(gid);
    if (lastDay && lastDay !== today) {
      const batch = flushBuffer(ctx, gid);
      if (batch) {
        flushedGuilds++;
        ctx.logger?.info?.(
          `[security-bot] 0-Uhr-Flush für Gilde ${gid} (${tz}): Batch ${batch.id} mit ${batch.size} Nachrichten gestartet.`
        );
      }
    }
    state.lastDayByGuild.set(gid, today);

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

module.exports = { startScheduler, tickOnce, dayKeyInTz, TICK_MS };
