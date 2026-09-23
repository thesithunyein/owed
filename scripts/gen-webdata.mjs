/**
 * Inject the official asset lists, both issuer scans, the risk feed, and the
 * conformance result into the web pages, so each one is a single
 * self-contained file that works from disk with no server.
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
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
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
  console.warn("no xstocks-scan.json found - board will embed assets only");
}

// The PreStocks lane, scanned by the same classifier. Optional at the file
// level: a clone without it still builds a board for the lane it has.
const preScan = readJsonIfPresent("keeper", "data", "prestocks-scan.json");

const boardPath = join(root, "web", "board.html");
let board = readFileSync(boardPath, "utf8");

// Match `const NAME = /*__MARK__*/<anything>;` - base58 never contains `;`
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
if (preScan) {
  board = inject(
    board,
    "PRESTOCKS",
    {
      scannedAt: preScan.scannedAt,
      rpc: preScan.rpc,
      listSource: preScan.listSource ?? null,
      stats: preScan.stats,
      results: preScan.results,
    },
    "board.html"
  );
} else {
  board = inject(board, "PRESTOCKS", null, "board.html");
}
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
  console.warn("no feed/owed-risk.json - run node scripts/risk-feed.mjs first");
} else {
  // The page only needs what it renders or recomputes; trimming keeps the
  // single-file page from carrying the full 700KB feed.
  //
  // Both issuer lanes travel in one `tokens` array, tagged with `issuer`, so the
  // page's search, card and sizing logic stay issuer-agnostic: a defect that is
  // a property of the Token-2022 extension should not need two code paths.
  const trim = (t) => ({
    issuer: t.issuer ?? null,
    symbol: t.symbol,
    mint: t.mint,
    name: t.meta?.name ?? null,
    scaled: { state: t.scaled.state, effectiveMultiplier: t.scaled.effectiveMultiplier },
    security: { permanentDelegate: t.security.permanentDelegate, pauseAuthority: t.security.pauseAuthority },
  });
  const trimmed = {
    generatedAt: feed.generatedAt,
    clock: feed.clock,
    version: feed.version,
    source: { rpc: feed.source?.rpc ?? null },
    summary: feed.summary,
    issuers: feed.issuers ?? [],
    tokens: [...feed.tokens.map(trim), ...(feed.preStocks ?? []).map(trim)],
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
  "// Generated from keeper/data/ - do not edit by hand.\n" +
  "// Regenerate: node scripts/gen-webdata.mjs\n" +
  "export const ASSETS = " + JSON.stringify(compact) + ";\n";
mkdirSync(join(root, "web", "data"), { recursive: true });
writeFileSync(join(root, "web", "data", "assets.mjs"), js);

// ---------------------------------------------------------------------------
// The README's numbers are generated as well
// ---------------------------------------------------------------------------
//
// The counts in the README move every time the snapshot refreshes, and the
// pages re-classify live, so hand-typed figures disagree with the site within
// one refresh cycle - they already did (`≥100%` read 5 in the README while the
// published feed said 4). So the headline block and the findings table are
// generated from the feed between markers, exactly like the pages, and
// keeper/test/build-integrity.test.mjs fails if either drifts out of agreement.

// `feed` is the same object the pages were just built from - one read, one
// source of truth, so the README and the pages cannot disagree.
let readmeChanged = false;

if (feed) {
  const s = feed.summary;
  const pre = feed.issuers?.find((i) => i.id === "prestocks") ?? null;
  const at = `${new Date(feed.clock * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const stale = feed.tokens.filter((t) => t.trap.stale);
  const stalePre = (feed.preStocks ?? []).filter((t) => t.trap.stale);
  const median = (xs) => {
    if (!xs.length) return 0;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const tenX = stale.filter((t) => t.trap.gapPct >= 900).map((t) => t.symbol);
  const longest = stale.reduce(
    (a, b) => (b.trap.daysStale > a.trap.daysStale ? b : a),
    stale[0]
  );

  const quote =
    `<!-- owed:stats:start -->\n` +
    `> **${s.trap} of ${s.total} official xStocks carry a stale on-chain multiplier field**\n` +
    `> (classified at ${at}); ${s.ge100} are off by 100% or more, and ${s.ge10x} by a full 10x.\n` +
    (pre
      ? `> The same defect is live on a second issuer: **${pre.trap} of ${pre.total} PreStocks mints**,\n` +
        `> which are tokenized pre-IPO equity rather than public equity. Same Token-2022 extension,\n` +
        `> same classifier, different issuer - so this is a property of how the assets are issued,\n` +
        `> not one vendor's mistake.\n`
      : "") +
    `> Not in theory: every mint was scanned and the effective value read from the chain.\n` +
    `<!-- owed:stats:end -->`;

  const rows = [
    `| Official xStocks Solana mints scanned | **${s.total}** |`,
    `| **Reader traps** (activation passed, stored field stale) | **${s.trap}** |`,
    `| … off by **10x** (10-for-1 splits) | **${s.ge10x}** (${tenX.map((x) => `\`${x}\``).join(", ") || "none"}) |`,
    `| … off by **≥100%** | **${s.ge100}** |`,
    `| … off by **≥1%** | **${s.ge1}** |`,
    `| … off by **≥0.5%** | **${s.ge0_5}** |`,
    `| Median magnitude of the gap | **${median(stale.map((t) => Math.abs(t.trap.gapPct))).toFixed(2)}%** |`,
    `| Median time already stale | **${Math.round(median(stale.map((t) => t.trap.daysStale)))} days** |`,
    `| Longest stale | **${Math.round(longest.trap.daysStale)} days** (\`${longest.symbol}\`) |`,
    `| Mints with a **permanent delegate** (issuer can move anyone's tokens) | **${s.permanentDelegate} / ${s.total}** |`,
    `| Mints with a **pause authority** (issuer can freeze all transfers) | **${s.pauseAuthority} / ${s.total}** |`,
    `| Currently paused | ${s.paused} |`,
    ...(pre
      ? [
          `| **PreStocks mints scanned** (tokenized pre-IPO equity) | **${pre.total}** |`,
          `| … of those, carrying the same stale multiplier field | **${pre.trap}** (${stalePre.map((x) => `\`${x.symbol}\``).join(", ")}) |`,
          `| … largest PreStocks gap | **${pre.maxGapPct.toFixed(0)}%** |`,
          `| PreStocks mints with a **permanent delegate** | **${pre.permanentDelegate} / ${pre.total}** |`,
        ]
      : []),
  ];
  const table = `<!-- owed:table:start -->\n${rows.join("\n")}\n<!-- owed:table:end -->`;

  const readmePath = join(root, "README.md");
  const before = readFileSync(readmePath, "utf8");
  const splice = (src, name, block) => {
    const start = `<!-- owed:${name}:start -->`;
    const end = `<!-- owed:${name}:end -->`;
    const re = new RegExp(`${start}[\\s\\S]*?${end}`);
    if (!re.test(src)) throw new Error(`README.md is missing the owed:${name} block`);
    return src.replace(re, block);
  };
  const after = splice(splice(before, "stats", quote), "table", table);
  if (after !== before) {
    writeFileSync(readmePath, after);
    readmeChanged = true;
  }
  console.log(
    `README.md: ${readmeChanged ? "numbers updated" : "numbers already current"} ` +
      `(${s.trap}/${s.total} stale at ${at})`
  );
}

// The devnet settlement table in README.md is generated from the committed
// evidence file for the same reason the numbers above are: it is a claim about a
// chain, and a hand-copied signature rots the moment a later run reuses the file.
// keeper/test/build-integrity.test.mjs fails the build if the two disagree, and
// checks that every devnet transaction the pages cite appears in the record.
{
  const docs = join(root, "docs");
  const newest = readdirSync(docs)
    .filter((f) => f.startsWith("devnet-settlement-") && f.endsWith(".json"))
    .sort()
    .at(-1);
  if (!newest) {
    console.warn("no docs/devnet-settlement-*.json - README settlement table left alone");
  } else {
    const report = JSON.parse(readFileSync(join(docs, newest), "utf8"));
    // The two paths that must refuse, in the words the test itself asserts.
    const REJECTED_NOTE = {
      "snapshot_holders(short register)":
        "**rejected** - the program's own `SupplyMismatch` (lib.rs:225): a register that does not sum to supply cannot be recorded",
      "claim(replay)":
        "**rejected** - the receipt PDA already exists, so a settled claim can never be paid twice",
    };
    const rows = report.steps.map((s) =>
      s.rejected
        ? `| ${s.label} | ${REJECTED_NOTE[s.label] ?? "**rejected**"} |`
        : `| ${s.label} | [${s.signature.slice(0, 16)}…](https://explorer.solana.com/tx/${s.signature}?cluster=devnet) |`,
    );
    const block =
      `<!-- owed:devnet-settlement:start -->\n` +
      `| step | devnet transaction |\n|---|---|\n` +
      `${rows.join("\n")}\n` +
      `<!-- owed:devnet-settlement:end -->`;

    const readmePath = join(root, "README.md");
    const src = readFileSync(readmePath, "utf8");
    const re = /<!-- owed:devnet-settlement:start -->[\s\S]*?<!-- owed:devnet-settlement:end -->/;
    if (!re.test(src)) throw new Error("README.md is missing the owed:devnet-settlement block");
    const after = src.replace(re, block);
    if (after !== src) {
      writeFileSync(readmePath, after);
      console.log(`README.md: devnet settlement table updated from ${newest}`);
    } else {
      console.log(`README.md: devnet settlement table already current (${newest})`);
    }
  }
}

const kb = (n) => (n / 1024).toFixed(0);
console.log(
  `board.html: ${compact.length} assets` +
    (scan ? ` + ${scan.results.length} scan results` : "") +
    (preScan ? ` + ${preScan.results.length} PreStocks results` : "") +
    ` (${kb(board.length)}KB)`,
);
console.log(
  `differential.html: ` +
    (feed
      ? `${feed.tokens.length} xStocks + ${(feed.preStocks ?? []).length} PreStocks tokens`
      : "no feed") +
    (conformance ? ` + conformance ${conformance.pass}/${conformance.checked}` : "") +
    ` (${kb(diff.length)}KB)`,
);
console.log(`web/data/assets.mjs written`);
