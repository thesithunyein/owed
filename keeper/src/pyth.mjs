/**
 * The Pyth lane: which official feed describes each mint, and how far the
 * issuer's own quote sits from it.
 *
 * Why this belongs in Owed: the project answers "what is this token actually
 * worth?". Its multiplier reading is derived from mint state alone, so it can be
 * internally consistent and still wrong about the world. A second, independent
 * price for the same asset - published by a different party, with a publish time
 * attached - is the only way to notice that, and Pyth is the one place on Solana
 * where the reference price of the underlying *and* of the tokenized wrapper are
 * both published (`Equity.US.AAPL/USD`, `Crypto.AAPLX/USD`, `Crypto.AAPLX/AAPL.RR`).
 *
 * Two rules keep this lane honest:
 *
 *  1. **Prices require a key, so they are optional; the registry is not.**
 *     Since the Pyth Core upgrade (2026-08-26) every price endpoint answers 401
 *     without a Bearer key, while the feed catalogue stays open. So the mapping
 *     is built and committed unconditionally, and prices are attached only when
 *     a key is present. A lane that published a stale or invented price to look
 *     complete would be worse than one that says it is not configured.
 *  2. **Only like-for-like comparisons become numbers.** The issuer's quote is
 *     compared to Pyth's feed for the *same* asset (`Crypto.<SYM>/USD`). The
 *     underlying equity price is published as reference, never divided into the
 *     token's price, because the redemption rate's orientation cannot be
 *     validated without paid price access - and a derived number nobody can
 *     check is exactly what this repo does not ship.
 *
 * Zero dependencies: `fetch` is built into Node 18+.
 */

export const PYTH_CATALOGUE_URL =
  process.env.PYTH_CATALOGUE_URL || "https://hermes.pyth.network/v2/price_feeds";

/** Above this, the issuer's quote and Pyth's disagree by more than rounding. */
export const DIVERGENCE_TOLERANCE_PCT = 1.0;

/** The rule consumers apply, published in the feed beside the numbers. */
export const DIVERGENCE_RULE =
  "basisPct = (issuerQuoteMid / pythPrice - 1) * 100, where issuerQuoteMid is " +
  "(bid + ask) / 2 from the issuer's own list and pythPrice is the latest value " +
  "of the Pyth feed named in xstock.feedId";

