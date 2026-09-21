import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRegister,
  registerRootAndProofs,
  encodeEntry,
} from "../src/merkle.mjs";
import {
  expectedReference,
  flagDivergence,
  buildPythUrl,
  fetchPythPrices,
} from "../src/divergence.mjs";

test("stress: 500-holder register — root, proofs, tamper rejection", () => {
  const entries = [];
  let sum = 0n;
  for (let i = 0; i < 500; i++) {
    const owner = Buffer.alloc(32);
    owner.writeUInt32LE(i, 0);
    const amount = BigInt(((i * 37) % 89) + 1);
    entries.push({ owner, amount });
    sum += amount;
  }
  const reg = buildRegister(entries, sum);
  const { root, proofs } = registerRootAndProofs(reg);

  // Every one of the 500 proofs verifies; every tampered leaf fails.
  for (let i = 0; i < 500; i++) {
    const e = reg.entries[i];
    assert.ok(
      proofs[i].verify(encodeEntry(e.owner, e.amount), Buffer.from(root)),
      `proof ${i} failed`
    );
    // Tampered amount must NOT verify against the root.
    const tampered = Buffer.alloc(40);
    e.owner.copy(tampered, 0);
    tampered.writeBigUInt64LE(e.amount + 1n, 32);
    assert.ok(!proofs[i].verify(tampered, Buffer.from(root)), `tamper ${i} verified?!`);
  }
});

test("stress: split floor-math on real-world-scale balances", () => {
  // Floor-division per holder is NOT distributive over the total, so the
  // register conserves by construction: new total = sum of floored amounts.
  const entries = [
    { owner: Buffer.alloc(32, 1), amount: 1_000_003n }, // indivisible remainder
    { owner: Buffer.alloc(32, 2), amount: 2_000_007n },
  ];
  const reg = buildRegister(entries, 3_000_010n);
  // 4:1 forward split floors exactly (both divide cleanly).
  assert.equal(reg.entries[0].amount * 4n, 4_000_012n);
  assert.equal(reg.entries[1].amount * 4n, 8_000_028n);

  // 1:3 reverse split floors with dust — entitlements must floor too.
  const rev = (amt) => amt / 3n; // BigInt division floors
  assert.equal(rev(1_000_003n), 333_334n);
  assert.equal(rev(2_000_007n), 666_669n);
  // New total = 999_... sum of floored amounts, strictly < total/3 * 3.
  assert.ok(rev(1_000_003n) + rev(2_000_007n) < 3_000_010n / 3n + 1n);
});

test("pyth: buildPythUrl emits repeated ids[] keys Hermes accepts", () => {
  const url = buildPythUrl([
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ], { hermesUrl: "https://hermes.pyth.network" });
  assert.ok(url.startsWith("https://hermes.pyth.network/v2/updates/price/latest?"));
  assert.equal(
    url.split("?")[1],
    "ids%5B%5D=0xaaaa...&ids%5B%5D=0xbbbb...".replace("aaaa...", "a".repeat(64)).replace(
      "bbbb...",
      "b".repeat(64)
    )
  );
  // Double-encoding bug would produce %255B — must not appear.
  assert.ok(!url.includes("%255B"));
});

test("pyth: 401 maps to an actionable API-key error", async () => {
  const orig = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "unauthorized" });
    await assert.rejects(
      () => fetchPythPrices(["0x" + "a".repeat(64)]),
      /API key since 2026-08-26/
    );
  } finally {
    global.fetch = orig;
  }
});

test("pyth: parses a successful authenticated response", async () => {
  const orig = global.fetch;
  try {
    global.fetch = async (url, init) => {
      assert.equal(init.headers.authorization, "Bearer test-key-123");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          parsed: [
            {
              id: "0x" + "a".repeat(64),
              price: { price: "15271000000", conf: "50000000", expo: -8, publish_time: 1758470000 },
            },
          ],
        }),
      };
    };
    const m = await fetchPythPrices(["0x" + "a".repeat(64)], { apiKey: "test-key-123" });
    const v = m.get("0x" + "a".repeat(64));
    assert.equal(v.price, 152.71);
    assert.equal(v.confidence, 0.5);
  } finally {
    global.fetch = orig;
  }
});

test("divergence: zero/negative and non-price-relevant references are handled", () => {
  assert.equal(expectedReference(0, { type: "SPLIT", ratioNum: 4, ratioDen: 1 }), 0);
  assert.equal(expectedReference(100, { type: "MERGER" }), null);
  assert.equal(expectedReference(100, { type: "TICKER" }), null);
  // flagDivergence guards: null/0 reference -> null, not a divide-by-zero.
  assert.equal(flagDivergence({ tokenPrice: 5, expectedReference: null }), null);
  assert.equal(flagDivergence({ tokenPrice: 5, expectedReference: 0 }), null);
  // Exact-tolerance boundary: |gap| == tolerance is NOT flagged (strict >).
  const at = flagDivergence({ tokenPrice: 101, expectedReference: 100, tolerancePct: 1 });
  assert.equal(at.flagged, false);
  const over = flagDivergence({ tokenPrice: 101.01, expectedReference: 100, tolerancePct: 1 });
  assert.equal(over.flagged, true);
});
