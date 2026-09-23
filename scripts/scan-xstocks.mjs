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
 *
 * The scan loop itself lives in keeper/src/scan.mjs so the PreStocks lane runs
 * byte-identical logic. See scripts/scan-prestocks.mjs.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyScaled } from "../keeper/src/scaled.mjs";
import { createRpc, scanMints } from "../keeper/src/scan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.OWED_RPC_URL || "https://api.mainnet-beta.solana.com";

const { assets } = JSON.parse(
  readFileSync(join(root, "keeper", "data", "xstocks-solana.json"), "utf8")
);
const list = assets.filter((a) => a.mint).map((a) => ({ symbol: a.symbol, mint: a.mint }));
console.log(`scanning ${list.length} official xStocks mints via ${RPC} …`);

const summary = await scanMints({
  list,
  rpc: createRpc(RPC),
  classify: classifyScaled,
  onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total}`),
});
console.log("");

const out = join(root, "keeper", "data", "xstocks-scan.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary.stats));
console.log(`wrote ${out} (${summary.results.length} classified)`);
