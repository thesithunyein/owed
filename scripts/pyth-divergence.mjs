/**
 * Compare the issuer's own quote for each mint against Pyth's quote for the same
 * asset, and commit the result.
 *
 *   node scripts/pyth-divergence.mjs     # -> keeper/data/pyth-divergence.json
 *
 * Prices come from Solana state, keyless: each feed's push-oracle account
 * (PDA of the Pyth push oracle program, seeds shard+feed id) is read with the
 * same `getMultipleAccounts` calls the rest of the keeper uses. Since the Pyth
 * Core upgrade (2026-08-26) the Hermes REST endpoints answer 401 without a
 * Bearer key, so REST is only a fallback for feeds the sponsor does not push:
 * if PYTH_API_KEY is set, feeds missing on-chain are re-fetched from Hermes and
 * their source is published per row. Without a key the lane still runs - it
 * simply publishes nothing for un-pushed feeds, and says so.
 *
 * What the comparison is, precisely:
 *
 *   - `xstock` compares the issuer's quote for the token against Pyth's feed for
 *     the *same token* (`Crypto.AAPLX/USD`). Two published quotes for one asset.
 *   - `equity` and `redemptionRate` are published as **reference only**: the feed
 *     id, symbol and (when priced) the price. They are never divided into the
 *     token's price, because the redemption rate's orientation cannot be
 *     validated, and this repo does not ship derived numbers nobody can check.
 *   - a basis is computed only against a reference young enough to witness the
 *     quote (FRESHNESS_BOUND_SEC). The sponsored push accounts are frequently
 *     not fresh: measured on 2026-09-23, 16 of the 17 priced xStock wrapper
 *     accounts carried a price 2 to 11 days old, with only TSLAx current.
 *     Comparing today's quote to an old price would manufacture divergence out
 *     of two clocks, so stale references publish their price with
 *     `staleReference: true` and no basis - which is why the lane can price 17
 *     feeds yet publish exactly one basis.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DIVERGENCE_RULE,
  DIVERGENCE_TOLERANCE_PCT,
  FRESHNESS_BOUND_SEC,
  buildPythRow,
  quoteMid,
  summarizePyth,
} from "../keeper/src/pyth.mjs";
import { fetchPythPrices, PYTH_API_KEY_REQUIRED_SINCE } from "../keeper/src/divergence.mjs";
import { fetchOnChainPrices } from "../keeper/src/pyth-onchain.mjs";

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
// Units, verified against a fresh third party rather than assumed: xStocks
// lists quotes in CENTS (AAPLx mid 33542.51 = $335.43, and the fresh
// Equity.US.SPCX/USD push account agreed with the cent-adjusted SPCXx mid to
// 0.17%), while PreStocks lists dollars. Scaling happens once, here, so every
// downstream consumer - feed, pages, guards - sees dollar quotes only.
const quotes = new Map([
  ...(xstocks?.assets ?? []).map((a) => [
    `xstocks:${a.symbol}`,
    {
      ...a,
      bid: a.bid != null ? a.bid / 100 : a.bid,
      ask: a.ask != null ? a.ask / 100 : a.ask,
      tokenPrice: a.tokenPrice != null ? a.tokenPrice / 100 : a.tokenPrice,
    },
  ]),
  ...(prestocks?.assets ?? []).map((a) => [`prestocks:${a.symbol}`, a]),
]);

const feedIds = [
  ...new Set(
    registry.assets.flatMap((a) =>
      [a.xstock?.feedId, a.equity?.feedId].filter(Boolean).map((id) => `0x${id}`),
    ),
  ),
];

// Primary source: the chain itself. One batched getMultipleAccounts sweep over
// every feed's push-oracle account; no key, same RPC as the rest of the keeper.
const prices = new Map();
let onchainErrors = 0;
try {
  const onchain = await fetchOnChainPrices(feedIds);
  for (const [k, v] of onchain) prices.set(k, { ...v, source: "onchain" });
} catch {
  // The RPC being down must not kill the lane if a Hermes key exists; fall
  // through and let the fallback decide what is knowable.
  onchainErrors = 1;
}

// Optional fallback: REST Hermes for feeds without a push account. Only runs
// when a key is present, so an unconfigured run stays fully keyless.
const apiKey = process.env.PYTH_API_KEY;
let hermesFetched = 0;
if (apiKey) {
  const missing = feedIds.filter((id) => !prices.has(id.toLowerCase()));
  for (let i = 0; i < missing.length; i += CHUNK) {
    try {
      const got = await fetchPythPrices(missing.slice(i, i + CHUNK));
      for (const [k, v] of got) prices.set(k, { ...v, source: "hermes" });
      hermesFetched += got.size;
    } catch (e) {
      // A failing fallback is reported in the artifact, not thrown: the lane's
      // job is to publish what it could see, and say what it could not.
      base.fallbackError = `hermes: ${e.message}`;
      break;
    }
  }
}

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

const apiKeyPrecheck = process.env.PYTH_API_KEY;

// Lookup normalises the `0x` prefix away: the registry stores bare hex, while
// the fetched map is keyed by the ids as requested (which carry the prefix).
const norm = (id) => id.replace(/^0x/, "").toLowerCase();
const priceFor = (feedId) => {
  const hit = prices.get(norm(feedId)) ?? prices.get(`0x${norm(feedId)}`) ?? null;
  return hit ? { ...hit, feedId: norm(feedId) } : null;
};
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
  status: prices.size > 0 ? "ok" : onchainErrors ? "error" : "unconfigured",
  reason:
    prices.size > 0
      ? null
      : onchainErrors
        ? "the Solana RPC rejected the push-oracle account reads"
        : `no push-oracle accounts exist for these feeds and PYTH_API_KEY is not set, so Hermes fallback is unavailable (Hermes has required a Bearer key since ${PYTH_API_KEY_REQUIRED_SINCE}). The registry and its coverage remain published.`,
  ...base,
  sources: { onchain: "push-oracle accounts via getMultipleAccounts, keyless", hermes: apiKeyPrecheck ? "REST fallback for feeds without a push account" : "not configured (no PYTH_API_KEY)" },
  freshnessBoundSec: FRESHNESS_BOUND_SEC,
  feedIdsRequested: feedIds.length,
  pricedFeeds: prices.size,
  hermesFetched,
  summary,
  rows,
};

writeFileSync(OUT, JSON.stringify(doc, null, 1));
console.log(
  `pyth: ${summary.priced} priced of ${summary.total} mints | flagged ${summary.flagged} | ` +
    `worst basis ${summary.worstBasisPct.toFixed(2)}% | equity reference ${summary.withEquityReference}`,
);
console.log(`wrote ${OUT}`);
