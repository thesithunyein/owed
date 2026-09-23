/**
 * Fetch the official PreStocks token list into keeper/data/prestocks-solana.json.
 *
 *   node scripts/fetch-prestocks.mjs
 *
 * PreStocks publishes its catalogue at https://prestocks.com/api/prestocks with
 * a `contract_address` per token. That endpoint is the issuer's own, so the list
 * is the issuer's claim about their own catalogue - the same posture as
 * xstocks-solana.json.
 *
 * This file exists separately from the scan because the list and the on-chain
 * state refresh on different failure modes: if this endpoint is down, the
 * committed list still scans, and the scan stays reproducible in CI.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "keeper", "data", "prestocks-solana.json");
const API = process.env.PRESSTOCKS_API || "https://prestocks.com/api/prestocks";

const readExisting = () => {
  try {
    return JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    return null;
  }
};

let raw;
try {
  const res = await fetch(API, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  raw = await res.json();
} catch (e) {
  // Degrade to the committed list rather than emptying the lane: a fetch
  // failure is not evidence that the tokens stopped existing.
  const previous = readExisting();
  if (!previous) {
    console.error(`could not fetch ${API} (${e.message}) and no cached list exists`);
    process.exit(1);
  }
  console.warn(`could not fetch ${API} (${e.message}) - keeping ${previous.count} cached tokens`);
  process.exit(0);
}

if (!Array.isArray(raw) || raw.length === 0) {
  const previous = readExisting();
  if (!previous) {
    console.error(`unexpected payload from ${API}: not a non-empty array`);
    process.exit(1);
  }
  console.warn(`unexpected payload from ${API} - keeping ${previous.count} cached tokens`);
  process.exit(0);
}

// Mark prices are issuer-published context, not chain state, so they are kept
// beside the mint rather than mixed into the scan output.
const assets = raw
  .filter((t) => t.contract_address)
  .map((t) => ({
    symbol: t.symbol,
    name: t.name ?? null,
    mint: t.contract_address,
    markPrice: t.markPrice ?? null,
    tokenPrice: t.tokenPrice ?? null,
    issuerSupply: t.supply ?? null,
    externalUrl: t.external_url ?? null,
  }));

const doc = {
  fetchedAt: new Date().toISOString(),
  source: API,
  count: assets.length,
  assets,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(doc, null, 1));
console.log(`wrote ${OUT} (${assets.length} tokens: ${assets.map((a) => a.symbol).join(", ")})`);
