/**
 * Conformance: our reader vs the Token-2022 runtime.
 *
 * `keeper/src/trap.mjs` encodes a rule for what multiplier is in force. This
 * script checks that rule against the chain itself, mint by mint:
 *
 *     chainRatio   = getTokenSupply.uiAmountString / (amount / 10^decimals)
 *     ourPredicted = effectiveMultiplier(scaledState, now)
 *
 * `getTokenSupply` reports the runtime's *effective* scaled amount, so
 * `chainRatio` is ground truth for what every wallet and SDK will show. If our
 * prediction matches it on every sampled mint, then the reader is safe to
 * depend on — that is the whole claim, and it is falsifiable in one command.
 *
 * Sampling is stratified on purpose: the mints with real gaps are all included,
 * then the rest are filled from the fresh ones, so a pass cannot be earned by
 * only testing mints where the two agree trivially. Pass `--all` for every
 * official mint (925 RPC calls; slow, and rate limits apply).
 *
 * Usage:
 *   node scripts/conformance.mjs                  # stratified sample (default 24)
 *   node scripts/conformance.mjs --n 100
 *   node scripts/conformance.mjs --all --json keeper/data/conformance.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { effectiveMultiplier } from "../keeper/src/trap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN = join(HERE, "..", "keeper", "data", "xstocks-scan.json");

const RPCS = [
  process.env.OWED_RPC_URL,
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
].filter(Boolean);

/** Relative tolerance. The runtime does decimal math; 1e-9 is generous. */
const TOLERANCE = 1e-9;

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const ALL = args.includes("--all");
const N = Number(argVal("--n", "24"));
const OUT = argVal("--json", null);
// `--only AAPLx,NFLXx` re-checks individual mints, so a transient RPC failure
// during a full sweep can be retried without repeating all 925 calls.
const ONLY = argVal("--only", null)
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(25_000),
        });
        if (res.status === 429) throw new Error("HTTP 429 rate limited");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.error) throw new Error(json.error.message);
        return json.result;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }
  throw new Error(`${method}: ${lastErr?.message}`);
}

const scan = JSON.parse(readFileSync(SCAN, "utf8"));
const now = Math.floor(Date.now() / 1000);

let sample;
if (ONLY?.length) {
  const known = new Map(scan.results.map((r) => [r.symbol, r]));
  const missing = ONLY.filter((s) => !known.has(s));
  if (missing.length) throw new Error(`unknown symbol(s): ${missing.join(", ")}`);
  sample = ONLY.map((s) => known.get(s));
} else if (ALL) {
  sample = scan.results;
} else {
  const withGap = scan.results
    .map((r) => ({
      r,
      gap:
        r.scaledState?.newMultiplier &&
        r.scaledState.newMultiplierEffectiveTimestamp <= now
          ? Number(r.scaledState.newMultiplier) / Number(r.scaledState.multiplier) - 1
          : 0,
    }))
    .sort((a, b) => b.gap - a.gap);

  const interesting = withGap.filter((x) => x.gap > 0.0001).map((x) => x.r);
  const rest = withGap.filter((x) => x.gap <= 0.0001).map((x) => x.r);
  // Even split: every mint with a real gap, then fill from the rest.
  const keep = interesting.slice(0, Math.max(N - Math.ceil(N / 2), 1));
  sample = [...keep, ...rest.slice(0, Math.max(N - keep.length, 0))];
}

console.log(`rpc: ${RPCS[0]}`);
console.log(`clock: ${new Date(now * 1000).toISOString()}`);
console.log(`sampling ${sample.length} mint(s)${ALL ? " (all official)" : ""}\n`);

const rows = [];
let pass = 0;
let fail = 0;
let errored = 0;

for (const rec of sample) {
  const state = rec.scaledState;
  let predicted;
  try {
    predicted = effectiveMultiplier(state, now);
  } catch (err) {
    errored += 1;
    rows.push({ symbol: rec.symbol, mint: rec.mint, status: "PREDICT_FAILED", error: err.message });
    continue;
  }

  let supply;
  try {
    supply = (await rpc("getTokenSupply", [rec.mint])).value;
  } catch (err) {
    errored += 1;
    rows.push({ symbol: rec.symbol, mint: rec.mint, status: "RPC_FAILED", error: err.message });
    process.stdout.write("!");
    continue;
  }

  const raw = Number(supply.amount) / 10 ** supply.decimals;
  const chainRatio = Number(supply.uiAmountString) / raw;
  const relErr = Math.abs(chainRatio / predicted - 1);
  const okRun = relErr <= TOLERANCE || chainRatio === 0;

  if (okRun) pass += 1;
  else fail += 1;
  process.stdout.write(okRun ? "." : "X");

  rows.push({
    symbol: rec.symbol,
    mint: rec.mint,
    stored: Number(state.multiplier),
    pending: state.newMultiplier == null ? null : Number(state.newMultiplier),
    predicted,
    chainRatio,
    relativeError: relErr,
    status: okRun ? "PASS" : "FAIL",
  });
}

console.log("\n");
const failures = rows.filter((r) => r.status === "FAIL");
for (const f of failures) {
  console.log(
    `FAIL ${f.symbol}: predicted ${f.predicted}, chain says ${f.chainRatio} ` +
      `(rel err ${f.relativeError.toExponential(2)})`,
  );
}
for (const e of rows.filter((r) => r.status.endsWith("FAILED"))) {
  console.log(`${e.status} ${e.symbol}: ${e.error}`);
}

const checked = pass + fail;
console.log(
  `\nconformance: ${pass}/${checked} mints match the Token-2022 runtime ` +
    `(tolerance ${TOLERANCE})${errored ? `, ${errored} not checked` : ""}`,
);

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        rpc: RPCS[0],
        clock: now,
        tolerance: TOLERANCE,
        mode: ALL ? "all" : "sample",
        checked,
        pass,
        fail,
        errored,
        results: rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${OUT}`);
}

// Any mismatch between our reader and the runtime is a bug in the reader, and
// must fail loudly.
process.exit(fail === 0 && errored === 0 ? 0 : 1);
