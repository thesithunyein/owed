/**
 * The "reader trap" decision logic, isolated so it can be unit-tested.
 *
 * xStocks rebase through the Token-2022 Scaled UI Amount extension, which
 * stores a `multiplier` plus an optional `newMultiplier` with an activation
 * timestamp. The stored field is NOT self-maintaining: after the activation
 * passes, it keeps the old value until the issuer overwrites it, while the
 * runtime applies the effective value immediately.
 *
 * `effectiveMultiplier` below encodes the rule the chain follows. That rule
 * is verified against mainnet (not assumed) by `scripts/verify-trap.mjs`,
 * which compares it to `getTokenSupply`'s effective uiAmount.
 */

/** Tolerances for matching a measured ratio against a declared multiplier. */
export const MATCH_TOLERANCE = 1e-4; // 1 basis point

/**
 * The multiplier the runtime actually applies at `nowSecs`.
 *
 * `now >= newMultiplierEffectiveTimestamp` -> the pending value is live,
 * whether or not the stored field was ever updated.
 */
export function effectiveMultiplier(state, nowSecs) {
  if (!state || state.multiplier == null) {
    throw new Error("scaled state missing multiplier");
  }
  const stored = Number(state.multiplier);
  const pending =
    state.newMultiplier == null ? null : Number(state.newMultiplier);
  const activation =
    state.newMultiplierEffectiveTimestamp == null
      ? null
      : Number(state.newMultiplierEffectiveTimestamp);

  if (pending == null || activation == null) return stored;
  return nowSecs >= activation ? pending : stored;
}

/**
 * Are naive readers wrong right now?
 *
 * Returns null when there is nothing to be wrong about (no pending change,
 * or the pending change has not activated yet), otherwise the magnitude of
 * the error a stored-field reader makes, as a fraction (0.1 == 10%).
 */
export function readerTrapGap(state, nowSecs) {
  const effective = effectiveMultiplier(state, nowSecs);
  const stored = Number(state.multiplier);
  if (effective === stored) return null;
  const gap = effective / stored - 1;
  return gap > 0 ? gap : null;
}

/**
 * Classify a measured `ratio` (= live uiAmount / rawAmount) against the two
 * declared multipliers. This is how the thesis is falsified from evidence:
 * if the ratio matches the stored field, the trap is imaginary.
 */
export function matchVerdict(ratio, stored, pending, tolerance = MATCH_TOLERANCE) {
  const dStored = Math.abs(ratio / stored - 1);

  // With no pending change there is only one declared value, so a match
  // against it is not evidence either way. Reporting "thesis wrong" here
  // would read as a falsification when nothing was actually tested.
  if (pending == null) {
    return dStored < tolerance ? "AMBIGUOUS_EQUAL" : "NEITHER_MATCHES";
  }

  const dPending = Math.abs(ratio / pending - 1);
  if (dStored < tolerance && dPending < tolerance) return "AMBIGUOUS_EQUAL";
  if (dStored < tolerance) return "STALE_THESIS_WRONG";
  if (dPending < tolerance) return "STALE_CONFIRMED";
  return "NEITHER_MATCHES";
}

/**
 * Classify a whole scanned mint record at `nowSecs`.
 * `stale` means the stored field is no longer the effective one.
 */
export function classifyRecord(record, nowSecs) {
  const state = record?.scaledState;
  const gap = state == null ? null : readerTrapGap(state, nowSecs);
  const security = record?.security ?? {};
  return {
    symbol: record?.symbol ?? null,
    mint: record?.mint ?? null,
    gapFraction: gap,
    gapPct: gap == null ? null : gap * 100,
    stale: gap != null,
    hasPermanentDelegate: Boolean(security.permanentDelegate?.delegate),
    hasPauseAuthority: Boolean(security.pausable?.authority),
    paused: Boolean(security.pausable?.paused),
  };
}

/** Aggregate counts over a scan result set, at a given clock. */
export function summarize(records, nowSecs) {
  const out = {
    total: records.length,
    trap: 0,
    ge10x: 0,
    ge100: 0,
    ge1: 0,
    ge0_5: 0,
    permanentDelegate: 0,
    pauseAuthority: 0,
    paused: 0,
    maxGapPct: 0,
  };
  for (const r of records) {
    const c = classifyRecord(r, nowSecs);
    if (c.stale) {
      out.trap += 1;
      if (c.gapPct >= 900) out.ge10x += 1;
      if (c.gapPct >= 100) out.ge100 += 1;
      if (c.gapPct >= 1) out.ge1 += 1;
      if (c.gapPct >= 0.5) out.ge0_5 += 1;
      if (c.gapPct > out.maxGapPct) out.maxGapPct = c.gapPct;
    }
    if (c.hasPermanentDelegate) out.permanentDelegate += 1;
    if (c.hasPauseAuthority) out.pauseAuthority += 1;
    if (c.paused) out.paused += 1;
  }
  return out;
}
