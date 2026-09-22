import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveMultiplier,
  readerTrapGap,
  matchVerdict,
  classifyRecord,
  summarize,
} from "../src/trap.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const NOW = 1_790_003_390; // fixed clock (2026-09-21T14:19:50Z)
const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN = join(HERE, "..", "data", "xstocks-scan.json");
const FEED = join(HERE, "..", "..", "feed", "owed-risk.json");

test("effectiveMultiplier: no pending change -> stored value", () => {
  const s = { multiplier: "1.5" };
  assert.equal(effectiveMultiplier(s, NOW), 1.5);
});

test("effectiveMultiplier: before activation -> stored value", () => {
  const s = {
    multiplier: "1.0",
    newMultiplier: "10",
    newMultiplierEffectiveTimestamp: NOW + 3600,
  };
  assert.equal(effectiveMultiplier(s, NOW), 1.0);
});

test("effectiveMultiplier: at and after activation -> pending value", () => {
  const s = {
    multiplier: "1.0",
    newMultiplier: "10",
    newMultiplierEffectiveTimestamp: NOW,
  };
  // boundary: activation is inclusive
  assert.equal(effectiveMultiplier(s, NOW), 10);
  assert.equal(effectiveMultiplier(s, NOW + 1), 10);
});

test("effectiveMultiplier: rejects a missing multiplier", () => {
  assert.throws(() => effectiveMultiplier({}, NOW), /missing multiplier/);
});

test("readerTrapGap: null when nothing to be wrong about", () => {
  assert.equal(readerTrapGap({ multiplier: "1.0" }, NOW), null);
  assert.equal(
    readerTrapGap(
      { multiplier: "1.0", newMultiplier: "2", newMultiplierEffectiveTimestamp: NOW + 10 },
      NOW,
    ),
    null,
  );
});

test("readerTrapGap: reports the fraction a stored-field reader is wrong by", () => {
  const gap = readerTrapGap(
    { multiplier: "1", newMultiplier: "10", newMultiplierEffectiveTimestamp: NOW - 1 },
    NOW,
  );
  assert.equal(gap, 9); // 900%
  const small = readerTrapGap(
    {
      multiplier: "1.0",
      newMultiplier: "1.00390625",
      newMultiplierEffectiveTimestamp: NOW - 1,
    },
    NOW,
  );
  assert.ok(Math.abs(small - 0.00390625) < 1e-12);
});

test("matchVerdict: the four outcomes", () => {
  assert.equal(matchVerdict(10, 1, 10), "STALE_CONFIRMED");
  assert.equal(matchVerdict(1, 1, 10), "STALE_THESIS_WRONG");
  assert.equal(matchVerdict(1, 1, null), "AMBIGUOUS_EQUAL");
  assert.equal(matchVerdict(3, 1, 10), "NEITHER_MATCHES");
});

test("matchVerdict: sub-basis-point noise on an equal pair stays ambiguous", () => {
  assert.equal(matchVerdict(1.00000001, 1, 1), "AMBIGUOUS_EQUAL");
});

// --- pinned against the committed mainnet scan -------------------------------

const scan = JSON.parse(readFileSync(SCAN, "utf8"));
const bySymbol = (sym) => scan.results.find((r) => r.symbol === sym);

test("mainnet pin: NFLXx is a live 10x reader trap", () => {
  const r = bySymbol("NFLXx");
  assert.ok(r, "NFLXx present in scan");
  const state = r.scaledState;
  const effective = effectiveMultiplier(state, NOW);
  assert.equal(effective, 10);
  assert.equal(Number(state.multiplier), 1); // stored field never updated
  assert.equal(readerTrapGap(state, NOW), 9);
});

test("mainnet pin: AAPLx gap is the small compounding-dividend kind", () => {
  const state = bySymbol("AAPLx").scaledState;
  const gap = readerTrapGap(state, NOW);
  assert.ok(gap > 0 && gap < 0.001, `expected a sub-0.1% gap, got ${gap}`);
});

test("mainnet pin: every official mint carries an issuer control surface", () => {
  const c = classifyRecord(bySymbol("AAPLx"), NOW);
  assert.equal(c.hasPermanentDelegate, true);
  assert.equal(c.hasPauseAuthority, true);
  assert.equal(c.paused, false);
});

test("structural counts are facts about the token list, not about prices", () => {
  // These three do not move when the snapshot refreshes: every mint in the
  // official set carries a permanent delegate and a pause authority. Pinning
  // them catches a scan that silently loses coverage, which a count of stale
  // prices cannot.
  const s = summarize(scan.results, NOW);
  assert.equal(s.total, 925, "every official mint was read");
  assert.equal(s.permanentDelegate, 925);
  assert.equal(s.pauseAuthority, 925);
});

test("the published feed is exactly reproducible from the published scan", () => {
  // The README claims a consumer can recompute every published number from
  // published raw state instead of trusting us. This test is that claim, and it
  // is deliberately clock-agnostic.
  //
  // An earlier version pinned the counts themselves (`trap === 379`, `ge100 ===
  // 5`) against a fixed clock. That was worse than useless: it failed the moment
  // a scheduled snapshot refreshed the data, and it had already drifted out of
  // agreement with the feed it was supposedly protecting (`ge100` was 4 there
  // and 5 here). A count of stale prices is a fact about the clock you asked at,
  // not an invariant.
  //
  // Evaluating at the feed's own `clock` makes the check about the thing that
  // must always hold: the feed equals what the scan and the classifier produce.
  const feed = JSON.parse(readFileSync(FEED, "utf8"));

  assert.deepEqual(
    summarize(scan.results, feed.clock),
    feed.summary,
    "feed.summary must equal summarize(scan) at the feed's own clock",
  );

  let checked = 0;
  for (const token of feed.tokens) {
    const rec = scan.results.find((r) => r.mint === token.mint);
    assert.ok(rec, `no scan row for published token ${token.symbol}`);
    const state = rec.scaledState ?? {};
    assert.equal(
      token.scaled.effectiveMultiplier,
      state.multiplier == null ? null : effectiveMultiplier(state, feed.clock),
      `${token.symbol}: published effectiveMultiplier is not reproducible`,
    );
    assert.equal(
      token.trap.stale,
      readerTrapGap(state, feed.clock) != null,
      `${token.symbol}: published staleness flag is not reproducible`,
    );
    checked += 1;
  }
  assert.equal(checked, feed.tokens.length, "every published token was checked");
});
