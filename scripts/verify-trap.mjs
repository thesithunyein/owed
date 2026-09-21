/**
 * Settle the central claim: is the stored `multiplier` really stale?
 *
 * The whole "reader trap" thesis rests on one assumption — that Token-2022
 * Scaled UI Amount applies the *pending* multiplier once its effective
 * timestamp has passed, without the authority doing anything. If that
 * assumption is wrong (i.e. the authority must explicitly apply it, and
 * hasn't), then the stored field is still correct and there is no trap.
 *
 * This script tests the assumption against mainnet instead of reasoning
 * about it. `getTokenSupply` returns the *effective* scaled amount from the
 * runtime, so the ratio it reports is ground truth:
 *
 *     ratio = uiAmount / rawAmount
 *
 *   ratio ≈ stored multiplier      -> NOT stale, the thesis is wrong
 *   ratio ≈ pending  multiplier    -> STALE, naive readers are wrong
 *
 * Usage:
 *   node scripts/verify-trap.mjs                 # auto-pick the worst offenders
 *   node scripts/verify-trap.mjs AAPLx NFLXx     # specific symbols
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { effectiveMultiplier, matchVerdict } from "../keeper/src/trap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN = join(HERE, "..", "keeper", "data", "xstocks-scan.json");

const RPCS = [
  process.env.OWED_RPC_URL,
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
].filter(Boolean);

const now = Math.floor(Date.now() / 1000);

/** Thin JSON-RPC call with automatic endpoint failover. */
async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`${method} failed on all endpoints: ${lastErr?.message}`);
}

const scan = JSON.parse(readFileSync(SCAN, "utf8"));

// Default target list: the largest stale gaps first, since those are the
// claims that would hurt most if the assumption were wrong.
const requested = process.argv.slice(2);
let targets;
if (requested.length) {
  targets = requested
    .map((sym) => scan.results.find((r) => r.symbol === sym))
    .filter(Boolean);
} else {
  targets = scan.results
    .filter(
      (r) =>
        r.scaledState?.newMultiplier &&
        r.scaledState.newMultiplierEffectiveTimestamp <= now,
    )
    .map((r) => ({
      ...r,
      _gap: Number(r.scaledState.newMultiplier) / Number(r.scaledState.multiplier) - 1,
    }))
    .sort((a, b) => b._gap - a._gap)
    .slice(0, 8);
}

console.log(`rpc: ${RPCS[0]}`);
console.log(`now: ${new Date(now * 1000).toISOString()}\n`);

const tally = {};
for (const r of targets) {
  const s = r.scaledState ?? {};
  const stored = Number(s.multiplier);
  const pending = s.newMultiplier == null ? null : Number(s.newMultiplier);
  const activation = s.newMultiplierEffectiveTimestamp ?? null;

  let supply;
  try {
    supply = await rpc("getTokenSupply", [r.mint]);
  } catch (err) {
    console.log(`${r.symbol.padEnd(8)} ERROR ${err.message}`);
    tally["ERROR"] = (tally["ERROR"] ?? 0) + 1;
    continue;
  }

  const raw = Number(supply.value.amount) / 10 ** supply.value.decimals;
  const effective = Number(supply.value.uiAmountString);
  const ratio = effective / raw;

  const v = matchVerdict(ratio, stored, pending);
  tally[v] = (tally[v] ?? 0) + 1;

  const ageDays =
    activation == null ? null : ((now - activation) / 86_400).toFixed(1);

  console.log(`${r.symbol}`);
  console.log(`  mint            ${r.mint}`);
  console.log(`  stored field    ${stored}`);
  console.log(`  pending field   ${pending ?? "(none)"}`);
  console.log(
    `  activation      ${activation == null ? "(none)" : new Date(activation * 1000).toISOString()} (${ageDays}d ago)`,
  );
  console.log(`  chain applies   ${ratio}   <- getTokenSupply, ground truth`);
  console.log(`  rule predicts   ${effectiveMultiplier(s, now)}`);
  console.log(
    `  naive misread  ${(((Number(pending ?? stored) / stored) - 1) * 100).toFixed(4)}%`,
  );
  console.log(`  VERDICT         ${v}\n`);
}

console.log("tally:", tally);
