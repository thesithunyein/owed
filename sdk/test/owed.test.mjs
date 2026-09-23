import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getScaledState, getEffectiveMultiplier, toDisplayAmount } from "../owed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A real mainnet account, captured verbatim with `getAccountInfo` at
 * jsonParsed encoding: PPLTx, an xStocks mint whose 10x split activated on
 * 2026-05-16 (1778985000) and whose stored `multiplier` still reads 1. The
 * tests run offline against this, so a fixture refresh is the only way the
 * shape can change - and CI cannot flake on a public RPC.
 */
const FIXTURE = JSON.parse(
  readFileSync(join(HERE, "fixtures", "xstocks-ppltx-mint.json"), "utf8"),
);

const PPLTX = "Xst6eFD4YT6sz9RLMysN9SyvaZWtraSdVJQGu5ZkAme";
const ACTIVATION_TS = 1_778_985_000; // 2026-05-16, from the fixture itself
const ACTIVATED = 1_790_000_000; // after the activation passed
const BEFORE = 1_700_000_000; // before it

/** Stand in for the network with the committed fixture, so the glue is tested. */
function stubFetch(value, { status = 200, error = null } = {}) {
  return async (url, init) => {
    assert.equal(init.method, "POST", "SDK must use JSON-RPC POST");
    const body = JSON.parse(init.body);
    assert.equal(body.method, "getAccountInfo");
    assert.equal(body.params[1].encoding, "jsonParsed", "parsed encoding carries the extensions");
    return {
      ok: status === 200,
      status,
      json: async () => (error ? { error } : { result: { value } }),
    };
  };
}

test("fixture is the shape the SDK expects", () => {
  const ext = FIXTURE.data.parsed.info.extensions.find((e) => e.extension === "scaledUiAmountConfig");
  assert.ok(ext, "fixture carries scaledUiAmountConfig");
  assert.equal(ext.state.multiplier, "1");
  assert.equal(ext.state.newMultiplier, "10");
  assert.equal(ext.state.newMultiplierEffectiveTimestamp, ACTIVATION_TS);
  assert.equal(FIXTURE.data.parsed.info.decimals, 8);
  // Token-2022, not the legacy token program: the extension only exists here.
  assert.equal(FIXTURE.owner, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
});

test("after activation the effective multiplier is 10x the stored field", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = stubFetch(FIXTURE);
  try {
    const s = await getScaledState(PPLTX, { nowSec: ACTIVATED });
    assert.equal(s.stored, 1, "stored field still reads 1");
    assert.equal(s.effective, 10, "the chain applies 10");
    assert.equal(s.factor, 10);
    assert.equal(s.stale, true);
    assert.equal(s.pending, false);
    assert.ok(s.daysStale > 100, `stale for a long time, got ${s.daysStale}`);
  } finally {
    globalThis.fetch = real;
  }
});

test("before activation the stored field is correct and nothing is flagged", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = stubFetch(FIXTURE);
  try {
    const s = await getScaledState(PPLTX, { nowSec: BEFORE });
    assert.equal(s.stored, 1);
    assert.equal(s.effective, 1, "the activation has not landed yet");
    assert.equal(s.factor, 1);
    assert.equal(s.stale, false, "no trap before the activation");
    assert.equal(s.pending, true, "but the change is scheduled");
    assert.equal(s.daysStale, null);
  } finally {
    globalThis.fetch = real;
  }
});

test("the one-liner returns the effective multiplier", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = stubFetch(FIXTURE);
  try {
    assert.equal(await getEffectiveMultiplier(PPLTX, { nowSec: ACTIVATED }), 10);
  } finally {
    globalThis.fetch = real;
  }
});

test("a mint without a scaled config returns null rather than throwing", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = stubFetch(null);
  try {
    assert.equal(await getScaledState(PPLTX, { nowSec: ACTIVATED }), null);
    assert.equal(await getEffectiveMultiplier(PPLTX, { nowSec: ACTIVATED }), null);
  } finally {
    globalThis.fetch = real;
  }
});

test("transport failure throws, because an error is not 'no config'", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = stubFetch(null, { error: { message: "rate limited" } });
  try {
    await assert.rejects(
      () => getScaledState(PPLTX, { nowSec: ACTIVATED }),
      /rate limited/,
    );
  } finally {
    globalThis.fetch = real;
  }
});

test("toDisplayAmount applies the effective multiplier", () => {
  // 1 token (1e8 base units) on a 10x mint displays as 10 tokens.
  assert.equal(toDisplayAmount(100_000_000n, 10), 1_000_000_000n);
  // An unrounded corporate-action multiplier keeps its precision.
  assert.equal(toDisplayAmount(100_000_000n, 1.0032690125398187), 100_326_901n);
});

test("LIVE: mainnet still reports 10x for PPLTx (network-gated)", async (t) => {
  // Off by default so `node --test` stays hermetic. Run with:
  //   OWED_LIVE_SDK=1 node --test test/owed.test.mjs
  if (process.env.OWED_LIVE_SDK !== "1") {
    t.skip("set OWED_LIVE_SDK=1 to hit mainnet");
    return;
  }
  const s = await getScaledState(PPLTX);
  assert.equal(s.stored, 1, "the trap is still what the field says");
  assert.equal(s.effective, 10, "and the chain still applies 10");
  assert.equal(s.stale, true);
});
