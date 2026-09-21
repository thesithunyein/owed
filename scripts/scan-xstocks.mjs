/**
 * Full corporate-actions scan of every official xStocks Solana mint.
 * Run from Node (public RPCs 403 browser origins, so this cannot be done
 * client-side without a paid RPC):
 *
 *   node scripts/scan-xstocks.mjs
 *
 * Reads keeper/data/xstocks-solana.json (925 official mints), fetches each
 * Token-2022 mint account via getMultipleAccounts (jsonParsed), classifies
 * the Scaled UI Amount state, and writes keeper/data/xstocks-scan.json.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyScaled, extractExtensions } from "../keeper/src/scaled.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.OWED_RPC_URL || "https://api.mainnet-beta.solana.com";
const CHUNK = 100;

const { assets } = JSON.parse(
  readFileSync(join(root, "keeper", "data", "xstocks-solana.json"), "utf8")
);
const list = assets.filter((a) => a.mint).map((a) => ({ symbol: a.symbol, mint: a.mint }));
console.log(`scanning ${list.length} official xStocks mints via ${RPC} …`);

async function rpcCall(method, params, tries = 3) {
  for (let t = 1; t <= tries; t++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) {
      if (t === tries) throw new Error(`${method} failed ×${tries}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 800 * t));
    }
  }
}

const nowSec = Math.floor(Date.now() / 1000);
const results = [];
let failed = 0;

for (let i = 0; i < list.length; i += CHUNK) {
  const batch = list.slice(i, i + CHUNK);
  let vals = null;
  try {
    const r = await rpcCall("getMultipleAccounts", [
      batch.map((a) => a.mint),
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    vals = r.value;
  } catch (e) {
    console.warn(`chunk @${i}: ${e.message}`);
    failed += batch.length;
    continue;
  }
  vals.forEach((v, k) => {
    if (!v) return;
    const ext = extractExtensions(v);
    if (!ext) return;
    results.push({
      symbol: batch[k].symbol,
      mint: batch[k].mint,
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
  process.stdout.write(`\r  ${Math.min(i + CHUNK, list.length)}/${list.length}`);
}
console.log("");

const summary = {
  scannedAt: new Date(nowSec * 1000).toISOString(),
  rpc: RPC,
  totalOfficial: list.length,
  totalRead: results.length,
  failed,
  stats: (() => {
    const cls = (r) => classifyScaled(r.scaledState, nowSec, r.security);
    return {
      readerTrap: results.filter((r) => cls(r)?.readerTrap).length,
      pending: results.filter((r) => cls(r)?.pending).length,
      pausable: results.filter((r) => r.security.pausable).length,
      permanentDelegate: results.filter((r) => r.security.permanentDelegate).length,
      paused: results.filter((r) => r.security.pausable?.paused).length,
    };
  })(),
  results,
};

const out = join(root, "keeper", "data", "xstocks-scan.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary.stats));
console.log(`wrote ${out} (${results.length} classified)`);
