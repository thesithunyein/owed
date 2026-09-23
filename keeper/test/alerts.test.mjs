/**
 * The alert rules decide when Owed interrupts someone, which is the one thing
 * this repo publishes that a person reads unprompted. So the rules are tested
 * for the two ways an alert lane fails: firing when nothing happened, and
 * staying quiet when something did.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  alertState,
  classifyAlerts,
  feedFacts,
  formatDigest,
  mintFacts,
  DEFAULT_IMMINENT_WINDOW_SEC,
} from "../src/alerts.mjs";

const NOW = 1_800_000_000;

/** One synthetic mint, with only the fields the rules read. */
function token({
  symbol = "TESTx",
  mint = "Mint1111111111111111111111111111111111111111",
  issuer = "xstocks",
  stored = 1,
  next = 1,
  ts = 0,
  stale = false,
  gapPct = null,
} = {}) {
  return {
    issuer,
    symbol,
    mint,
    scaled: {
      state: {
        multiplier: String(stored),
        newMultiplier: String(next),
        newMultiplierEffectiveTimestamp: ts,
      },
      effectiveMultiplier: stale ? next : stored,
    },
    trap: stale ? { stale: true, gapPct, daysStale: 12 } : { stale: false },
  };
}

const feedOf = (tokens, extra = {}) => ({ clock: NOW, tokens, preStocks: [], ...extra });

test("alerts: the first run never reports anything as new", () => {
  // Without state there is no "changed": announcing 383 pre-existing mints as
  // fresh events would be the most misleading thing this lane could do, and it
  // is exactly what a naive `previous ?? {}` produces.
  const feed = feedOf([token({ symbol: "A", stale: true, next: 10, ts: NOW - 100 })]);
  const r = classifyAlerts(feed, null, NOW);
  assert.equal(r.firstRun, true);
  assert.deepEqual(r.events, []);
});

test("alerts: a mint that becomes stale is reported once, with the numbers", () => {
  const staleTok = token({ symbol: "PPLTx", stale: true, next: 10, ts: NOW - 100, gapPct: 900 });
  const before = { clock: NOW - 3600, mints: [{ mint: staleTok.mint, symbol: "PPLTx", stale: false }] };

  const r = classifyAlerts(feedOf([staleTok]), before, NOW);
  assert.equal(r.firstRun, false);
  assert.equal(r.events.length, 1);
  const [e] = r.events;
  assert.equal(e.kind, "became-stale");
  assert.equal(e.stored, 1);
  assert.equal(e.effective, 10);
  assert.equal(e.gapPct, 900);
  assert.match(e.message, /PPLTx/);
});

test("alerts: a mint absent from a populated state is treated as newly stale", () => {
  // The saved state is trimmed to the mints that can matter (stale, or with a
  // scheduled change). So a mint it does not mention was inert last time, and
  // becoming stale is exactly the transition worth reporting. Getting this
  // wrong makes the lane silent for the one case it exists for.
  const staleTok = token({ symbol: "NEWx", stale: true, next: 4, ts: NOW - 10, gapPct: 300 });
  const before = {
    clock: NOW - 3600,
    mints: [{ mint: "SomeOtherMint", symbol: "OTHER", stale: true }],
  };
  const r = classifyAlerts(feedOf([staleTok]), before, NOW);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "became-stale");
  assert.equal(r.events[0].symbol, "NEWx");
});

test("alerts: the saved state omits inert mints and keeps the ones that can fire", () => {
  const inert = token({ symbol: "INERT" });
  const active = token({ symbol: "ACTIVE", stale: true, next: 10, ts: NOW - 1 });
  const pending = token({ symbol: "PENDING", stored: 1, next: 2, ts: NOW + 100 });
  const state = alertState(feedOf([inert, active, pending]));
  assert.deepEqual(state.mints.map((m) => m.symbol).sort(), ["ACTIVE", "PENDING"]);
});

test("alerts: a mint that was already stale stays quiet", () => {
  // 381 mints are stale at any moment. A daily "still stale" message is noise,
  // and noise in an alert channel is how the channel stops being read.
  const staleTok = token({ symbol: "PPLTx", stale: true, next: 10, ts: NOW - 100 });
  const before = { clock: NOW - 3600, mints: [{ mint: staleTok.mint, stale: true }] };
  const r = classifyAlerts(feedOf([staleTok]), before, NOW);
  assert.deepEqual(r.events, []);
});

