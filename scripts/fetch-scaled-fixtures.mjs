/**
 * Capture real mainnet mint accounts as committed fixtures for the raw reader.
 *
 * The Rust reader in `core/src/multiplier.rs` and the on-chain `read_multiplier`
 * instruction both parse Token-2022 bytes directly, with no JSON-RPC and no
 * `jsonParsed` help. That code is only worth trusting if it is pinned to bytes
 * that actually exist on mainnet, so this script fetches a small, deliberate set
 * of mints and writes their raw account data to `shared/vectors/scaled-raw/`.
 *
 * The set is chosen to cover every branch of the reader:
 *   PPLTx    - activation passed, stored field stale, 10x (the headline defect)
 *   SPACEX   - PreStocks issuer, 5x, and the scaled entry is NOT first in the
 *              TLV list (payload at byte 593, not 279) - so a fixed-offset
 *              reader passes the xStocks fixtures and fails this one
 *   AZNx     - reverse split (0.5111...), activated, stored field current
 *   SPCXx    - scaled config present but inert (timestamp 0, new == stored)
 *   USDC     - legacy SPL mint: no Token-2022 extensions at all, so the reader
 *              must report "no config" rather than misreading the padding
 *
 * Expectations in `manifest.json` are copied out of the committed risk feed
 * (`feed/owed-risk.json`), not computed here, so the fixtures and the published
 * numbers cannot drift apart silently: the keeper test compares the two.
 *
 * Run: node scripts/fetch-scaled-fixtures.mjs [--rpc <url>]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "shared", "vectors", "scaled-raw");

const RPC_FLAG = process.argv.indexOf("--rpc");
const RPC =
  RPC_FLAG > -1 && process.argv[RPC_FLAG + 1]
    ? process.argv[RPC_FLAG + 1]
    : "https://api.mainnet-beta.solana.com";

/** symbol -> mint. Symbols match the feed's own labels so the join is trivial. */
const FIXTURES = [
  ["PPLTx", "Xst6eFD4YT6sz9RLMysN9SyvaZWtraSdVJQGu5ZkAme"],
  ["SPACEX", "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh"],
  ["AZNx", "Xs3ZFkPYT2BN7qBMqf1j1bfTeTm1rFzEFSsQ1z3wAKU"],
  ["SPCXx", "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8"],
  ["USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
];

const rpc = async (method, params) => {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);
  return body.result;
};

/**
 * A symbol's published numbers from the committed feed, or null when the
 * fixture is not a tokenized equity (USDC is here to prove the "no scaled
 * config" branch, and deliberately has no feed row).
 */
function feedRow(feed, symbol) {
  const all = [...(feed.tokens ?? []), ...(feed.preStocks ?? [])];
  return all.find((t) => t.symbol === symbol) ?? null;
}

const feed = JSON.parse(readFileSync(join(ROOT, "feed", "owed-risk.json"), "utf8"));
const nowSec = feed.clock;

const accounts = await rpc("getMultipleAccounts", [
  FIXTURES.map(([, mint]) => mint),
  { encoding: "base64" },
]);

mkdirSync(OUT, { recursive: true });

const manifest = [];
for (let i = 0; i < FIXTURES.length; i += 1) {
  const [symbol, mint] = FIXTURES[i];
  const value = accounts.value[i];
  if (!value) throw new Error(`${symbol}: mint ${mint} not found on mainnet`);
  const bytes = Buffer.from(value.data[0], "base64");

  writeFileSync(join(OUT, `${symbol}.bin`), bytes);

  const row = feedRow(feed, symbol);
  const scaled = row?.scaled?.state ?? null;
  manifest.push({
    symbol,
    mint,
    owner: value.owner,
    bytes: bytes.length,
    // Copied from the feed, not recomputed: see the header note.
    stored: scaled ? Number(scaled.multiplier) : null,
    newMultiplier: scaled ? Number(scaled.newMultiplier) : null,
    effectiveTimestamp: scaled ? Number(scaled.newMultiplierEffectiveTimestamp) : null,
    effective: row?.scaled?.effectiveMultiplier ?? null,
    readerTrap: row?.trap?.stale ?? null,
  });
  console.log(
    `${symbol.padEnd(7)} ${String(bytes.length).padStart(4)} bytes  ` +
      `stored=${manifest.at(-1).stored} effective=${manifest.at(-1).effective}`,
  );
}

writeFileSync(
  join(OUT, "manifest.json"),
  `${JSON.stringify(
    {
      note:
        "Raw mainnet mint accounts, captured by scripts/fetch-scaled-fixtures.mjs. " +
        "Expectations are copied from feed/owed-risk.json at the feed's own clock; " +
        "the keeper test asserts the two still agree.",
      generatedAt: new Date(feed.clock * 1000).toISOString(),
      nowSec,
      fixtures: manifest,
    },
    null,
    2,
  )}\n`,
);

console.log(`\n${manifest.length} fixtures -> shared/vectors/scaled-raw/`);
console.log(`nowSec = ${nowSec} (the feed's own clock)`);
