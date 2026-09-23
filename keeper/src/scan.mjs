/**
 * The scanner both issuer scans share.
 *
 * The corporate-actions defect Owed measures is a property of the Token-2022
 * Scaled UI Amount extension, not of one issuer's mint list. So there is exactly
 * one scan implementation here, and `scripts/scan-xstocks.mjs` and
 * `scripts/scan-prestocks.mjs` are thin wrappers that supply a list. Two copies
 * of this loop would drift, and the drift would show up as two issuers whose
 * findings were not measured the same way - which is the one thing a
 * cross-issuer finding cannot afford.
 *
 * Zero dependencies: Node 18+ `fetch` only.
 */

/** A minimal JSON-RPC client with retries, pinned to one endpoint. */
export function createRpc(url, { timeoutMs = 20_000, tries = 3 } = {}) {
  if (!url) throw new Error("createRpc needs a URL");
  return {
    url,
    async call(method, params) {
      let last;
      for (let t = 1; t <= tries; t++) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = await res.json();
          if (j.error) throw new Error(j.error.message);
          return j.result;
        } catch (e) {
          last = e;
          if (t === tries) break;
          await new Promise((r) => setTimeout(r, 800 * t));
        }
      }
      throw new Error(`${method} failed x${tries}: ${last?.message}`);
    },
  };
}

/**
 * Scan every mint in `list` and return the raw extension state for each.
 *
 * The output deliberately carries the RAW `scaledState` rather than our
 * verdict: the effective multiplier is time-dependent, so a stored answer rots
 * while a stored state stays recomputable against any clock.
 */
export async function scanMints({
  list,
  rpc,
  chunk = 100,
  classify,
  onProgress,
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const results = [];
  let failed = 0;

  for (let i = 0; i < list.length; i += chunk) {
    const batch = list.slice(i, i + chunk);
    let vals = null;
    try {
      const r = await rpc.call("getMultipleAccounts", [
        batch.map((a) => a.mint),
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]);
      vals = r.value;
    } catch (e) {
      // One bad chunk must not silently shrink the population: count the loss
      // so the caller can refuse to publish a scan that dropped mints.
      console.warn(`chunk @${i}: ${e.message}`);
      failed += batch.length;
      continue;
    }

    vals.forEach((v, k) => {
      if (!v) return;
      const ext = extract(v);
      if (!ext) return;
      results.push({
        symbol: batch[k].symbol,
        mint: batch[k].mint,
        // Issuer-side context travels with the record so the feed can label it
        // without a second lookup table that could disagree with the scan.
        ...(batch[k].meta ? { meta: batch[k].meta } : {}),
        decimals: ext.decimals,
        supply: ext.supply,
        scaledState: ext.scaled, // RAW on-chain Scaled UI Amount state
        security: {
          permanentDelegate: ext.permanentDelegate,
          pausable: ext.pausable,
          transferHook: ext.transferHook,
        },
      });
    });

    onProgress?.(Math.min(i + chunk, list.length), list.length);
  }

  const cls = (r) => classify(r.scaledState, nowSec, r.security);
  const stats = {
    readerTrap: results.filter((r) => cls(r)?.readerTrap).length,
    pending: results.filter((r) => cls(r)?.pending).length,
    pausable: results.filter((r) => r.security.pausable).length,
    permanentDelegate: results.filter((r) => r.security.permanentDelegate).length,
    paused: results.filter((r) => r.security.pausable?.paused).length,
  };

  return {
    scannedAt: new Date(nowSec * 1000).toISOString(),
    rpc: rpc.url,
    totalOfficial: list.length,
    totalRead: results.length,
    failed,
    stats,
    results,
  };
}

/** The extension fields the classifier needs, from a jsonParsed mint value. */
function extract(v) {
  const info = v?.data?.parsed?.info;
  if (!info) return null;
  const find = (name) =>
    info.extensions?.find((e) => e.extension === name)?.state || null;
  return {
    decimals: info.decimals,
    supply: info.supply,
    scaled: find("scaledUiAmountConfig"),
    permanentDelegate: find("permanentDelegate"),
    pausable: find("pausableConfig"),
    transferHook: find("transferHook"),
  };
}