test("alerts: an activation inside the window is reported before it lands", () => {
  // The only event that is actionable in advance: the issuer can still publish,
  // the integrator can still ship.
  const soon = token({ symbol: "AZNx", stored: 1, next: 0.5, ts: NOW + 3600 });
  const before = { clock: NOW - 3600, mints: [{ mint: soon.mint, stale: false }] };
  const r = classifyAlerts(feedOf([soon]), before, NOW);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "activation-imminent");
  assert.equal(r.events[0].secondsUntil, 3600);
  assert.match(r.events[0].message, /activates in/);
});

test("alerts: the activation window boundary is inclusive and the far side is quiet", () => {
  const atEdge = token({ symbol: "EDGE", stored: 1, next: 2, ts: NOW + DEFAULT_IMMINENT_WINDOW_SEC });
  const before = { clock: NOW - 1, mints: [{ mint: atEdge.mint, stale: false }] };
  assert.equal(classifyAlerts(feedOf([atEdge]), before, NOW).events.length, 1);

  const beyond = token({ symbol: "FAR", stored: 1, next: 2, ts: NOW + DEFAULT_IMMINENT_WINDOW_SEC + 1 });
  assert.equal(
    classifyAlerts(feedOf([beyond]), { clock: NOW - 1, mints: [{ mint: beyond.mint, stale: false }] }, NOW)
      .events.length,
    0,
  );

  const past = token({ symbol: "PAST", stored: 1, next: 2, ts: NOW - 1, stale: false });
  assert.equal(
    classifyAlerts(feedOf([past]), { clock: NOW - 1, mints: [{ mint: past.mint, stale: false }] }, NOW)
      .events.length,
    0,
    "an activation that already happened is not imminent",
  );
});

test("alerts: a pending update that changes nothing is not an event", () => {
  // Plenty of mints schedule a value equal to the stored one. Those are inert,
  // and alerting on them would cry wolf on the majority of the catalogue.
  const inert = token({ symbol: "SPCXx", stored: 1, next: 1, ts: NOW + 60 });
  const before = { clock: NOW - 1, mints: [{ mint: inert.mint, stale: false }] };
  assert.deepEqual(classifyAlerts(feedOf([inert]), before, NOW).events, []);
});

test("alerts: both issuers are covered, not just the one with the headline", () => {
  const pre = {
    ...token({ symbol: "SPACEX", stored: 1, next: 5, ts: NOW - 100, stale: true, gapPct: 400 }),
    issuer: "prestocks",
  };
  const before = { clock: NOW - 1, mints: [{ mint: pre.mint, stale: false }] };
  const r = classifyAlerts({ clock: NOW, tokens: [], preStocks: [pre] }, before, NOW);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].issuer, "prestocks");
});

test("alerts: the state file is stable across identical runs", () => {
  // The refresh workflow commits whatever this writes. If the state carried a
  // wall-clock timestamp it would produce a commit every six hours forever,
  // which is churn that hides real changes.
  const feed = feedOf([
    token({ symbol: "A", stale: true, next: 10, ts: NOW - 5 }),
    token({ symbol: "B" }),
  ]);
  const a = JSON.stringify(alertState(feed));
  const b = JSON.stringify(alertState(feed));
  assert.equal(a, b);
  assert.deepEqual(Object.keys(alertState(feed)).sort(), ["clock", "mints"]);
});

test("alerts: facts survive a mint with no scaled config", () => {
  assert.equal(mintFacts({ symbol: "USDC", mint: "x" }), null);
  assert.deepEqual(feedFacts({ tokens: [token({ symbol: "A" })], preStocks: [{ symbol: "no-config" }] }).length, 1);
});

test("alerts: the digest says so when nothing happened", () => {
  const feed = feedOf([token({ symbol: "A" }), token({ symbol: "B", stale: true, next: 10, ts: NOW - 1 })]);
  const quiet = formatDigest(feed, { firstRun: false, events: [] }, NOW);
  assert.match(quiet, /No mint changed state/);
  assert.match(quiet, /1 of 2 official tokenized-equity mints misprice/);

  const first = formatDigest(feed, { firstRun: true, events: [] }, NOW);
  assert.match(first, /No previous state to compare against/);
});

test("alerts: the digest names the next scheduled activation", () => {
  const later = token({ symbol: "LATER", stored: 1, next: 2, ts: NOW + 90_000 });
  const sooner = token({ symbol: "SOONER", stored: 1, next: 3, ts: NOW + 90 });
  const feed = feedOf([later, sooner]);
  const digest = formatDigest(feed, { firstRun: false, events: [] }, NOW);
  assert.match(digest, /Next scheduled activation: SOONER -> 3x/);
});
