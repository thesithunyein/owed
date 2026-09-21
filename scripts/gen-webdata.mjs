/**
 * Inject the official xStocks asset list, the latest corporate-actions scan,
 * the risk feed, and the conformance result into the web pages, so each one is
 * a single self-contained file that works from disk with no server.
 *
 * Both pages re-classify against the viewer's clock on load, which is why they
 * carry the raw extension state rather than only our computed answer.
 *
 * Run from repo root:
 *   node scripts/scan-xstocks.mjs     # refresh keeper/data/xstocks-scan.json
 *   node scripts/risk-feed.mjs        # refresh feed/owed-risk.json
 *   node scripts/conformance.mjs      # refresh keeper/data/conformance.json
 *   node scripts/gen-webdata.mjs      # inject into the pages
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
function inject(src, name, value, file) {
  const re = new RegExp(`(const ${name} = )/\\*__${name}__\\*/[\\s\\S]*?;`);
  if (!re.test(src)) throw new Error(`${name} marker missing from ${file}`);
  return src.replace(re, `$1/*__${name}__*/${JSON.stringify(value)};`);
}

/** Optional artifact: missing files degrade to null rather than failing. */
function readJsonIfPresent(...parts) {
  try {
    return JSON.parse(readFileSync(join(root, ...parts), "utf8"));
  } catch {
    return null;
  }
}

board = inject(board, "ASSETS", compact, "board.html");
if (scan) {
  board = inject(
    board,
    "SCAN",
    {
      scannedAt: scan.scannedAt,
      rpc: scan.rpc,
      stats: scan.stats,
      results: scan.results,
    },
    "board.html"
  );
}
writeFileSync(boardPath, board);

// --- differential.html: the harm page ---------------------------------------

const diffPath = join(root, "web", "differential.html");
let diff = readFileSync(diffPath, "utf8");

const feed = readJsonIfPresent("feed", "owed-risk.json");
// Prefer the full sweep; the stratified sample is the fallback.
const conformance =
  readJsonIfPresent("keeper", "data", "conformance-all.json") ??
  readJsonIfPresent("keeper", "data", "conformance.json");

if (!feed) {
  console.warn("no feed/owed-risk.json — run node scripts/risk-feed.mjs first");
} else {
  // The page only needs what it renders or recomputes; trimming keeps the
  // single-file page from carrying the full 700KB feed.
  const trimmed = {
    generatedAt: feed.generatedAt,
    clock: feed.clock,
    version: feed.version,
    source: { rpc: feed.source?.rpc ?? null },
    summary: feed.summary,
    tokens: feed.tokens.map((t) => ({
      symbol: t.symbol,
      mint: t.mint,
      scaled: { state: t.scaled.state, effectiveMultiplier: t.scaled.effectiveMultiplier },
      security: { permanentDelegate: t.security.permanentDelegate, pauseAuthority: t.security.pauseAuthority },
    })),
  };
  diff = inject(diff, "RISK", trimmed, "differential.html");
}

if (conformance) {
  diff = inject(
    diff,
    "CONFORMANCE",
    {
      checked: conformance.checked,
      pass: conformance.pass,
      tolerance: conformance.tolerance,
      mode: conformance.mode,
      errored: conformance.errored ?? 0,
      generatedAt: conformance.generatedAt,
    },
    "differential.html"
  );
}
writeFileSync(diffPath, diff);

const js =
  "// Generated from keeper/data/ — do not edit by hand.\n" +
  "// Regenerate: node scripts/gen-webdata.mjs\n" +
  "export const ASSETS = " + JSON.stringify(compact) + ";\n";
mkdirSync(join(root, "web", "data"), { recursive: true });
writeFileSync(join(root, "web", "data", "assets.mjs"), js);

const kb = (n) => (n / 1024).toFixed(0);
console.log(
  `board.html: ${compact.length} assets` +
    (scan ? ` + ${scan.results.length} scan results` : "") +
    ` (${kb(board.length)}KB)`,
);
console.log(
  `differential.html: ` +
    (feed ? `${feed.tokens.length} tokens` : "no feed") +
    (conformance ? ` + conformance ${conformance.pass}/${conformance.checked}` : "") +
    ` (${kb(diff.length)}KB)`,
);
console.log(`web/data/assets.mjs written`);
