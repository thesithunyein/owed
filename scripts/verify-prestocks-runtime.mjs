/**
 * Settle the cross-issuer half of the thesis against the chain, and commit the
 * result as evidence.
 *
 * Owed claims the reader trap is a property of the Token-2022 Scaled UI Amount
 * extension rather than of one issuer. That claim is only worth anything if the
 * second issuer was measured the same way - so this script asks the runtime
 * itself, for every official PreStocks mint, and writes what it answered:
 *
 *     ratio = uiAmountString / (amount / 10^decimals)
 *
 * `getTokenSupply` returns the effective scaled amount from the runtime, so
 * that ratio is ground truth and our reader is either right or wrong about it:
 *
 *   ratio ~= stored multiplier   -> no trap on this mint
 *   ratio ~= pending multiplier  -> activation is live, naive readers are wrong
 *
 * The output is committed (keeper/data/prestocks-runtime.json) because a chain
 * claim in this repo needs a committed artifact, and CI asserts the committed
 * verdicts rather than re-running the network.
 *
 * Usage:
 *   node scripts/verify-prestocks-runtime.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { effectiveMultiplier, matchVerdict, MATCH_TOLERANCE } from "../keeper/src/trap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SCAN = join(ROOT, "keeper", "data", "prestocks-scan.json");
const OUT = join(ROOT, "keeper", "data", "prestocks-runtime.json");

const RPCS = [
  process.env.OWED_RPC_URL,
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
].filter(Boolean);

const now = Math.floor(Date.now() / 1000);

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
      return { result: json.result, url };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`${method} failed on all endpoints: ${lastErr?.message}`);
}

const scan = JSON.parse(readFileSync(SCAN, "utf8"));
console.log(`verifying ${scan.results.length} PreStocks mints against the runtime …`);
console.log(`now: ${new Date(now * 1000).toISOString()}\n`);

const mints = [];
const verdicts = {};
let usedRpc = null;

for (const r of scan.results) {
  const s = r.scaledState ?? {};
  const stored = Number(s.multiplier);
  const pending = s.newMultiplier == null ? null : Number(s.newMultiplier);
  const activation = s.newMultiplierEffectiveTimestamp ?? null;

  let supply;
  try {
    const out = await rpc("getTokenSupply", [r.mint]);
    supply = out.result;
    usedRpc = out.url;
  } catch (err) {
    console.log(`${r.symbol.padEnd(11)} ERROR ${err.message}`);
    continue;
  }

  const raw = Number(supply.value.amount) / 10 ** supply.value.decimals;
  const measuredRatio = Number(supply.value.uiAmountString) / raw;

  // The verdict comes from the shared rule, so this measures the artifact
  // rather than restating it: a mismatch here is the thesis being wrong.
  const verdict = matchVerdict(measuredRatio, stored, pending);
  verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;

  mints.push({
    symbol: r.symbol,
    mint: r.mint,
    storedMultiplier: stored,
    pendingMultiplier: pending,
    activation,
    measuredRatio,
    rulePredicts: effectiveMultiplier(s, now),
    verdict,
  });

  console.log(
    `${r.symbol.padEnd(11)} stored=${String(stored).padEnd(5)} pending=${String(pending).padEnd(11)} ` +
      `chain=${measuredRatio.toFixed(7).padEnd(11)} rule=${String(effectiveMultiplier(s, now)).padEnd(11)} ${verdict}`,
  );
}

const doc = {
  checkedAt: new Date(now * 1000).toISOString(),
  rpc: usedRpc,
  issuer: "prestocks",
  method: "getTokenSupply: uiAmountString / (amount / 10^decimals)",
  tolerance: MATCH_TOLERANCE,
  note:
    "Ground-truth corroboration that the classifier agrees with the runtime for " +
    "every official PreStocks mint, not only for the xStocks roster. Committed so " +
    "CI can assert the verdicts without network access.",
  verdicts,
  mints,
};

writeFileSync(OUT, JSON.stringify(doc, null, 1));
console.log(`\nverdicts: ${JSON.stringify(verdicts)}`);
console.log(`wrote ${OUT}`);
