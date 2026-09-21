/**
 * LIVE integration test — skipped unless OWED_LIVE_RPC=1.
 *
 *   OWED_LIVE_RPC=1 OWED_TEST_MINT=<addr> node --test test/live.test.mjs
 *
 * Exercises the real devnet path end-to-end against a mint the operator
 * has created and funded. Skipped by default so `node --test` stays
 * hermetic and CI never flakes on network.
 *
 * Env:
 *   OWED_LIVE_RPC=1        enable
 *   OWED_TEST_MINT=<addr>  the devnet mint to snapshot (required when enabled)
 *   OWED_RPC_URL=<url>     optional, defaults to api.devnet.solana.com
 */
import { test, skip } from "node:test";
import assert from "node:assert/strict";
import { SolanaRpc, fetchSnapshot, decodePubkey } from "../src/snapshot.mjs";
import { buildRegister, registerRootAndProofs, encodeEntry } from "../src/merkle.mjs";

const ENABLED = process.env.OWED_LIVE_RPC === "1";
const MINT = process.env.OWED_TEST_MINT;
const URL_ = process.env.OWED_RPC_URL || "https://api.devnet.solana.com";

test("live: devnet mint snapshots with conservation and verifiable proofs", { skip: !ENABLED }, async () => {
  assert.ok(MINT, "OWED_TEST_MINT is required when OWED_LIVE_RPC=1");
  decodePubkey(MINT); // throws if malformed

  const rpc = new SolanaRpc(URL_);
  const { holders, supply } = await fetchSnapshot(rpc, MINT);

  assert.ok(supply > 0n, "mint must have non-zero supply");
  assert.ok(holders.length > 0, "register must have at least one holder");

  const sum = holders.reduce((a, h) => a + h.amount, 0n);
  assert.equal(sum, supply, "live conservation failed");

  // Build the register and verify every proof — the full keeper path.
  holders.sort((a, b) => Buffer.compare(Buffer.from(a.owner), Buffer.from(b.owner)));
  const reg = buildRegister(
    holders.map((h) => ({ owner: Buffer.from(h.owner), amount: h.amount })),
    supply
  );
  const { root, proofs } = registerRootAndProofs(reg);
  for (let i = 0; i < reg.entries.length; i++) {
    const e = reg.entries[i];
    assert.ok(
      proofs[i].verify(encodeEntry(e.owner, e.amount), Buffer.from(root)),
      `live proof ${i} failed`
    );
  }
  console.log(
    `LIVE OK: ${holders.length} holders, supply ${supply}, root 0x${Buffer.from(root).toString("hex")}`
  );
});
