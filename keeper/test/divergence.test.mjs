import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedReference, flagDivergence } from "../src/divergence.mjs";
import { fetchSnapshot, SolanaRpc, base58Encode } from "../src/snapshot.mjs";

test("split adjustment: 4-for-1 multiplies reference by 4", () => {
  const action = { type: "SPLIT", ratioNum: 4, ratioDen: 1 };
  assert.ok(Math.abs(expectedReference(152.71, action) - 610.84) < 1e-9);
});

test("split adjustment: 1-for-10 reverse split divides", () => {
  const action = { type: "SPLIT", ratioNum: 1, ratioDen: 10 };
  assert.equal(expectedReference(500, action), 50);
});

test("dividend lowers reference by per-token amount", () => {
  const action = { type: "DIVIDEND", amountPerToken: 0.25 };
  assert.ok(Math.abs(expectedReference(101.5, action) - 101.25) < 1e-9);
});

test("ticker change is not price-relevant", () => {
  assert.equal(expectedReference(100, { type: "TICKER" }), null);
});

test("flagDivergence: 4x mispricing on unadjusted split is flagged", () => {
  const r = flagDivergence({
    tokenPrice: 608,
    expectedReference: 152.71 * 4,
    tolerancePct: 1,
  });
  assert.equal(r.flagged, false); // 608 vs 610.84 is within 1%
  const bad = flagDivergence({ tokenPrice: 152.71, expectedReference: 610.84 });
  assert.equal(bad.flagged, true); // quoting pre-split price = 4x off
  assert.equal(bad.direction, "DISCOUNT");
});

test("flagDivergence: small healthy gap stays unflagged", () => {
  const r = flagDivergence({ tokenPrice: 118.11, expectedReference: 118.9, tolerancePct: 1 });
  assert.equal(r.flagged, false);
});

test("fetchSnapshot rejects when holders don't sum to supply", async () => {
  const calls = [];
  const fakeRpc = {
    async mintSupply() {
      calls.push("supply");
      return { amount: 100n, decimals: 6 };
    },
    async tokenAccounts() {
      calls.push("accounts");
      return [
        { owner: "W1", amount: 60n },
        { owner: "W2", amount: 39n },
      ];
    },
  };
  await assert.rejects(() => fetchSnapshot(fakeRpc, "MINT"), /supply mismatch/);
  assert.deepEqual(calls, ["supply", "accounts"]);
});

test("fetchSnapshot merges multi-account wallets and drops zeros", async () => {
  const fakeRpc = {
    async mintSupply() {
      return { amount: 100n, decimals: 6 };
    },
    async tokenAccounts() {
      return [
        { owner: "W1", amount: 30n },
        { owner: "W1", amount: 30n }, // second account, same wallet
        { owner: "W2", amount: 40n },
        { owner: "W3", amount: 0n }, // dust account, must vanish
      ];
    },
  };
  const snap = await fetchSnapshot(fakeRpc, "MINT");
  assert.equal(snap.holders.length, 2);
  const w1 = snap.holders.find((h) => h.owner === "W1");
  assert.equal(w1.amount, 60n);
});

test("SolanaRpc.call error paths", async () => {
  const orig = global.fetch;
  try {
    global.fetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const rpc = new SolanaRpc("http://localhost:1");
    await assert.rejects(() => rpc.call("getHealth"), /HTTP 503/);

    global.fetch = async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, error: { message: "boom" } }),
    });
    await assert.rejects(() => rpc.call("getHealth"), /boom/);
  } finally {
    global.fetch = orig;
  }
});

test("base58Encode matches known Solana system program id", () => {
  // 11111111111111111111111111111111
  const bytes = Uint8Array.from([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  assert.equal(base58Encode(bytes), "11111111111111111111111111111111");
  // A non-trivial known pair: sha of nothing isn't stable; check round properties.
  const some = Uint8Array.from({ length: 32 }, (_, i) => i);
  assert.equal(typeof base58Encode(some), "string");
  assert.ok(!/[0OIl]/.test(base58Encode(some)));
});
