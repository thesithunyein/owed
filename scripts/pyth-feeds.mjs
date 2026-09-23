/**
 * Resolve every official mint to the Pyth feeds that describe it, keylessly.
 *
 *   node scripts/pyth-feeds.mjs      # -> keeper/data/pyth-feeds.json
 *
 * The feed catalogue is the one Pyth endpoint that needs no key (the price
 * endpoints have required a Bearer key since 2026-08-26), so this runs anywhere,
 * including CI, and its output is committed. It answers a question the price
 * lane cannot be built without, and which is worth publishing on its own:
 *
 *   For how many of these mints does a public, third-party reference price
 *   actually exist - the tokenized wrapper, the underlying equity, and the
 *   redemption rate between them?
 *
 * Coverage gaps are a finding, not an error: Pyth lists 1245 equity feeds, and
 * pre-IPO names (OpenAI, SpaceX) are private companies that have no listed
 * equity feed to publish.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchCatalogue, indexCatalogue, resolveFeeds } from "../keeper/src/pyth.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "keeper", "data", "pyth-feeds.json");

const readList = (...parts) => (existsSync(join(ROOT, ...parts)) ? JSON.parse(readFileSync(join(ROOT, ...parts), "utf8")) : null);

const xstocks = readList("keeper", "data", "xstocks-solana.json");
const prestocks = readList("keeper", "data", "prestocks-solana.json");

if (!xstocks || !prestocks) {
  console.error("both issuer lists must exist first: run scan-xstocks.mjs / fetch-prestocks.mjs");
  process.exit(1);
}

const catalogue = await fetchCatalogue();
const index = indexCatalogue(catalogue);
console.log(`pyth catalogue: ${index.size} feeds (${index.equityByTicker.size} equity tickers)`);

const lanes = [
  { issuer: "xstocks", assets: xstocks.assets ?? [] },
  { issuer: "prestocks", assets: prestocks.assets ?? [] },
];

const assets = [];
const coverage = {};

for (const lane of lanes) {
  const resolved = lane.assets
    .filter((a) => a.mint)
    .map((a) => ({ symbol: a.symbol, mint: a.mint, ...resolveFeeds(index, a.symbol) }));

  coverage[lane.issuer] = {
    total: resolved.length,
    xstockFeed: resolved.filter((r) => r.xstock).length,
    equityFeed: resolved.filter((r) => r.equity).length,
    redemptionRate: resolved.filter((r) => r.redemptionRate).length,
    unresolved: resolved.filter((r) => !r.xstock && !r.equity && !r.redemptionRate).map((r) => r.symbol).slice(0, 40),
  };
  for (const r of resolved) assets.push({ issuer: lane.issuer, ...r });

  const c = coverage[lane.issuer];
  console.log(
    `${lane.issuer}: ${c.total} mints | own-token feed ${c.xstockFeed} | ` +
      `underlying equity feed ${c.equityFeed} | redemption rate ${c.redemptionRate}`,
  );
}

const doc = {
  fetchedAt: new Date().toISOString(),
  source: "https://hermes.pyth.network/v2/price_feeds (open, no key)",
  catalogueSize: index.size,
  note:
    "Which official Pyth feed describes each mint. Feed existence and market " +
    "hours are Pyth metadata; no price is stored here, because prices require a " +
    "Bearer key. See keeper/data/pyth-divergence.json for the priced lane.",
  coverage,
  assets,
};

writeFileSync(OUT, JSON.stringify(doc, null, 1));
console.log(`\nwrote ${OUT} (${assets.length} mints resolved)`);
