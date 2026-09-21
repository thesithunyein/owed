/**
 * Divergence monitor: compares a tokenized equity's on-chain price against
 * its underlying's Pyth reference, and flags mismatches after a recorded
 * corporate action (the "unadjusted split" screen).
 *
 * Zero dependencies: `fetch` is built into Node 18+.
 */

/**
 * Compute the expected post-action reference for a token given its
 * pre-action reference and the action. Returns null when the action
 * type is not price-relevant (e.g. ticker change).
 */
export function expectedReference(preReference, action) {
  switch (action.type) {
    case "SPLIT":
      return (preReference * action.ratioNum) / action.ratioDen;
    case "DIVIDEND":
      // Reference drops by roughly the per-token amount (classic
      // ex-dividend adjustment). Informational only.
      return preReference - action.amountPerToken;
    default:
      return null;
  }
}

/**
 * Flag a token whose market price diverges from its expected reference by
 * more than `tolerancePct` (percent, e.g. 1.0).
 */
export function flagDivergence({ tokenPrice, expectedReference, tolerancePct = 1.0 }) {
  if (expectedReference == null || expectedReference === 0) return null;
  const gapPct = ((tokenPrice - expectedReference) / expectedReference) * 100;
  return {
    gapPct,
    flagged: Math.abs(gapPct) > tolerancePct,
    direction: gapPct > 0 ? "PREMIUM" : "DISCOUNT",
  };
}

/**
 * Build a Hermes latest-price URL for one or more feed ids.
 * `ids[]` must reach the wire as a literally-repeated query key —
 * URLSearchParams does the encoding correctly (encodeURIComponent alone
 * double-encodes brackets and Hermes rejects it).
 *
 * Since the Pyth Core upgrade (Aug 26, 2026), price-data endpoints require
 * a Bearer API key. Metadata (price_feeds) stays open. Default host follows
 * the current docs; set HERMES_URL or pass hermesUrl to override.
 */
export const PYTH_API_KEY_REQUIRED_SINCE = "2026-08-26";

export function buildPythUrl(feedIds, { hermesUrl = process.env.HERMES_URL || "https://pyth.dourolabs.app/hermes" } = {}) {
  const params = new URLSearchParams();
  for (const id of feedIds) params.append("ids[]", id);
  return `${hermesUrl}/v2/updates/price/latest?${params.toString()}`;
}

/**
 * Fetch Pyth price updates via Hermes.
 * `feedIds` are 0x-prefixed 32-byte ids from the price-feeds API.
 * Auth: set PYTH_API_KEY in the env (or pass apiKey) — required since
 * 2026-08-26 for all price-data endpoints.
 * Returns a Map of feedId -> { price, confidence, publishTime, expo }
 * with price scaled by 10^expo.
 */
export async function fetchPythPrices(feedIds, { apiKey = process.env.PYTH_API_KEY, ...opts } = {}) {
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const res = await fetch(buildPythUrl(feedIds, opts), { headers });
  if (res.status === 401) {
    throw new Error(
      `hermes 401: Pyth requires an API key since ${PYTH_API_KEY_REQUIRED_SINCE} — set PYTH_API_KEY (https://docs.pyth.network/price-feeds/core/fetch-price-updates)`
  );
  }
  if (!res.ok) throw new Error(`hermes ${res.status}`);
  const json = await res.json();
  const out = new Map();
  for (const p of json?.parsed ?? []) {
    const scale = 10 ** p.price.expo;
    out.set(p.id, {
      price: Number(p.price.price) * scale,
      confidence: Number(p.price.conf) * scale,
      publishTime: p.price.publish_time,
      expo: p.price.expo,
    });
  }
  return out;
}

/** Single-feed convenience wrapper. */
export async function fetchPythPrice(feedId, opts = {}) {
  const m = await fetchPythPrices([feedId], opts);
  return m.get(feedId.toLowerCase()) ?? null;
}
