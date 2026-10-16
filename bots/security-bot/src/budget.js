/**
 * ============================================================================
 *  Groq-Budget – Free-Plan-Schonung mit maximaler Ausnutzung
 *
 *  Free-Plan pro Modell (Stand 2026): 30 Anfragen/Minute, 1.000 Anfragen/Tag,
 *  8.000 Token/Minute, 200.000 Token/Tag. Das Tages-Budget an Token ist der
 *  echte Engpass – nicht die Anfragen.
 *
 *  Dieser Baustein:
 *    - zählt Anfragen + Token rollend (Minute/Tag) und hält eine Reserve frei
 *      (Standard 12 %), damit nie „auf Kante“ gefahren wird;
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
  rpd: 1000,
  tpm: 8000,
  tpd: 200000,
  reserve: 0.12,
  avgSmartCallTokens: 2600,
  avgFastCallTokens: 1100,
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

function createLane({
  name,
  rpm = DEFAULTS.rpm,
  rpd = DEFAULTS.rpd,
  tpm = DEFAULTS.tpm,
  tpd = DEFAULTS.tpd,
  reserve = DEFAULTS.reserve,
  avgCallTokens = 2000,
  now = () => Date.now(),
} = {}) {
  const usable = {
    rpm: Math.max(1, Math.floor(rpm * (1 - reserve))),
    rpd: Math.max(1, Math.floor(rpd * (1 - reserve))),
    tpm: Math.max(100, Math.floor(tpm * (1 - reserve))),
    tpd: Math.max(1000, Math.floor(tpd * (1 - reserve))),
  };
  const events = []; // { at, tokens }

  function prune(t) {
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
  function canSpend(tokens, { priority = false } = {}) {
    const t = now();
    const s = windowStats(t);
    const need = Math.max(1, Math.floor(tokens));

    if (s.reqDay >= usable.rpd) {
      return { ok: false, reason: 'rpd', resetInMs: startOfNextDay(t) - t, stats: s, usable };
    }
    if (s.tokDay + need > usable.tpd) {
      return { ok: false, reason: 'tpd', resetInMs: startOfNextDay(t) - t, stats: s, usable };
    }
    if (s.reqMinute >= usable.rpm) {
      return { ok: false, reason: 'rpm', resetInMs: windowCooldown(events, t, 60_000, 'req'), stats: s, usable };
    }
    if (s.tokMinute + need > usable.tpm) {
      return { ok: false, reason: 'tpm', resetInMs: windowCooldown(events, t, 60_000, 'tok', need), stats: s, usable };
    }
    if (!priority) {
      const wait = routineDelay(t);
      if (wait > 0) return { ok: true, waitMs: wait, reason: 'pacing', stats: s, usable };
    }
    return { ok: true, waitMs: 0, reason: 'ok', stats: s, usable };
  }

  /** Wie lange bis die Token/Minute wieder Platz haben. */
  function windowCooldown(list, t, windowMs, kind, need = 0) {
    if (!list.length) return 1000;
    let wait = 1000;
    let sum = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      sum += list[i].tokens;
      const freeIn = list[i].at + windowMs - t;
      if (kind === 'tok') {
        if (sum <= usable.tpm - need) break;
      } else if (i < list.length - usable.rpm) {
        break;
      }
      wait = Math.max(wait, freeIn);
    }
    return wait;
  }

  function startOfNextDay(t) {
    const d = new Date(t);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 5);
    return next;
  }

  /** Mindestabstand für Ruhe-Prüfungen, damit das Limit für den Tag reicht. */
  function maxCallsPerDay() {
    return Math.max(1, Math.min(usable.rpd, Math.floor(usable.tpd / Math.max(200, avgCallTokens))));
  }

  function routineDelay(t) {
    const last = events[events.length - 1];
    if (!last) return 0;
    const minInterval = Math.floor(86_400_000 / maxCallsPerDay());
    const elapsed = t - last.at;
    return elapsed >= minInterval ? 0 : minInterval - elapsed;
  }

  function spend(tokens) {
    events.push({ at: now(), tokens: Math.max(1, Math.floor(tokens)) });
    return windowStats(now());
  }

  function state() {
    const t = now();
    const s = windowStats(t);
    return {
      name,
      usable,
      used: s,
      remaining: {
        requestsToday: Math.max(0, usable.rpd - s.reqDay),
        tokensToday: Math.max(0, usable.tpd - s.tokDay),
        requestsMinute: Math.max(0, usable.rpm - s.reqMinute),
        tokensMinute: Math.max(0, usable.tpm - s.tokMinute),
      },
      maxCallsPerDay: maxCallsPerDay(),
      resetInMs: startOfNextDay(t) - t,
      routineDelayMs: routineDelay(t),
    };
  }

  return { name, canSpend, spend, state, usable, maxCallsPerDay, routineDelay };
}

/** Beide Spuren (schnelle Vorprüfung + schlaues Urteil) aus der Umgebung bauen. */
function createBudgetSet(env, { now = () => Date.now() } = {}) {
  const shared = {
    rpm: intEnv(env, 'SECURITY_GROQ_RPM', DEFAULTS.rpm),
    rpd: intEnv(env, 'SECURITY_GROQ_RPD', DEFAULTS.rpd),
    tpm: intEnv(env, 'SECURITY_GROQ_TPM', DEFAULTS.tpm),
    tpd: intEnv(env, 'SECURITY_GROQ_TPD', DEFAULTS.tpd),
    reserve: floatEnv(env, 'SECURITY_GROQ_RESERVE', DEFAULTS.reserve),
    now,
  };
  const smart = createLane({
    ...shared,
    name: 'smart',
    avgCallTokens: intEnv(env, 'SECURITY_GROQ_AVG_SMART_TOKENS', DEFAULTS.avgSmartCallTokens, { min: 200 }),
  });
  const fast = createLane({
    ...shared,
    name: 'fast',
    avgCallTokens: intEnv(env, 'SECURITY_GROQ_AVG_FAST_TOKENS', DEFAULTS.avgFastCallTokens, { min: 200 }),
  });
  return {
    fast,
    smart,
    /** Kurzbericht für Konsole/Log: wie viele Prüfungen sind pro Tag drin? */
    summary() {
      const s = smart.state();
      const f = fast.state();
      return (
        `Budget (Free-Plan-Schonung): ~${s.maxCallsPerDay} Urteile/Tag ` +
        `(Mindestabstand ${Math.round(s.routineDelayMs / 1000)}s) · ` +
        `Vorprüfungen: ~${f.maxCallsPerDay}/Tag · Token/Tag übrig: ${s.remaining.tokensToday}`
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

module.exports = { createBudgetSet, createLane, DEFAULTS };
