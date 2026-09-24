/**
 * Alert rules for the corporate-actions lane.
 *
 * The feed is a *report*: you have to go and look at it. These rules turn the
 * same facts into two events that reach someone without being asked for:
 *
 *   1. **became-stale** - a mint's stored field was current at the last refresh
 *      and is stale now. That is the exact moment every naive integration in
 *      that token starts computing the wrong balance, and it is the moment the
 *      issue is cheapest to catch: nothing has been liquidated yet.
 *
 *   2. **activation-imminent** - an activation is scheduled inside the window
 *      and has not landed. This is the only event in the set that is actionable
 *      *in advance*: an issuer can still publish the update, and an integrator
 *      can still ship the fix before the field goes stale.
 *
 * Deliberately no "still stale" event. 381 mints are stale at any moment, and a
 * daily message saying so is noise that trains the reader to ignore the channel
 * that matters. An alert lane earns its place by being quiet on purpose.
 *
 * Pure functions only - no clock, no network, no filesystem - so the rules are
 * testable offline and the caller owns every source of nondeterminism.
 */

/** Default look-ahead for scheduled activations: two days. */
export const DEFAULT_IMMINENT_WINDOW_SEC = 48 * 60 * 60;

/** The facts about one mint that both the events and the saved state need. */
export function mintFacts(token) {
  const st = token?.scaled?.state;
  if (!st) return null;
  const stored = Number(st.multiplier);
  const next = st.newMultiplier == null ? null : Number(st.newMultiplier);
  const effectiveTimestamp = Number(st.newMultiplierEffectiveTimestamp || 0);
  return {
    mint: token.mint,
    symbol: token.symbol,
    issuer: token.issuer ?? null,
    stored,
    next,
    effectiveTimestamp,
    effective: token.scaled?.effectiveMultiplier ?? null,
    stale: !!token.trap?.stale,
    gapPct: token.trap?.gapPct ?? null,
    daysStale: token.trap?.daysStale ?? null,
  };
}

/** Every mint in the feed, both issuers, as facts. */
export function feedFacts(feed) {
  return [...(feed?.tokens ?? []), ...(feed?.preStocks ?? [])]
    .map(mintFacts)
    .filter(Boolean);
}

/**
 * The state a later run diffs against: just enough to tell what changed, and
 * nothing that would make the file churn on every refresh (no timestamps, no
 * prices), because a state file that changes every run produces a diff every run
 * and a commit every six hours for no reason.
 */
export function alertState(feed) {
  return {
    clock: feed?.clock ?? null,
    // Only the mints that can ever produce an event: currently stale, or with a
    // scheduled change. A mint reading 1x that has never scheduled anything is
    // inert - it cannot become stale without first appearing here as a pending
    // activation, so recording all 933 of them (a 163KB file, rewritten on every
    // refresh) buys nothing and pays for itself in diff noise.
    mints: feedFacts(feed)
      .filter((f) => f.stale || (f.effectiveTimestamp > 0 && f.next !== f.stored))
      .map((f) => ({
        mint: f.mint,
        symbol: f.symbol,
        stale: f.stale,
        stored: f.stored,
        next: f.next,
        effectiveTimestamp: f.effectiveTimestamp,
      })),
  };
}

/**
 * Events for this refresh.
 *
 * `previous` may be null (first run, or the state file is missing): in that case
 * nothing is "new", because announcing 383 pre-existing mints as if they had
 * just happened would be the single most misleading thing this lane could do.
 */
export function classifyAlerts(
  feed,
  previous,
  nowSec,
  { imminentWindowSec = DEFAULT_IMMINENT_WINDOW_SEC } = {},
) {
  const events = [];
  const before = new Map((previous?.mints ?? []).map((m) => [m.mint, m]));
  const firstRun = before.size === 0;

  for (const f of feedFacts(feed)) {
    const was = before.get(f.mint);

    // Absent from a populated state means "inert last time": not stale and
    // nothing scheduled. That is a real transition and must be reported, which
    // is why the previous state is trimmed rather than exhaustive.
    if (f.stale && !firstRun && (!was || was.stale === false)) {
      events.push({
        kind: "became-stale",
        mint: f.mint,
        symbol: f.symbol,
        issuer: f.issuer,
        stored: f.stored,
        effective: f.effective,
        gapPct: f.gapPct,
        daysStale: f.daysStale,
        message:
          `${f.symbol}: the stored multiplier field stopped matching the runtime. The chain ` +
          `now applies ${f.effective}x while the field still reads ${f.stored}x.`,
      });
    }

    if (!f.stale && f.next != null && f.next !== f.stored) {
      const seconds = f.effectiveTimestamp - nowSec;
      if (f.effectiveTimestamp > 0 && seconds > 0 && seconds <= imminentWindowSec) {
        events.push({
          kind: "activation-imminent",
          mint: f.mint,
          symbol: f.symbol,
          issuer: f.issuer,
          stored: f.stored,
          effective: f.next,
          activatesAt: f.effectiveTimestamp,
          secondsUntil: seconds,
          message:
            `${f.symbol}: a ${f.next}x multiplier activates in ` +
            `${Math.max(1, Math.round(seconds / 3600))}h. The field reads ${f.stored}x today and ` +
            `will diverge from the runtime the moment it lands.`,
        });
      }
    }
  }

  return { firstRun, events };
}

/** A short human digest. Plain text, so it fits a chat message or a log line. */
export function formatDigest(feed, { firstRun, events }, nowSec) {
  const facts = feedFacts(feed);
  const stale = facts.filter((f) => f.stale).length;
  const when = new Date(nowSec * 1000).toISOString().replace("T", " ").slice(0, 16);
  const lines = [
    `Owed - corporate-action alerts (${when} UTC)`,
    `${stale} of ${facts.length} official tokenized-equity mints read a stored multiplier ` +
      `the runtime does not apply right now.`,
  ];

  if (firstRun) {
    lines.push("", "No previous state to compare against, so nothing is reported as new.");
  } else if (events.length === 0) {
    lines.push("", "No mint changed state and nothing activates in the next 48h.");
  } else {
    lines.push("");
    for (const e of events) lines.push(`${e.kind}: ${e.message}`);
  }

  const soonest = facts
    .filter((f) => !f.stale && f.effectiveTimestamp > nowSec && f.next !== f.stored)
    .sort((a, b) => a.effectiveTimestamp - b.effectiveTimestamp)[0];
  if (soonest) {
    lines.push(
      "",
      `Next scheduled activation: ${soonest.symbol} -> ${soonest.next}x at ` +
        `${new Date(soonest.effectiveTimestamp * 1000).toISOString().slice(0, 16)}Z.`,
    );
  }
  return lines.join("\n");
}
