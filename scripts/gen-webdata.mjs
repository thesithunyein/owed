/**
 * Inject the official xStocks asset list AND the latest corporate-actions
 * scan into web/board.html (single self-contained file), and emit
 * web/data/assets.mjs for module-based consumers.
 *
 * Run from repo root:
 *   node scripts/scan-xstocks.mjs     # refresh keeper/data/xstocks-scan.json
 *   node scripts/gen-webdata.mjs      # inject into the board
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { assets } = JSON.parse(
  readFileSync(join(root, "keeper", "data", "xstocks-solana.json"), "utf8")
);
const compact = assets.filter((a) => a.mint).map((a) => [a.symbol, a.mint]);

let scan = null;
try {
  scan = JSON.parse(
    readFileSync(join(root, "keeper", "data", "xstocks-scan.json"), "utf8")
  );
} catch {
  console.warn("no xstocks-scan.json found — board will embed assets only");
}

const boardPath = join(root, "web", "board.html");
let board = readFileSync(boardPath, "utf8");

// Match `const NAME = /*__MARK__*/<anything>;` — base58 never contains `;`
// or `]`, so terminating on the first `];` is safe.
function inject(src, name, value) {
  const re = new RegExp(`(const ${name} = )/\\*__${name}__\\*/[\\s\\S]*?;`);
  if (!re.test(src)) throw new Error(`${name} marker missing from board.html`);
  return src.replace(re, `$1/*__${name}__*/${JSON.stringify(value)};`);
}

board = inject(board, "ASSETS", compact);
if (scan) {
  board = inject(
    board,
    "SCAN",
    {
      scannedAt: scan.scannedAt,
      rpc: scan.rpc,
      stats: scan.stats,
      results: scan.results,
    }
  );
}
writeFileSync(boardPath, board);

const js =
  "// Generated from keeper/data/ — do not edit by hand.\n" +
  "// Regenerate: node scripts/gen-webdata.mjs\n" +
  "export const ASSETS = " + JSON.stringify(compact) + ";\n";
mkdirSync(join(root, "web", "data"), { recursive: true });
writeFileSync(join(root, "web", "data", "assets.mjs"), js);

const kb = (board.length / 1024).toFixed(0);
console.log(
  `injected ${compact.length} assets` +
    (scan ? ` + ${scan.results.length} scan results` : "") +
    ` into web/board.html (${kb}KB) + web/data/assets.mjs`
);
