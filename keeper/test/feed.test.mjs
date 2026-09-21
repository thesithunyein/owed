import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { effectiveMultiplier, summarize } from "../src/trap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FEED_PATH = join(ROOT, "feed", "owed-risk.json");
const SCHEMA_PATH = join(ROOT, "feed", "schema.json");
const SCAN_PATH = join(ROOT, "keeper", "data", "xstocks-scan.json");

const hasFeed = existsSync(FEED_PATH);

test("feed: committed and parses", { skip: !hasFeed }, () => {
  const feed = JSON.parse(readFileSync(FEED_PATH, "utf8"));
  assert.equal(feed.feed, "owed/xstocks-risk");
  assert.equal(typeof feed.version, "string");
  assert.ok(Number.isInteger(feed.clock));
});

test("feed: schema file is valid JSON Schema with required keys", { skip: !hasFeed }, () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok(Array.isArray(schema.required));
  for (const key of ["feed", "version", "clock", "tokens", "summary"]) {
    assert.ok(schema.required.includes(key), `schema requires ${key}`);
  }
  // The rule must be documented, since consumers recompute from it.
  assert.ok(
    schema.properties.effectiveMultiplierRule,
    "schema documents the effective-multiplier rule",
  );
});

test("feed: satisfies its own schema shape", { skip: !hasFeed }, () => {
  const feed = JSON.parse(readFileSync(FEED_PATH, "utf8"));
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  for (const key of schema.required) {
    assert.ok(key in feed, `feed has ${key}`);
  }
  for (const t of feed.tokens) {
    for (const key of ["symbol", "mint", "decimals", "scaled", "trap", "security"]) {
      assert.ok(key in t, `${t.symbol} has ${key}`);
    }
    assert.equal(typeof t.trap.stale, "boolean");
    assert.ok(t.scaled.state, `${t.symbol} publishes raw state`);
  }
});

test(
  "feed: every published effectiveMultiplier is recomputable from published state",
  { skip: !hasFeed },
  () => {
    // This is the feed's core promise: a consumer that distrusts our answer can
    // reproduce it from the raw state we ship alongside it.
    const feed = JSON.parse(readFileSync(FEED_PATH, "utf8"));
    let checked = 0;
    for (const t of feed.tokens) {
      const { multiplier, newMultiplier, newMultiplierEffectiveTimestamp } =
        t.scaled.state;
      if (multiplier == null) {
        assert.equal(t.scaled.effectiveMultiplier, null, `${t.symbol} null`);
        continue;
      }
      const recomputed = effectiveMultiplier(
        { multiplier, newMultiplier, newMultiplierEffectiveTimestamp },
        feed.clock,
      );
      assert.equal(
        recomputed,
        t.scaled.effectiveMultiplier,
        `${t.symbol} effectiveMultiplier is reproducible`,
      );
      checked += 1;
    }
    assert.equal(checked, feed.tokens.length);
  },
);

test("feed: trap flags agree with the gap they publish", { skip: !hasFeed }, () => {
  const feed = JSON.parse(readFileSync(FEED_PATH, "utf8"));
  for (const t of feed.tokens) {
    if (t.trap.stale) {
      assert.ok(
        t.trap.gapPct > 0,
        `${t.symbol} stale but gapPct ${t.trap.gapPct}`,
      );
      assert.ok(t.trap.daysStale >= 0, `${t.symbol} has daysStale`);
    } else {
      assert.equal(t.trap.gapPct, null, `${t.symbol} not stale -> gapPct null`);
    }
  }
});

test("feed: summary matches an independent recompute over the scan", { skip: !hasFeed }, () => {
  const feed = JSON.parse(readFileSync(FEED_PATH, "utf8"));
  const scan = JSON.parse(readFileSync(SCAN_PATH, "utf8"));

  // Summary is derived at feed.clock, not "now" — so this stays valid as the
  // clock moves and the committed artifacts stay mutually consistent.
  const expected = summarize(scan.results, feed.clock);
  assert.deepEqual(feed.summary, expected);
});

test("feed: tokens are ordered worst-gap first", { skip: !hasFeed }, () => {
  const feed = JSON.parse(readFileSync(FEED_PATH, "utf8"));
  for (let i = 1; i < feed.tokens.length; i += 1) {
    const prev = feed.tokens[i - 1].trap.gapPct ?? -1;
    const cur = feed.tokens[i].trap.gapPct ?? -1;
    assert.ok(prev >= cur, `order broken at index ${i}`);
  }
});

test("feed: covers every official mint exactly once", { skip: !hasFeed }, () => {
  const feed = JSON.parse(readFileSync(FEED_PATH, "utf8"));
  const scan = JSON.parse(readFileSync(SCAN_PATH, "utf8"));
  assert.equal(feed.tokens.length, scan.results.length);
  const mints = new Set(feed.tokens.map((t) => t.mint));
  assert.equal(mints.size, feed.tokens.length, "no duplicate mints");
});
