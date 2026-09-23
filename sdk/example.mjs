/**
 * Example: price a tokenized-equity position correctly.
 *
 * A lending protocol, wallet or pricing bot that reads the mint's stored
 * `multiplier` field will understate every position on a mint whose corporate
 * action already activated. This is the three-line fix.
 *
 *   node example.mjs                 # PPLTx, a 10x split that activated
 *   node example.mjs AAPLx           # look up any official xStock by symbol
 *
 * Needs no key and no wallet: it reads public mainnet state.
 */

import { getScaledState, toDisplayAmount } from "./owed.mjs";

// Official xStocks list; symbols are the ticker, mints are the address.
const XSTOCKS = {
  PPLTx: "Xst6eFD4YT6sz9RLMysN9SyvaZWtraSdVJQGu5ZkAme",
  AAPLx: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  TSLAx: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
};

const symbol = process.argv[2] ?? "PPLTx";
const mint = XSTOCKS[symbol] ?? symbol; // accept a mint address too

const s = await getScaledState(mint);
if (!s) {
  console.log(`${symbol} has no scaled multiplier (nothing to correct).`);
  process.exit(0);
}

// A holder's raw balance as the RPC reports it (here: 1 token, 1e8 base units).
const rawBalance = 100_000_000n;

console.log(`${symbol} (${mint})`);
console.log(`  stored multiplier   : ${s.stored}   <- what a naive reader uses`);
console.log(`  effective multiplier: ${s.effective}   <- what the chain applies`);
console.log(
  `  stale               : ${s.stale}${s.daysStale != null ? ` for ${Math.round(s.daysStale)} days` : ""}`,
);
console.log(`  display balance     : ${toDisplayAmount(rawBalance, s.effective)} base units`);
if (s.stale) {
  console.log(
    `\n  Fix: use effective=${s.effective}, not stored=${s.stored}. ` +
      `Positions are understated by ${s.factor.toFixed(4)}x until you do.`,
  );
}
