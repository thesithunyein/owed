import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SolanaRpc,
  fetchSnapshot,
  base58Encode,
  base58Decode,
  decodePubkey,
} from "../src/snapshot.mjs";

// ---------------------------------------------------------------------------
// Base58 — encode/decode round-trips and known vectors
// ---------------------------------------------------------------------------

test("base58: system program round-trips to all-ones string", () => {
  const zeros = new Uint8Array(32);
  assert.equal(base58Encode(zeros), "11111111111111111111111111111111");
  assert.deepEqual([...base58Decode("11111111111111111111111111111111")], [...zeros]);
});

test("base58: known vector (hello world)", () => {
  // Canonical vector: "hello world" -> base58 "StV1DL6CwTryKyV"
  assert.equal(base58Encode(new TextEncoder().encode("hello world")), "StV1DL6CwTryKyV");
  assert.equal(new TextDecoder().decode(base58Decode("StV1DL6CwTryKyV")), "hello world");
  assert.equal(base58Encode(new Uint8Array(0)), "");
});

test("base58: random 32-byte round-trips", () => {
  for (let t = 0; t < 50; t++) {
    const b = new Uint8Array(32);
    for (let i = 0; i < 32; i++) b[i] = (i * 7 + t * 13) % 256;
    const enc = base58Encode(b);
    assert.ok(!/[0OIl]/.test(enc));
    assert.deepEqual([...base58Decode(enc)], [...b]);
  }
});

test("base58: leading zeros preserved", () => {
  const b = new Uint8Array([0, 0, 0, 9, 0, 42]);
  const enc = base58Encode(b);
  assert.ok(enc.startsWith("11"));
  assert.deepEqual([...base58Decode(enc)], [...b]);
});

test("base58: rejects non-alphabet characters", () => {
  assert.throws(() => base58Decode("0OIl"), /invalid base58/);
});

test("decodePubkey enforces 32 bytes", () => {
  assert.throws(() => decodePubkey("StV1DL6CwTryKyV"), /32-byte/);
  assert.equal(decodePubkey("11111111111111111111111111111111").length, 32);
});

// ---------------------------------------------------------------------------
// SolanaRpc JSON parsing — mocked fetch
// ---------------------------------------------------------------------------

test("SolanaRpc parses mint supply correctly", async () => {
  const orig = global.fetch;
  try {
    let body;
    global.fetch = async (url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: body.id,
          result: { value: { amount: "123456789", decimals: 6, uiAmount: 123.456789 } },
        }),
      };
    };
    const rpc = new SolanaRpc("http://test");
    const s = await rpc.mintSupply("MINT");
    assert.equal(s.amount, 123456789n);
    assert.equal(s.decimals, 6);
    assert.equal(body.method, "getTokenSupply");
  } finally {
    global.fetch = orig;
  }
});

test("SolanaRpc tokenAccounts sends correct gPA filters and parses response", async () => {
  const orig = global.fetch;
  try {
    let body;
    global.fetch = async (url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            value: [
              {
                pubkey: "TA1",
                account: {
                  data: {
                    parsed: {
                      info: {
                        owner: "W1",
                        tokenAmount: { amount: "70", uiAmount: 0.00007, decimals: 6 },
                      },
                    },
                  },
                },
              },
              {
                pubkey: "TA2",
                account: {
                  data: {
                    parsed: {
                      info: {
                        owner: "W2",
                        tokenAmount: { amount: "30", uiAmount: 0.00003, decimals: 6 },
                      },
                    },
                  },
                },
              },
            ],
          },
        }),
      };
    };
    const rpc = new SolanaRpc("http://test");
    const accounts = await rpc.tokenAccounts("MINT");
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0].amount, 70n);
    // Verify the RPC filters we send are the canonical holder-enumeration form.
    const [programId, cfg] = body.params;
    assert.equal(programId, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    assert.deepEqual(cfg.filters, [
      { dataSize: 165 },
      { memcmp: { offset: 0, bytes: "MINT" } },
    ]);
  } finally {
    global.fetch = orig;
  }
});

// ---------------------------------------------------------------------------
// fetchSnapshot — merge/drop/conservation edge cases
// ---------------------------------------------------------------------------

function fakeRpc(supply, accounts) {
  return {
    async mintSupply() {
      return { amount: supply, decimals: 6 };
    },
    async tokenAccounts() {
      return accounts;
    },
  };
}

test("fetchSnapshot: multi-account merge, zero-drop, conservation OK", async () => {
  const snap = await fetchSnapshot(
    fakeRpc(100n, [
      { owner: "W1", amount: 30n },
      { owner: "W1", amount: 30n },
      { owner: "W2", amount: 40n },
      { owner: "W3", amount: 0n },
      { owner: "W4", amount: 0n },
    ]),
    "MINT"
  );
  assert.equal(snap.holders.length, 2);
  assert.equal(snap.supply, 100n);
});

test("fetchSnapshot: empty register throws (no holders but supply > 0)", async () => {
  await assert.rejects(
    () => fetchSnapshot(fakeRpc(100n, [{ owner: "W1", amount: 0n }]), "MINT"),
    /supply mismatch/
  );
});

test("fetchSnapshot: single holder owning 100% passes", async () => {
  const snap = await fetchSnapshot(fakeRpc(100n, [{ owner: "W1", amount: 100n }]), "MINT");
  assert.equal(snap.holders.length, 1);
  assert.equal(snap.holders[0].amount, 100n);
});

test("fetchSnapshot: rejects when a whale transfers after supply read", async () => {
  // Simulates race: supply read sees 100, accounts read sees 90.
  await assert.rejects(
    () => fetchSnapshot(fakeRpc(100n, [{ owner: "W1", amount: 90n }]), "M535"),
    /supply mismatch/
  );
});