/** The open catalogue: 1874 feeds in one request, no auth. */
export async function fetchCatalogue({ url = PYTH_CATALOGUE_URL } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`pyth catalogue ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error("pyth catalogue: unexpected payload");
  return json;
}

/**
 * Candidate feed symbols for one listed symbol.
 *
 * xStocks tickers carry a trailing `x` (`AAPLx`, `BRK.Bx`, `QQ.GBx`) and the
 * underlying ticker is what remains. The dots make this worth doing explicitly
 * rather than with a regex: `BRK.B` and `BRK.B` (stripped) are different keys.
 */
export function feedCandidates(symbol) {
  const base = symbol.replace(/x$/, "");
  const sym = symbol.toUpperCase();
  const baseUp = base.toUpperCase();
  const stripped = baseUp.replace(/\./g, "");
  return {
    base,
    xstock: [`Crypto.${sym}/USD`],
    // US listings first, then any market whose ticker matches.
    equity: [`Equity.US.${baseUp}/USD`],
    equityTicker: baseUp,
    // Deduplicated: for a dot-free ticker (`AAPL`) both forms are the same
    // string, and a candidate list that repeats itself overstates the search.
    redemptionRate: [...new Set([`Crypto.${sym}/${baseUp}.RR`, `Crypto.${sym}/${stripped}.RR`])],
  };
}

/**
 * Resolve one symbol against the catalogue. Returns nulls where Pyth has no
 * feed: coverage is a finding here, not a failure.
 */
export function resolveFeeds(catalogueIndex, symbol) {
  const c = feedCandidates(symbol);
  const pick = (candidates) => {
    for (const s of candidates) {
      const hit = catalogueIndex.bySymbol.get(s);
      if (hit) return hit;
    }
    return null;
  };
  // The equity feed for non-US listings is `Equity.<MIC>.<ticker>/<ccy>`, so a
  // miss on `Equity.US.` falls back to a ticker match across markets.
  const equity =
    pick(c.equity) ??
    catalogueIndex.equityByTicker.get(c.equityTicker) ??
    null;
  const map = (hit) =>
    hit
      ? {
          feedId: hit.id,
          symbol: hit.attributes.symbol,
          description: hit.attributes.description ?? null,
          marketOpen: hit.market_hours?.is_open ?? null,
        }
      : null;
  return {
    base: c.base,
    xstock: map(pick(c.xstock)),
    equity: map(equity),
    redemptionRate: map(pick(c.redemptionRate)),
  };
}

/** Index the catalogue for symbol and ticker lookups. */
export function indexCatalogue(catalogue) {
  const bySymbol = new Map();
  const equityByTicker = new Map();
  for (const f of catalogue) {
    const s = f?.attributes?.symbol;
    if (!s) continue;
    bySymbol.set(s, f);
    if (f.attributes.asset_type === "Equity") {
      // `Equity.US.AAPL/USD` -> ticker `AAPL`
      const m = s.match(/^Equity\.[^.]*\.(.+)\//);
      const ticker = m?.[1]?.toUpperCase();
      if (ticker && !equityByTicker.has(ticker)) equityByTicker.set(ticker, f);
    }
  }
  return { bySymbol, equityByTicker, size: catalogue.length };
}

/** Mid of the issuer's own bid/ask, or their single quoted price. */
export function quoteMid(asset) {
  const bid = Number(asset?.bid);
  const ask = Number(asset?.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
    return { mid: (bid + ask) / 2, source: "issuer bid/ask mid" };
  }
  const price = Number(asset?.tokenPrice ?? asset?.markPrice);
  if (Number.isFinite(price) && price > 0) {
    return { mid: price, source: asset?.tokenPrice != null ? "issuer token price" : "issuer mark price" };
  }
  return null;
}

/**
 * The comparison, in one place so the script and the guard cannot disagree.
 *
 * `basisPct` is rounded to 6 decimals before anything is decided from it. That
 * is not cosmetic: `(101 / 100 - 1) * 100` is `1.0000000000000009`, so a quote
 * sitting exactly on a 1% tolerance would otherwise be flagged or not depending
 * on how the division happened to round. Published precision is well below 6
 * decimals, so rounding first makes the flag follow the published number rather
 * than the binary representation behind it.
 */
export function basis(quote, reference, tolerancePct = DIVERGENCE_TOLERANCE_PCT) {
  if (!Number.isFinite(quote) || !Number.isFinite(reference) || reference <= 0) return null;
  const basisPct = round6((quote / reference - 1) * 100);
  return {
    basisPct,
    flagged: Math.abs(basisPct) > tolerancePct,
    direction: basisPct >= 0 ? "PREMIUM" : "DISCOUNT",
  };
}

/** Round to 6 decimals, normalising `-0` so a zero basis has one representation. */
function round6(n) {
  const r = Math.round(n * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

/**
 * One published row for one mint.
 *
 * `priceFor(feedId)` resolves an already-fetched price, or returns null when
 * nothing was fetched. Passing a resolver rather than a price keeps every feed
 * reference symmetric: a reader sees the same shape whether or not prices were
 * available, and a null price is visibly "not fetched" instead of absent.
 */
export function buildPythRow({
  issuer,
  symbol,
  mint,
  quote,
  xstock,
  equity,
  redemptionRate,
  priceFor = () => null,
  tolerancePct,
}) {
  const at = (feed) => {
    if (!feed) return null;
    const p = priceFor(feed.feedId) ?? null;
    return {
      feedId: feed.feedId,
      symbol: feed.symbol,
      price: p?.price ?? null,
      publishTime: p?.publishTime ?? null,
    };
  };

  const row = {
    issuer,
    symbol,
    mint,
    quote: quote ?? null,
    xstock: at(xstock),
    equity: at(equity),
    redemptionRate: at(redemptionRate),
  };
  if (!row.xstock) return row;

  // Only the same-asset comparison becomes a number, and only with a price.
  const reference = row.xstock.price;
  const b = quote && reference != null ? basis(quote.mid, reference, tolerancePct) : null;
  row.xstock.basisPct = b?.basisPct ?? null;
  row.xstock.flagged = b?.flagged ?? null;
  row.xstock.direction = b?.direction ?? null;
  return row;
}

/** Counts for the feed's `pyth` block and the pages. */
export function summarizePyth(rows) {
  const priced = rows.filter((r) => r.xstock && r.xstock.price != null);
  const flagged = priced.filter((r) => r.xstock.flagged);
  return {
    total: rows.length,
    priced: priced.length,
    flagged: flagged.length,
    withEquityReference: rows.filter((r) => r.equity).length,
    withRedemptionRate: rows.filter((r) => r.redemptionRate).length,
    worstBasisPct: priced.length
      ? Math.max(...priced.map((r) => Math.abs(r.xstock.basisPct)))
      : 0,
  };
}
