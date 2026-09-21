/**
 * The harm, modelled — and deliberately price-free.
 *
 * The multiplier trap is easy to dismiss as a display bug. This script shows
 * why it is a *settlement* bug, using only the ratio between the stored and
 * effective multiplier, so the result holds at any price and for any position
 * size.
 *
 * The model. A lending market values collateral by reading the extension:
 *
 *     naiveValue   = rawAmount * storedMultiplier   * price
 *     correctValue = rawAmount * effectiveMultiplier * price
 *
 * A borrower's loan-to-value is debt / collateralValue, so the *apparent* LTV a
 * protocol computes is inflated by exactly:
 *
 *     apparentLTV = trueLTV * (effectiveMultiplier / storedMultiplier)
 *
 * Price and position size both cancel. For NFLXx the factor is 10, so a
 * position that is genuinely at 8% LTV reads as 80% — past a typical 75%
 * liquidation threshold. The protocol liquidates a healthy position, and the
 * error is the protocol's, caused by the stale field, not by the borrower.
 *
 * Usage:
 *   node scripts/collateral-scenario.mjs
 *   node scripts/collateral-scenario.mjs --ltv 0.10 --threshold 0.75
 *   node scripts/collateral-scenario.mjs --json keeper/data/collateral.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { effectiveMultiplier, readerTrapGap } from "../keeper/src/trap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN = join(HERE, "..", "keeper", "data", "xstocks-scan.json");

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const TRUE_LTV = Number(argVal("--ltv", "0.10"));
const THRESHOLD = Number(argVal("--threshold", "0.75"));
const OUT = argVal("--json", null);

const now = Math.floor(Date.now() / 1000);
const scan = JSON.parse(readFileSync(SCAN, "utf8"));

/** One row per mint whose stored field is no longer what the chain applies. */
const rows = [];
for (const rec of scan.results) {
  const state = rec.scaledState;
  if (!state) continue;
  const gap = readerTrapGap(state, now);
  if (gap == null) continue;

  const stored = Number(state.multiplier);
  const effective = effectiveMultiplier(state, now);
  const factor = effective / stored; // apparentLTV = trueLTV * factor

  const daysStale =
    state.newMultiplierEffectiveTimestamp == null
      ? null
      : (now - Number(state.newMultiplierEffectiveTimestamp)) / 86_400;

  const apparentLtv = TRUE_LTV * factor;
  const wronglyLiquidatable = apparentLtv >= THRESHOLD;
  // How far below the threshold the true position really is.
  const trueLtvAtLiquidation = THRESHOLD / factor;

  rows.push({
    symbol: rec.symbol,
    mint: rec.mint,
    stored,
    effective,
    factor,
    gapPct: gap * 100,
    daysStale,
    apparentLtv,
    wronglyLiquidatable,
    trueLtvAtLiquidation,
  });
}

rows.sort((a, b) => b.factor - a.factor);

const wrongful = rows.filter((r) => r.wronglyLiquidatable);

console.log(`clock: ${new Date(now * 1000).toISOString()}`);
console.log(
  `assumed true LTV ${(TRUE_LTV * 100).toFixed(0)}% | liquidation threshold ${(THRESHOLD * 100).toFixed(0)}%`,
);
console.log(
  `mints with a stale multiplier: ${rows.length} of ${scan.results.length}\n`,
);

console.log(
  "token".padEnd(10) +
    "stored".padStart(9) +
    "effective".padStart(11) +
    "factor".padStart(9) +
    "apparent LTV".padStart(14) +
    "days stale".padStart(12) +
    "   consequence",
);
for (const r of rows.slice(0, 18)) {
  console.log(
    r.symbol.padEnd(10) +
      String(r.stored).padStart(9) +
      String(r.effective).padStart(11) +
      (r.factor.toFixed(2) + "x").padStart(9) +
      ((r.apparentLtv * 100).toFixed(1) + "%").padStart(14) +
      (r.daysStale == null ? "—" : r.daysStale.toFixed(0)).padStart(12) +
      "   " +
      (r.wronglyLiquidatable
        ? `LIQUIDATED while truly at ${(TRUE_LTV * 100).toFixed(0)}% LTV`
        : "over-valued, no liquidation"),
  );
}
if (rows.length > 18) console.log(`… and ${rows.length - 18} more`);

console.log(
  `\n${wrongful.length} of ${rows.length} stale-multiplier mints would liquidate a ` +
    `position that is genuinely at ${(TRUE_LTV * 100).toFixed(0)}% LTV, ` +
    `under a ${(THRESHOLD * 100).toFixed(0)}% threshold.`,
);

const worst = rows[0];
if (worst) {
  console.log(
    `\nSharpest case: ${worst.symbol}. A position that is truly at ` +
      `${(TRUE_LTV * 100).toFixed(0)}% LTV reads as ` +
      `${(worst.apparentLtv * 100).toFixed(0)}%. A protocol with a ` +
      `${(THRESHOLD * 100).toFixed(0)}% threshold would have to be reading a ` +
      `position below ${(worst.trueLtvAtLiquidation * 100).toFixed(2)}% true LTV ` +
      `before it liquidates something healthy.`,
  );
}

console.log(
  "\nprice-free by construction: the price multiplies both valuations and\n" +
    "cancels out of the ratio, so this holds at any price and any size.",
);

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        clock: now,
        assumptions: { trueLtv: TRUE_LTV, liquidationThreshold: THRESHOLD },
        totalOfficial: scan.results.length,
        staleCount: rows.length,
        wrongfulLiquidationCount: wrongful.length,
        results: rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nwrote ${OUT}`);
}
