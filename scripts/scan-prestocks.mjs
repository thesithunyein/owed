/**
 * Scan every official PreStocks mint with the same classifier as the xStocks lane.
 *
 *   node scripts/fetch-prestocks.mjs   # refresh the token list (cached fallback)
 *   node scripts/scan-prestocks.mjs    # -> keeper/data/prestocks-scan.json
 *
 * Why this lane exists: the reader trap Owed measures is a property of the
 * Token-2022 Scaled UI Amount extension, not of one issuer. A second issuer
 * carrying the same defect is the difference between "xStocks has a bug" and
 * "this is how tokenized equity is issued today", and only the second one is a
 * finding about the ecosystem.
 *
 * `meta` carries the issuer's own published prices so the feed can show a
 * chain-derived figure next to the issuer's, without either overwriting the other.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyScaled } from "../keeper/src/scaled.mjs";
import { createRpc, scanMints } from "../keeper/src/scan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.OWED_RPC_URL || "https://api.mainnet-beta.solana.com";

const { assets, source, fetchedAt } = JSON.parse(
  readFileSync(join(root, "keeper", "data", "prestocks-solana.json"), "utf8")
);
const list = assets
  .filter((a) => a.mint)
  .map((a) => ({
    symbol: a.symbol,
    mint: a.mint,
    meta: {
      name: a.name ?? null,
      markPrice: a.markPrice ?? null,
      tokenPrice: a.tokenPrice ?? null,
      issuerSupply: a.issuerSupply ?? null,
      externalUrl: a.externalUrl ?? null,
    },
  }));
console.log(`scanning ${list.length} official PreStocks mints via ${RPC} …`);

const summary = await scanMints({
  list,
  rpc: createRpc(RPC),
  classify: classifyScaled,
  onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total}`),
});
console.log("");

summary.issuer = "prestocks";
summary.listSource = source;
summary.listFetchedAt = fetchedAt;

const out = join(root, "keeper", "data", "prestocks-scan.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary.stats));
console.log(`wrote ${out} (${summary.results.length} classified)`);
