/**
 * Feed shaping, shared by every issuer lane.
 *
 * The feed publishes one row shape for all issuers so a consumer can iterate
 * `tokens` and `preStocks` with the same code. Two different shapes for two
 * issuers would mean the cross-issuer comparison the feed exists to support is
 * only apples-to-apples by convention rather than by construction.
 *
 * The raw `scaled.state` travels with every row: the effective multiplier is
 * time-dependent, so a consumer must be able to recompute it rather than trust
 * the stored answer. See risk-feed.mjs for the documented rule.
 */

import { effectiveMultiplier, readerTrapGap, summarize } from "./trap.mjs";

/** One feed row from one scan record. */
export function buildToken(rec, nowSecs, issuer) {
  const state = rec.scaledState ?? {};
  const gap = readerTrapGap(state, nowSecs);
  const security = rec.security ?? {};
  return {
    issuer,
    symbol: rec.symbol,
    mint: rec.mint,
    // Issuer-published context (prices, display name) when the issuer API
    // supplied it. Never chain state, so it is kept separate from `supply`.
    ...(rec.meta && Object.keys(rec.meta).length ? { meta: rec.meta } : {}),
    decimals: rec.decimals,
    supply: {
      raw: rec.supply,
    },
    scaled: {
      state: {
        multiplier: state.multiplier ?? null,
        newMultiplier: state.newMultiplier ?? null,
        newMultiplierEffectiveTimestamp: state.newMultiplierEffectiveTimestamp ?? null,
      },
      effectiveMultiplier: state.multiplier == null ? null : effectiveMultiplier(state, nowSecs),
    },
    trap: {
      stale: gap != null,
      gapPct: gap == null ? null : gap * 100,
      daysStale:
        state.newMultiplierEffectiveTimestamp == null || gap == null
          ? null
          : (nowSecs - Number(state.newMultiplierEffectiveTimestamp)) / 86_400,
    },
    security: {
      permanentDelegate: security.permanentDelegate?.delegate ?? null,
      pauseAuthority: security.pausable?.authority ?? null,
      paused: Boolean(security.pausable?.paused),
      transferHookAuthority: security.transferHook?.authority ?? null,
    },
  };
}

/** Rows for one issuer, worst gap first so the finding is the first thing read. */
export function buildTokens(scan, nowSecs, issuer) {
  return scan.results
    .map((rec) => buildToken(rec, nowSecs, issuer))
    .sort((a, b) => (b.trap.gapPct ?? -1) - (a.trap.gapPct ?? -1));
}

/**
 * A named issuer lane: the counts, plus where the lane came from, so a reader
 * can tell which of them is issuer-published and which is chain-derived.
 */
export function describeIssuer({ id, name, kind, list, scan, note }, records, nowSecs) {
  const summary = summarize(records, nowSecs);
  return {
    id,
    name,
    kind,
    ...(note ? { note } : {}),
    total: summary.total,
    trap: summary.trap,
    ge10x: summary.ge10x,
    ge100: summary.ge100,
    maxGapPct: summary.maxGapPct,
    permanentDelegate: summary.permanentDelegate,
    pauseAuthority: summary.pauseAuthority,
    paused: summary.paused,
    source: { list, scan },
  };
}
