/**
 * Example: price a tokenized-equity position correctly.
 *
 * A wallet, DEX, pricing bot or protocol that reads the mint's stored
 * `multiplier` field gets a different number than the runtime applies, on every
 * mint whose corporate action has already activated. This is the three-line fix.
 *
 * Nothing here claims the chain is wrong or that an issuer was negligent: the
 * runtime applies the effective multiplier correctly, and re-publishing the
 * stored field is the issuer's operational choice. The claim is only that the
 * two fields disagree, and that reading the wrong one is avoidable.
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
  `  stored is current   : ${!s.stale}` +
    `${s.daysStale != null ? `   <- the two fields diverged ${Math.round(s.daysStale)} days ago` : ""}`,
);
console.log(`  display balance     : ${toDisplayAmount(rawBalance, s.effective)} base units`);
if (s.stale) {
  console.log(
    `\n  Fix: use effective=${s.effective}, not stored=${s.stored}. ` +
      `A client reading the stored field is ${s.factor.toFixed(4)}x wrong until you do.`,
  );
}
