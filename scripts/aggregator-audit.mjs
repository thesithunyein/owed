/**
 * PROBE — aggregator supply legibility. NOT a finding. Read this first.
 *
 * We tried to establish that the largest Solana DEX aggregator misstates
 * xStock supply. The probe does not establish that, and is kept as a record
 * of an open question rather than as evidence.
 *
 * Method: read on-chain supply via `getTokenSupply` (raw and scaled), read the
 * aggregator's displayed market cap and price for the deepest pool, and recover
 * the supply it implies (marketCap / priceUsd). Compare.
 *
 * Why the controls invalidate the conclusion: market cap is not derived from
 * total supply. The control tokens miss too — JUP implies 0.48x total supply
 * (locked/vested tokens excluded) and USDC implies 9.6x (supply aggregated
 * across chains/issuers). So a mismatch here is consistent with a difference in
 * *how supply is defined*, not with an inability to read it. Only BONK, which
 * has no locks or multi-chain supply, matches — one control is not enough to
 * blame the aggregator for anything.
 *
 * What we can say, narrowly and verifiably: `fdv == priceUsd * 1000` exactly for
 * several xStocks (NFLXx: 720,770 / 720.76 = 1000.0), which looks like a
 * fallback constant rather than a reading. That is an observation about one
 * field, not a demonstrated harm, and it is not used in the README.
 *
 * Usage:
 *   node scripts/aggregator-audit.mjs              # default sample
 *   node scripts/aggregator-audit.mjs --n 25       # more xStocks
 *   node scripts/aggregator-audit.mjs --json out.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN = join(HERE, "..", "keeper", "data", "xstocks-scan.json");

const RPCS = [
  process.env.OWED_RPC_URL,
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
].filter(Boolean);

/** Ordinary SPL tokens, used to calibrate "the aggregator can read supply". */
const CONTROLS = [
  { symbol: "BONK (control)", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  { symbol: "JUP (control)", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  { symbol: "USDC (control)", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
];

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const N = Number(argVal("--n", "12"));
const OUT = argVal("--json", null);

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
  throw new Error(`${method}: ${lastErr?.message}`);
}

/** Deepest pair quoting `mint` as the base token, per the aggregator. */
async function aggregatorPair(mint) {
  const res = await fetch(
    `https://api.dexscreener.com/latest/dex/search?q=${mint}`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!res.ok) throw new Error(`dexscreener HTTP ${res.status}`);
  const json = await res.json();
  const pairs = (json.pairs ?? []).filter(
    (p) => p.chainId === "solana" && p.baseToken?.address === mint,
  );
  if (!pairs.length) return null;
  return pairs.sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
  )[0];
}

/** Ratio of two supply figures, guarded against divide-by-zero. */
const ratio = (a, b) => (b === 0 ? null : a / b);

/** Classify the implied supply against the two on-chain readings. */
function classify(implied, raw, scaled, tol = 0.01) {
  if (implied == null) return "NO_SUPPLY_REPORTED";
  const rRaw = ratio(implied, raw);
  const rScaled = ratio(implied, scaled);
  const nearRaw = rRaw != null && Math.abs(rRaw - 1) <= tol;
  const nearScaled = rScaled != null && Math.abs(rScaled - 1) <= tol;
  if (nearRaw || nearScaled) return "MATCHES_ONCHAIN";
  return "MISMATCH";
}

async function audit(label, mint) {
  const supply = (await rpc("getTokenSupply", [mint])).value;
  const raw = Number(supply.amount) / 10 ** supply.decimals;
  const scaled = Number(supply.uiAmountString);

  const pair = await aggregatorPair(mint);
  if (!pair) {
    return { label, mint, raw, scaled, verdict: "NO_PAIR", implied: null };
  }

  const price = Number(pair.priceUsd);
  const mc = pair.marketCap == null ? null : Number(pair.marketCap);
  const impliedMc = mc == null || !price ? null : mc / price;

  return {
    label,
    mint,
    raw,
    scaled,
    priceUsd: price,
    marketCap: mc,
    fdv: pair.fdv == null ? null : Number(pair.fdv),
    impliedSupply: impliedMc,
    ratioVsRaw: ratio(impliedMc, raw),
    ratioVsScaled: ratio(impliedMc, scaled),
    verdict: classify(impliedMc, raw, scaled),
  };
}

const scan = JSON.parse(readFileSync(SCAN, "utf8"));
const now = Math.floor(Date.now() / 1000);

// Sample xStocks across the spectrum: worst stale gaps first, then a spread,
// so the audit is not silently dominated by the one dramatic case.
const stale = scan.results
  .filter((r) => r.scaledState?.newMultiplierEffectiveTimestamp <= now)
  .map((r) => ({
    r,
    gap: Number(r.scaledState.newMultiplier) / Number(r.scaledState.multiplier) - 1,
  }))
  .sort((a, b) => b.gap - a.gap);
const fresh = scan.results.filter(
  (r) =>
    !r.scaledState?.newMultiplier ||
    r.scaledState.newMultiplierEffectiveTimestamp > now,
);
const sample = [
  ...stale.slice(0, Math.ceil(N / 2)).map((x) => x.r),
  ...fresh.slice(0, Math.floor(N / 2)),
];

console.log(`rpc: ${RPCS[0]}`);
console.log(`xStocks sampled: ${sample.length} | controls: ${CONTROLS.length}\n`);

const results = [];
for (const { symbol, mint } of CONTROLS) {
  results.push({ ...(await audit(symbol, mint)), group: "control" });
}
for (const r of sample) {
  results.push({ ...(await audit(r.symbol, r.mint)), group: "xstock" });
}

const fmt = (n, d = 0) =>
  n == null ? "—" : Math.abs(n) >= 1e6 ? n.toExponential(2) : n.toFixed(d);

console.log(
  "token".padEnd(18) +
    "chain scaled".padStart(16) +
    "chain raw".padStart(16) +
    "implied supply".padStart(16) +
    "vs scaled".padStart(12) +
    "  verdict",
);
for (const r of results) {
  console.log(
    r.label.padEnd(18) +
      fmt(r.scaled).padStart(16) +
      fmt(r.raw).padStart(16) +
      fmt(r.impliedSupply).padStart(16) +
      (r.ratioVsScaled == null ? "—" : r.ratioVsScaled.toFixed(4) + "x").padStart(12) +
      "  " +
      r.verdict,
  );
}

const ctl = results.filter((r) => r.group === "control");
const xst = results.filter((r) => r.group === "xstock");
const ok = (rows) => rows.filter((r) => r.verdict === "MATCHES_ONCHAIN").length;

console.log(
  `\ncontrols matching on-chain: ${ok(ctl)}/${ctl.length}` +
    `\nxStocks  matching on-chain: ${ok(xst)}/${xst.length}`,
);
const worst = xst
  .filter((r) => r.ratioVsScaled != null)
  .sort(
    (a, b) =>
      Math.max(b.ratioVsScaled, 1 / b.ratioVsScaled) -
      Math.max(a.ratioVsScaled, 1 / a.ratioVsScaled),
  )[0];
if (worst) {
  const factor = Math.max(worst.ratioVsScaled, 1 / worst.ratioVsScaled);
  console.log(
    `largest supply error: ${worst.label}, off by ${factor.toFixed(1)}x ` +
      `(${factor >= 1 ? "over" : "under"}-stated)`,
  );
}

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), rpc: RPCS[0], results },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nwrote ${OUT}`);
}

// Deliberately always exits 0: a failing control is the expected outcome here,
// and it invalidates the probe rather than the aggregator. See the header.
if (ok(ctl) < ctl.length) {
  console.log(
    "\nNOTE controls also mismatch -> cannot attribute this to the aggregator." +
      "\n      Market cap uses a circulating/aggregated supply definition.",
  );
}
