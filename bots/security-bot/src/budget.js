/**
 * ============================================================================
 *  Groq-Budget – Free-Plan-Schonung mit maximaler Ausnutzung
 *
 *  Free-Plan pro Account (Stand 2026): 30 Anfragen/Minute, 1.000 Anfragen/Tag,
 *  7.000 Token/Minute, 180.000 Token/Tag. WICHTIG: Limits sind ACCOUNTWEIT
 *  und werden NICHT pro Modell getrennt gezählt!
 *
 *  Dieser Baustein:
 *    - zählt Anfragen + Token rollend (Minute/Tag) mit ECHTER Sliding-Window
 *      Prüfung, die Events korrekt außerhalb des 60s-Fensters schneidet
 *    - hat einen GLOBALEN Zähler für alle Modelle zusammen, weil Groq das so macht
 *    - hält eine Reserve frei (Standard 20 %), damit nie „auf Kante“ gefahren wird;
 *    - rechnet aus, wie viele Urteile am Tag möglich sind, und leitet daraus
 *      den Mindestabstand für RUHE-Prüfungen ab (damit das Limit „gerade so“
 *      für durchgängige Moderation reicht);
 *    - lässt Risiko-Fälle bevorzugt durch (Priorität), ohne die harten Grenzen
 *      zu sprengen;
 *    - meldet bei einem Limit, wann es sich erneuert (für den Log-Kanal).
 * ============================================================================
 */

const DEFAULTS = {
  rpm: 30,
  rpd: 950,
  tpm: 6000, // Groq Free Plan aktuell ca 6k TPM mit Reasoning Modellen, mit Reserve
  tpd: 140000, // Neuer Free Plan hat oft nur 144k TPD für gpt-oss Modelle
  reserve: 0.15, // 15% Reserve
  avgSmartCallTokens: 2500,
  avgFastCallTokens: 800,
  minIntervalBetweenNonPriorityCallsMs: 6000, // Mindestens 6 Sekunden zwischen normalen Prüfungen → max 10 pro Minute
};

