/**
 * Compare the issuer's own quote for each mint against Pyth's quote for the same
 * asset, and commit the result.
 *
 *   node scripts/pyth-divergence.mjs     # -> keeper/data/pyth-divergence.json
 *
 * Requires PYTH_API_KEY. Since the Pyth Core upgrade (2026-08-26) every price
 * endpoint answers 401 without a Bearer key, so this script cannot invent a
 * fallback: with no key it writes `status: "unconfigured"`, names the missing
 * secret, and publishes **zero** prices. An empty honest lane beats a populated
 * dishonest one, and the guard in keeper/test/pyth-lane.test.mjs enforces that
 * no row carries a number while the status is unconfigured.
 *
 * What the comparison is, precisely:
 *
 *   - `xstock` compares the issuer's quote for the token against Pyth's feed for
 *     the *same token* (`Crypto.AAPLX/USD`). Two published quotes for one asset.
 *   - `equity` and `redemptionRate` are published as **reference only**: the feed
 *     id, symbol and (when priced) the price. They are never divided into the
 *     token's price, because the redemption rate's orientation cannot be
 *     validated without paid price access, and this repo does not ship derived
 *     numbers nobody can check.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DIVERGENCE_RULE,
  DIVERGENCE_TOLERANCE_PCT,
  buildPythRow,
  quoteMid,
  summarizePyth,
} from "../keeper/src/pyth.mjs";
import { fetchPythPrices, PYTH_API_KEY_REQUIRED_SINCE } from "../keeper/src/divergence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "keeper", "data", "pyth-divergence.json");
const REGISTRY = join(ROOT, "keeper", "data", "pyth-feeds.json");

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const registry = readJson(REGISTRY);
if (!registry) {
  console.error("run scripts/pyth-feeds.mjs first (it needs no key)");
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const xstocks = readJson(join(ROOT, "keeper", "data", "xstocks-solana.json"));
const prestocks = readJson(join(ROOT, "keeper", "data", "prestocks-solana.json"));
const quotes = new Map([
  ...(xstocks?.assets ?? []).map((a) => [`xstocks:${a.symbol}`, a]),
  ...(prestocks?.assets ?? []).map((a) => [`prestocks:${a.symbol}`, a]),
]);

const feedIds = [
  ...new Set(
    registry.assets.flatMap((a) =>
      [a.xstock?.feedId, a.equity?.feedId].filter(Boolean).map((id) => `0x${id}`),
    ),
  ),
];

// Hermes rejects a very long ids[] list outright (a 677-id URL came back 520,
// which would have been reported as a Pyth outage when the real problem was the
// request). Chunked, it is a handful of well-formed calls.
const CHUNK = 50;

const base = {
  issuerScope: ["xstocks", "prestocks"],
  checkedAt: new Date(now * 1000).toISOString(),
  rule: DIVERGENCE_RULE,
  tolerancePct: DIVERGENCE_TOLERANCE_PCT,
  referenceOnly:
    "equity and redemptionRate feed ids are published as reference. Only the " +
    "xstock comparison (same asset, two sources) becomes a basis percentage.",
  coverage: registry.coverage,
  catalogueSize: registry.catalogueSize,
  catalogueFetchedAt: registry.fetchedAt,
};

const apiKey = process.env.PYTH_API_KEY;

if (!apiKey) {
  // Check the key before calling anything. Without this, a request that fails
  // for an unrelated reason would be reported as a Pyth outage - blaming the
  // vendor for our own missing configuration.
  const doc = {
    status: "unconfigured",
    reason:
      `PYTH_API_KEY is not set. Pyth price endpoints have required a Bearer key since ` +
      `${PYTH_API_KEY_REQUIRED_SINCE}; the feed catalogue (scripts/pyth-feeds.mjs) does not, ` +
      `so the registry and its coverage are still published. Add the key to the environment ` +
      `or as the PYTH_API_KEY repo secret to turn this lane on.`,
    ...base,
    pricedFeeds: 0,
    rows: [],
  };
  writeFileSync(OUT, JSON.stringify(doc, null, 1));
  console.warn("pyth: PYTH_API_KEY is not set - publishing no prices (status: unconfigured)");
  console.log(`wrote ${OUT}`);
  process.exit(0);
}

const prices = new Map();
try {
  for (let i = 0; i < feedIds.length; i += CHUNK) {
    const got = await fetchPythPrices(feedIds.slice(i, i + CHUNK));
    for (const [k, v] of got) prices.set(k, v);
  }
} catch (e) {
  // A key exists, so this is a genuine failure and must read like one.
  const doc = { status: "error", reason: e.message, ...base, pricedFeeds: 0, rows: [] };
  writeFileSync(OUT, JSON.stringify(doc, null, 1));
  console.error(`pyth: price fetch failed - ${e.message}`);
  console.log(`wrote ${OUT}`);
  process.exit(0);
}

const priceFor = (feedId) => prices.get(feedId.toLowerCase()) ?? null;
const rows = registry.assets.map((a) =>
  buildPythRow({
    issuer: a.issuer,
    symbol: a.symbol,
    mint: a.mint,
    quote: quoteMid(quotes.get(`${a.issuer}:${a.symbol}`) ?? {}),
    xstock: a.xstock,
    equity: a.equity,
    redemptionRate: a.redemptionRate,
    priceFor,
    tolerancePct: DIVERGENCE_TOLERANCE_PCT,
  }),
);

const summary = summarizePyth(rows);
const doc = {
  status: "ok",
  reason: null,
  ...base,
  feedIdsRequested: feedIds.length,
  pricedFeeds: prices.size,
  summary,
  rows,
};

writeFileSync(OUT, JSON.stringify(doc, null, 1));
console.log(
  `pyth: ${summary.priced} priced of ${summary.total} mints | flagged ${summary.flagged} | ` +
    `worst basis ${summary.worstBasisPct.toFixed(2)}% | equity reference ${summary.withEquityReference}`,
);
console.log(`wrote ${OUT}`);
