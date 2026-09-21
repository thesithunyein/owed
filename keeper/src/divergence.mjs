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
 * Fetch a Pyth price update via Hermes (public endpoint, no key needed).
 * `feedId` is the 0x-prefixed 32-byte id from the price-feeds API.
 * Returns { price, confidence, publishTime } with price scaled by 10^expo.
 */
export async function fetchPythPrice(feedId, { hermesUrl = "https://hermes.pyth.network" } = {}) {
  const url = `${hermesUrl}/v2/updates/price/latest?ids%5B%5C%5D=${encodeURIComponent(feedId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`hermes ${res.status}`);
  const json = await res.json();
  const p = json?.parsed?.[0]?.price;
  if (!p) return null;
  const scale = 10 ** p.expo;
  return {
    price: Number(p.price) * scale,
    confidence: Number(p.conf) * scale,
    publishTime: p.publish_time,
  };
}
