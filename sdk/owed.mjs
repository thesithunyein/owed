/**
 * owed — ask one mint what the chain actually applies.
 *
 * Token-2022's Scaled UI Amount extension stores a `multiplier` plus a pending
 * change with an activation timestamp. After the activation passes, the stored
 * field is stale and the runtime applies the NEW value - so a client that reads
 * `multiplier` alone understates every position. Verified against the runtime's
 * own scaled amount on all 925 official mints (scripts/conformance.mjs).
 *
 *   import { getEffectiveMultiplier } from "./owed.mjs";
 *   await getEffectiveMultiplier("Xst6eFD4YT6sz9RLMysN9SyvaZWtraSdVJQGu5ZkAme"); // 10
 *
 * Zero dependencies: Node 18+ `fetch` only. The reader itself is imported from
 * the keeper rather than reimplemented, because two copies of this rule would
 * drift and the whole product is the rule being right.
 */

import { classifyScaled, extractExtensions } from "../keeper/src/scaled.mjs";

/** Default to mainnet: this answers a question about live assets. */
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

/**
 * Fetch one mint's scaled-UI-amount state.
 *
 * Returns null when the mint has no scaled config (a plain token, or a mint
 * that does not exist), so callers can branch on absence instead of catching.
 * Throws on transport failure, because a network error is not "no config".
 */
export async function getScaledState(mint, { rpcUrl = DEFAULT_RPC, nowSec } = {}) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [mint, { encoding: "jsonParsed", commitment: "confirmed" }],
    }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status} from ${rpcUrl}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);
  const value = body.result?.value;
  if (!value) return null;

  const ext = extractExtensions(value);
  if (!ext?.scaled) return null;

  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const cls = classifyScaled(ext.scaled, now, ext);
  return {
    mint,
    decimals: ext.decimals,
    supply: ext.supply,
    /** What the on-chain field says. Most clients read only this. */
    stored: cls.multiplier,
    /** What the runtime applies right now. Use this. */
    effective: cls.effective,
    /** effective / stored. 1 means the stored field is current. */
    factor: cls.effective / cls.multiplier,
    /** True when the stored field is stale right now. */
    stale: cls.readerTrap,
    /** True when an activation is scheduled but has not landed. */
    pending: cls.pending,
    /** When the pending multiplier activates, epoch seconds, or null. */
    effectiveTimestamp: cls.effectiveTimestamp,
    /** Days since the activation passed, or null. */
    daysStale:
      cls.readerTrap && cls.effectiveTimestamp
        ? (now - cls.effectiveTimestamp) / 86400
        : null,
  };
}

/** The one-liner: the multiplier the chain applies to this mint right now. */
export async function getEffectiveMultiplier(mint, opts) {
  const s = await getScaledState(mint, opts);
  return s ? s.effective : null;
}

/** Convert a raw token amount to the display amount the runtime applies. */
export function toDisplayAmount(rawAmount, effectiveMultiplier) {
  const scale = 1_000_000_000n;
  return (
    (BigInt(rawAmount) * BigInt(Math.round(effectiveMultiplier * 1e9))) / scale
  );
}