function intEnv(env, key, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = Number.parseInt(String(env?.(key, '') || ''), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function floatEnv(env, key, fallback, { min = 0, max = 1 } = {}) {
  const raw = Number.parseFloat(String(env?.(key, '') || ''));
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

/**
 * Ein einzelner Track (z.B. global, smart, fast) – alle zählen vom selben globalen Event-Pool.
 * Wir machen es einfacher: EIN Event-Pool für ALLE Aufrufe, da Groq Limits global sind.
 */
function createGlobalTracker({
  rpm = DEFAULTS.rpm,
  rpd = DEFAULTS.rpd,
  tpm = DEFAULTS.tpm,
  tpd = DEFAULTS.tpd,
  reserve = DEFAULTS.reserve,
  minIntervalMs = DEFAULTS.minIntervalBetweenNonPriorityCallsMs,
  now = () => Date.now(),
} = {}) {
  const usable = {
    rpm: Math.max(1, Math.floor(rpm * (1 - reserve))),
    rpd: Math.max(1, Math.floor(rpd * (1 - reserve))),
    tpm: Math.max(100, Math.floor(tpm * (1 - reserve))),
    tpd: Math.max(1000, Math.floor(tpd * (1 - reserve))),
  };
  const events = []; // { at, tokens, model }
  let lastNonPriorityCallAt = 0;

  /**
   * Schneidet alle Events weg, die älter als 24 Stunden sind, und zählt für das
   * Minutenfenster korrekt nur Events der letzten 60s.
   * WICHTIGER BUGFIX: Früher wurden Events nur beim Tages-Limit rausgeschnitten,
   * das Minutenfenster wurde nie korrekt aufgeräumt! Dadurch wuchs der Zähler
   * mit der Zeit immer weiter an und das Limit wurde viel zu früh erreicht.
   */
  function prune(t) {
    // Immer erst alles was älter als 24h ist komplett aus der Liste entfernen
    const dayAgo = t - 86_400_000;
    while (events.length && events[0].at < dayAgo) events.shift();
  }

  function windowStats(t) {
    prune(t);
    const minuteAgo = t - 60_000;
    let reqMinute = 0;
    let tokMinute = 0;
    let tokDay = 0;
    for (const e of events) {
      tokDay += e.tokens;
      if (e.at >= minuteAgo) {
        reqMinute += 1;
        tokMinute += e.tokens;
      }
    }
    return { reqMinute, tokMinute, reqDay: events.length, tokDay };
  }

  /** Darf jetzt eine Anfrage mit ~tokens laufen? */
  function canSpend(tokens, { priority = false, avgCallTokens = 2000 } = {}) {
    const t = now();
    const s = windowStats(t);
    const need = Math.max(1, Math.floor(tokens));

    // 1. Prüfe harte Tageslimits
    if (s.reqDay >= usable.rpd) {
      return { ok: false, reason: 'rpd', resetInMs: startOfNextDay(t) - t, stats: s, usable };
    }
    if (s.tokDay + need > usable.tpd) {
      return { ok: false, reason: 'tpd', resetInMs: startOfNextDay(t) - t, stats: s, usable };
    }

    // 2. Prüfe harte Minutenlimits (GLOBAL, für alle Modelle zusammen!)
    if (s.reqMinute >= usable.rpm) {
      return { ok: false, reason: 'rpm', resetInMs: windowCooldownForRequests(events, t), stats: s, usable };
    }
    if (s.tokMinute + need > usable.tpm) {
      return { ok: false, reason: 'tpm', resetInMs: windowCooldownForTokens(events, t, need), stats: s, usable };
    }

    // 3. Pacing für nicht-priorisierte Aufrufe: nicht zu schnell hintereinander,
    // damit wir nicht das Limit "rammen"
    if (!priority) {
      const elapsedSinceLast = t - lastNonPriorityCallAt;
      if (elapsedSinceLast < minIntervalMs) {
        return { ok: true, waitMs: minIntervalMs - elapsedSinceLast, reason: 'pacing', stats: s, usable };
      }
    }

    return { ok: true, waitMs: 0, reason: 'ok', stats: s, usable };
  }

  /** Wie lange bis wieder genug Platz für eine weitere Anfrage ist. */
  function windowCooldownForRequests(list, t) {
    if (!list.length) return 1000;
    // Das älteste Event im Fenster rauscht gleich raus – wann ist das?
    return Math.max(1000, list[0].at + 60_000 - t);
  }

  function windowCooldownForTokens(list, t, need) {
    if (!list.length) return 1000;
    // Summiere Token von hinten bis wir genug frei haben
    let sum = 0;
    let wait = 1000;
    for (let i = list.length - 1; i >= 0; i--) {
      sum += list[i].tokens;
      if (sum <= usable.tpm - need) break;
      wait = Math.max(wait, list[i].at + 60_000 - t);
    }
    return wait;
  }

  function startOfNextDay(t) {
    const d = new Date(t);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 5);
    return next;
  }

  /** Maximal mögliche Aufrufe pro Tag mit diesem Modell. */
  function maxCallsPerDay(avgCallTokens) {
    return Math.max(1, Math.min(usable.rpd, Math.floor(usable.tpd / Math.max(200, avgCallTokens))));
  }

  function spend(tokens, { priority = false, model = 'unknown' } = {}) {
    const t = now();
    events.push({ at: t, tokens: Math.max(1, Math.floor(tokens)), model });
    if (!priority) lastNonPriorityCallAt = t;
    // Events länger als ein Tag sofort wegschneiden
    prune(t);
    return windowStats(t);
  }

  function state(avgCallTokens) {
    const t = now();
    const s = windowStats(t);
    return {
      usable,
      used: s,
      remaining: {
        requestsToday: Math.max(0, usable.rpd - s.reqDay),
        tokensToday: Math.max(0, usable.tpd - s.tokDay),
        requestsMinute: Math.max(0, usable.rpm - s.reqMinute),
        tokensMinute: Math.max(0, usable.tpm - s.tokMinute),
      },
      maxCallsPerDay: maxCallsPerDay(avgCallTokens),
      resetInMs: startOfNextDay(t) - t,
      lastCallMsAgo: lastNonPriorityCallAt ? t - lastNonPriorityCallAt : Infinity,
    };
  }

  return { canSpend, spend, state, usable, maxCallsPerDay };
}

/** Budget-Set mit globalem Limit, das beide Modellspuren gemeinsam nutzen. */
function createBudgetSet(env, { now = () => Date.now() } = {}) {
  const shared = {
    rpm: intEnv(env, 'SECURITY_GROQ_RPM', DEFAULTS.rpm),
    rpd: intEnv(env, 'SECURITY_GROQ_RPD', DEFAULTS.rpd),
    tpm: intEnv(env, 'SECURITY_GROQ_TPM', DEFAULTS.tpm),
    tpd: intEnv(env, 'SECURITY_GROQ_TPD', DEFAULTS.tpd),
    reserve: floatEnv(env, 'SECURITY_GROQ_RESERVE', DEFAULTS.reserve),
    minIntervalMs: intEnv(env, 'SECURITY_GROQ_MIN_INTERVAL_MS', DEFAULTS.minIntervalBetweenNonPriorityCallsMs, { min: 2000, max: 60000 }),
    now,
  };

  // WICHTIG: EIN GLOBALER TRACKER FÜR ALLE MODELL-AUFRUFE!
  // Fast lane hat ein kleineres durchschnittliches Token-Budget, smart das größere
  const globalTracker = createGlobalTracker(shared);
  const avgSmartTokens = intEnv(env, 'SECURITY_GROQ_AVG_SMART_TOKENS', DEFAULTS.avgSmartCallTokens, { min: 200 });
  const avgFastTokens = intEnv(env, 'SECURITY_GROQ_AVG_FAST_TOKENS', DEFAULTS.avgFastCallTokens, { min: 200 });

  // Wrapper, die das selbe globale Tracking nutzen
  const smart = {
    canSpend(tokens, opts = {}) {
      return globalTracker.canSpend(tokens, { ...opts, avgCallTokens: avgSmartTokens });
    },
    spend(tokens, opts = {}) {
      return globalTracker.spend(tokens, { ...opts, model: 'smart' });
    },
    state() {
      return globalTracker.state(avgSmartTokens);
    },
    usable: globalTracker.usable,
    maxCallsPerDay() {
      return globalTracker.maxCallsPerDay(avgSmartTokens);
    },
  };

  const fast = {
    canSpend(tokens, opts = {}) {
      return globalTracker.canSpend(tokens, { ...opts, avgCallTokens: avgFastTokens });
    },
    spend(tokens, opts = {}) {
      return globalTracker.spend(tokens, { ...opts, model: 'fast' });
    },
    state() {
      return globalTracker.state(avgFastTokens);
    },
    usable: globalTracker.usable,
    maxCallsPerDay() {
      return globalTracker.maxCallsPerDay(avgFastTokens);
    },
  };

  return {
    fast,
    smart,
    /** Kurzbericht für Konsole/Log: wie viele Prüfungen sind pro Tag drin? */
    summary() {
      const s = smart.state();
      return (
        `Budget (Free-Plan-Schonung, global gezählt): ~${s.maxCallsPerDay} Urteile/Tag · ` +
        `Requests/Minute übrig: ${s.remaining.requestsMinute}, Token/Minute übrig: ${s.remaining.tokensMinute} · ` +
        `Token/Tag übrig: ${s.remaining.tokensToday}`
      );
    },
    /** Text für „Limit erreicht“ im Log-Kanal. */
    resetText(info, nowMs = now()) {
      const ms = info?.resetInMs || info?.state?.resetInMs || 0;
      const when = new Date(nowMs + Math.max(0, ms));
      const hhmm = when.toISOString().slice(11, 16);
      const minutes = Math.max(1, Math.round(ms / 60_000));
      return `in ~${minutes} min (${hhmm} UTC)`;
    },
  };
}

module.exports = { createBudgetSet, createGlobalTracker, DEFAULTS };
