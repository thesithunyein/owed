/**
 * The raw-bytes fixtures under `shared/vectors/scaled-raw/` are what the Rust
 * reader in `core/src/multiplier.rs` and the on-chain `read_multiplier`
 * instruction are tested against. That makes them load-bearing, and a fixture
 * has two ways to rot:
 *
 *   1. it was captured at a moment whose numbers the feed no longer publishes,
 *      so the Rust expectations (which are the published numbers) stop being
 *      true statements about the bytes; or
 *   2. the bytes stop being the account the manifest names - a re-fetch of a
 *      different mint, or a truncated write.
 *
 * Both are checked here, because neither is visible from inside the Rust tests:
 * they read the fixtures as opaque byte arrays.
 *
 * The walk below is deliberately an independent implementation of the reader,
 * in a different language, over the same bytes. Its job is not to test the Rust
 * code - the Rust unit tests do that - but to prove that the numbers published
 * in the feed are recoverable from the committed bytes at all, so the fixtures
 * are evidence rather than decoration.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DIR = join(ROOT, "shared", "vectors", "scaled-raw");

const MANIFEST = join(DIR, "manifest.json");
const hasFixtures = existsSync(MANIFEST);

const FEED = join(ROOT, "feed", "owed-risk.json");
const feed = existsSync(FEED) ? JSON.parse(readFileSync(FEED, "utf8")) : null;

const manifest = hasFixtures ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null;
const fixture = (symbol) => manifest.fixtures.find((f) => f.symbol === symbol);

/** Minimal TLV walk over raw mint bytes. Mirrors core/src/multiplier.rs. */
function readScaledRaw(bytes) {
  const ACCOUNT_TYPE_OFFSET = 165;
  const TLV_START = 166;
  if (bytes.length <= ACCOUNT_TYPE_OFFSET) return null;
  assert.equal(bytes[ACCOUNT_TYPE_OFFSET], 1, "fixture is a mint, not an account");
  let o = TLV_START;
  while (o + 4 <= bytes.length) {
    const type = bytes.readUInt16LE(o);
    const len = bytes.readUInt16LE(o + 2);
    if (type === 0 && len === 0) break;
    if (type === 25) {
      assert.equal(len, 56, "scaled UI amount entry is 56 bytes");
      const p = o + 4;
      return {
        multiplier: bytes.readDoubleLE(p + 32),
        effectiveTimestamp: Number(bytes.readBigInt64LE(p + 40)),
        newMultiplier: bytes.readDoubleLE(p + 48),
      };
    }
    o += 4 + len;
  }
  return null;
}

const feedRow = (symbol) => {
  const all = [...(feed?.tokens ?? []), ...(feed?.preStocks ?? [])];
  return all.find((t) => t.symbol === symbol) ?? null;
};

test("scaled-raw fixtures: the manifest still describes the committed feed", () => {
  assert.ok(hasFixtures, "shared/vectors/scaled-raw/manifest.json exists");
  assert.ok(feed, "feed/owed-risk.json exists");
  assert.ok(manifest.fixtures.length >= 5, "the fixture set covers every branch");

  for (const f of manifest.fixtures) {
    const row = feedRow(f.symbol);
    if (!row) {
      // USDC is the "no scaled config" control and has no feed row by design.
      assert.equal(f.stored, null, `${f.symbol} has no feed row, so no expectations`);
      continue;
    }
    assert.equal(f.mint, row.mint, `${f.symbol}: manifest names the feed's mint`);
    assert.equal(
      f.stored,
      Number(row.scaled.state.multiplier),
      `${f.symbol}: stored multiplier matches the feed`,
    );
    assert.equal(
      f.newMultiplier,
      Number(row.scaled.state.newMultiplier),
      `${f.symbol}: pending multiplier matches the feed`,
    );
    assert.equal(
      f.effectiveTimestamp,
      Number(row.scaled.state.newMultiplierEffectiveTimestamp),
      `${f.symbol}: activation timestamp matches the feed`,
    );
    assert.equal(
      f.effective,
      row.scaled.effectiveMultiplier,
      `${f.symbol}: effective multiplier matches the feed`,
    );
    assert.equal(f.readerTrap, row.trap.stale, `${f.symbol}: trap flag matches the feed`);
  }
});

test("scaled-raw fixtures: the bytes on disk are the accounts the manifest names", () => {
  assert.ok(hasFixtures);
  for (const f of manifest.fixtures) {
    const bytes = readFileSync(join(DIR, `${f.symbol}.bin`));
    assert.equal(bytes.length, f.bytes, `${f.symbol}: byte length matches the manifest`);
  }

  // The four equity fixtures must be Token-2022 mints that carry the extension,
  // and the legacy control must not.
  for (const symbol of ["PPLTx", "SPACEX", "AZNx", "SPCXx"]) {
    const parsed = readScaledRaw(readFileSync(join(DIR, `${symbol}.bin`)));
    assert.ok(parsed, `${symbol}: carries a scaled UI amount config`);
    assert.equal(parsed.multiplier, fixture(symbol).stored, `${symbol}: stored`);
    assert.equal(parsed.newMultiplier, fixture(symbol).newMultiplier, `${symbol}: pending`);
    assert.equal(
      parsed.effectiveTimestamp,
      fixture(symbol).effectiveTimestamp,
      `${symbol}: timestamp`,
    );
  }
  assert.equal(readScaledRaw(readFileSync(join(DIR, "USDC.bin"))), null, "USDC has no config");
});

test("scaled-raw fixtures: the published numbers are derivable from the bytes", () => {
  // This is the claim the whole exercise rests on: not "we read the field" but
  // "anyone with these bytes and this rule gets the published number". Computed
  // here from raw bytes at the manifest's own clock, compared against the feed.
  assert.ok(hasFixtures);
  const now = BigInt(manifest.nowSec);
  for (const symbol of ["PPLTx", "SPACEX", "AZNx", "SPCXx"]) {
    const parsed = readScaledRaw(readFileSync(join(DIR, `${symbol}.bin`)));
    const ts = BigInt(parsed.effectiveTimestamp);
    const activated = ts > 0n && now >= ts;
    const effective = activated ? parsed.newMultiplier : parsed.multiplier;
    assert.equal(
      effective,
      fixture(symbol).effective,
      `${symbol}: raw bytes + the rule = the published effective multiplier`,
    );

    const changes = parsed.newMultiplier !== parsed.multiplier;
    assert.equal(
      activated && changes,
      fixture(symbol).readerTrap,
      `${symbol}: raw bytes + the rule = the published trap flag`,
    );
  }
});

test("scaled-raw fixtures: the second-issuer fixture exercises the TLV walk", () => {
  // If a future re-capture ever returned an account whose scaled entry happens
  // to sit first, this fixture would stop testing the thing it exists to test,
  // and the Rust test would keep passing. Fail loudly instead.
  assert.ok(hasFixtures);
  const bytes = readFileSync(join(DIR, "SPACEX.bin"));
  const first = bytes.readUInt16LE(166);
  assert.notEqual(
    first,
    25,
    "the PreStocks fixture must keep the scaled entry NOT first in the TLV list",
  );
  assert.ok(
    readScaledRaw(bytes),
    "and the walk must still find it (a fixed-offset reader would not)",
  );
});
