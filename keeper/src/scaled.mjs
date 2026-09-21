/**
 * Scaled UI Amount (Token-2022) corporate-actions reader — the core of Owed:
 * issuers (xStocks/Backed) rebase dividends and splits through the Scaled UI
 * Amount extension. The on-chain extension stores a
 * STALE `multiplier` plus a pending change with an activation timestamp;
 * the EFFECTIVE multiplier is time-dependent and must be computed:
 *
 *   effective(now) = now >= newMultiplierEffectiveTimestamp
 *                    ? newMultiplier : multiplier
 *
 * Applications that read the stored field alone compute the wrong *balance*
 * after every activation — verified against the runtime's own scaled amount on
 * all 925 official mints (see scripts/conformance.mjs). Note the precise claim:
 * the runtime applies the effective multiplier correctly, so this is a defect in
 * naive integrations, not in the chain, and it does not by itself imply that
 * venues price these tokens wrongly. This module is the correct reader, plus the
 * risk classification (reader-stale, pending activation, security surfaces).
 */

/**
 * Classification of a mint's corporate-action state.
 *
 * `security` must come from the mint's SEPARATE extensions (the output of
 * `extractExtensions`), not from the scaled state itself — the scaled UI
 * Amount config carries no security surfaces. Passing nothing reports none.
 */
export function classifyScaled(state, nowSec = Math.floor(Date.now() / 1000), security = {}) {
  if (!state) return null;
  const multiplier = Number(state.multiplier);
  const newMultiplier =
    state.newMultiplier != null ? Number(state.newMultiplier) : null;
  const effTs = Number(state.newMultiplierEffectiveTimestamp || 0);

  const effective = effTs > 0 && nowSec >= effTs ? newMultiplier : multiplier;

  // A "reader trap" exists when a naive consumer (reading the stored
  // `multiplier` field) would compute a different number than the
  // time-correct effective multiplier.
  const readerTrap = effTs > 0 && nowSec >= effTs && newMultiplier !== multiplier;
  const pending = effTs > 0 && nowSec < effTs && newMultiplier !== multiplier;

  return {
    multiplier,
    newMultiplier,
    effectiveTimestamp: effTs || null,
    effective,
    readerTrap,        // activation already passed — naive readers are wrong NOW
    pending,           // scheduled activation in the future
    deltaPct:
      newMultiplier != null && multiplier
        ? ((newMultiplier - multiplier) / multiplier) * 100
        : null,
    security: {
      permanentDelegate: !!security.permanentDelegate,
      pausable: !!security.pausable,
      paused: !!security.pausable?.paused,
      transferHook: security.transferHook?.programId || null,
    },
  };
}

/** Extract the raw extension states from a jsonParsed mint account value. */
export function extractExtensions(jsonParsedMintValue) {
  const info = jsonParsedMintValue?.data?.parsed?.info;
  if (!info) return null;
  const find = (name) =>
    info.extensions?.find((e) => e.extension === name)?.state || null;
  return {
    decimals: info.decimals,
    supply: info.supply,
    scaled: find("scaledUiAmountConfig"),
    pausable: find("pausableConfig"),
    permanentDelegate: find("permanentDelegate"),
    transferHook: find("transferHook"),
  };
}

/**
 * Full read for one mint: extension extract + classification + the
 * display math (raw vs scaled) consumers need.
 */
export function readScaledMint(jsonParsedMintValue, nowSec) {
  const ext = extractExtensions(jsonParsedMintValue);
  if (!ext) return null;
  const cls = classifyScaled(ext.scaled, nowSec, ext);
  return { ...ext, scaled: cls };
}

/** Scaled (display) amount from raw — the number wallets should show. */
export function scaledAmount(rawAmount, effectiveMultiplier) {
  return BigInt(rawAmount) * BigInt(Math.round(effectiveMultiplier * 1e9)) / 1_000_000_000n;
}
