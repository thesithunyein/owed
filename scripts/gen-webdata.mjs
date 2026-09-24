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
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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

// Read once, at the top: both pages and the README are built from this one
// object, so they cannot disagree about the snapshot they describe.
const feed = readJsonIfPresent("feed", "owed-risk.json");

const boardPath = join(root, "web", "board.html");
let board = readFileSync(boardPath, "utf8");

/**
 * Replace one injected payload, matching the WHOLE line.
 *
 * This used to terminate at the first `;`, justified by "base58 never contains
 * `;`". That held until a payload carried a sentence with a semicolon in it: the
 * first run wrote the payload correctly, and every later run matched only as far
 * as that semicolon, replaced that prefix, and left the rest of the previous
 * payload behind. The page grew a few KB of trailing garbage per run and the
 * injected JSON stopped parsing - silently, from a script that reported success.
 *
 * `JSON.stringify` never emits a newline, so one payload is exactly one line,
 * and anchoring at both ends is both stricter and independent of the payload's
 * contents.
 */
function inject(src, name, value, file) {
  const re = new RegExp(`^(const ${name} = )/\\*__${name}__\\*/.*;\\r?$`, "m");
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

// The Pyth lane, trimmed to what the board renders: the lane's own state, its
// coverage counts, and the mints that have a same-asset feed (22 of 925). The
// other 638 equity references are a count, not a per-row string - they are in
// the feed for anyone who wants them.
const pyth = feed?.pyth ?? null;
const pythRefs = Object.fromEntries(
  (feed?.tokens ?? [])
    .concat(feed?.preStocks ?? [])
    .filter((t) => t.pyth?.xstock)
    // The comparison travels with the reference, not just its name, so the board
    // can show the gap once prices exist instead of only ever naming the feed.
    .map((t) => [
      t.mint,
      {
        symbol: t.pyth.xstock.symbol,
        price: t.pyth.xstock.price ?? null,
        basisPct: t.pyth.xstock.basisPct ?? null,
        flagged: t.pyth.xstock.flagged ?? null,
      },
    ]),
);
// Injected as an object even when the lane is absent, because a `null` payload
// is indistinguishable from a marker the generator never replaced - and the
// build guard explicitly treats `null` as un-injected.
board = inject(
  board,
  "PYTH",
  {
    status: pyth?.status ?? "unavailable",
    reason: pyth?.reason ?? "no feed/owed-risk.json pyth block: run scripts/pyth-feeds.mjs",
    coverage: pyth?.coverage ?? null,
    summary: pyth?.summary ?? null,
    tolerancePct: pyth?.tolerancePct ?? null,
    refs: pythRefs,
  },
  "board.html",
);
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
  // Same reason as PYTH: an object, not null, so the guard's "un-injected
  // marker" check keeps its meaning and the page can report the lane is absent.
  board = inject(board, "PRESTOCKS", { results: [], stats: null, absent: true }, "board.html");
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
  // The Pyth lane travels with the page so the card can name the reference for
  // a mint and, when prices exist, show the basis. Trimmed to the priced fields:
  // the feed ids are in the feed, and shipping 933 of them would double the page.
  const trimPyth = (t) =>
    t.pyth?.xstock
      ? {
          xstock: t.pyth.xstock.symbol,
          price: t.pyth.xstock.price ?? null,
          basisPct: t.pyth.xstock.basisPct ?? null,
          flagged: t.pyth.xstock.flagged ?? null,
          equity: t.pyth.equity?.symbol ?? null,
        }
      : null;
  const trimWithPyth = (t) => ({ ...trim(t), pyth: trimPyth(t) });
  const trimmed = {
    generatedAt: feed.generatedAt,
    clock: feed.clock,
    version: feed.version,
    source: { rpc: feed.source?.rpc ?? null },
    summary: feed.summary,
    issuers: feed.issuers ?? [],
    pyth: feed.pyth
      ? {
          status: feed.pyth.status,
          reason: feed.pyth.reason ?? null,
          rule: feed.pyth.rule,
          tolerancePct: feed.pyth.tolerancePct,
          coverage: feed.pyth.coverage ?? null,
          summary: feed.pyth.summary ?? null,
        }
      : null,
    tokens: [...feed.tokens.map(trimWithPyth), ...(feed.preStocks ?? []).map(trimWithPyth)],
  };
  diff = inject(diff, "RISK", trimmed, "differential.html");

  // --- static fallback: the page works before (or without) JavaScript ---------
  //
  // Everything on the front page used to render client-side, so any script
  // failure left a blank page. The generator now bakes the same numbers the
  // live classification would produce, between markers, and the page script
  // leaves them alone unless the viewer's clock disagrees with the feed's - in
  // which case the numbers would mislead, and re-rendering is correct.
  const genNow = feed.clock;
  const genNowMs = genNow * 1000;
  const genEffective = (state) => {
    const stored = Number(state.multiplier);
    if (state.newMultiplier == null || state.newMultiplierEffectiveTimestamp == null)
      return stored;
    return genNow >= Number(state.newMultiplierEffectiveTimestamp)
      ? Number(state.newMultiplier)
      : stored;
  };
  const genClassify = (t) => {
    const s = t.scaled?.state;
    if (!s || s.multiplier == null) return null;
    const stored = Number(s.multiplier);
    const eff = genEffective(s);
    const gap = eff / stored - 1;
    return {
      stored,
      eff,
      gap,
      stale: gap > 0,
      days: gap > 0 ? (genNow - Number(s.newMultiplierEffectiveTimestamp)) / 86400 : null,
    };
  };
  const genAll = [...feed.tokens, ...(feed.preStocks ?? [])].map((t) => ({
    t,
    c: genClassify(t),
  }));
  const genRows = genAll
    .filter((r) => r.c && r.c.stale)
    .sort((a, b) => b.c.gap - a.c.gap);
  const genEscape = (s) =>
    String(s).replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const genTag = (gapPct) => {
    const cls = gapPct >= 100 ? "hot" : gapPct >= 1 ? "warm" : "mild";
    const label = gapPct >= 900 ? "10x" : gapPct >= 100 ? "≥2x" : gapPct >= 1 ? "≥1%" : "<1%";
    return `<span class="tag ${cls}">${label}</span>`;
  };
  const genChips = (() => {
    // Same worst-of-each-lane rule as the page's examples(): a plain top-3 of
    // 10x and 5x splits hides the second issuer entirely.
    const worstX = genRows.find((r) => r.t.issuer !== "prestocks");
    const worstPre = genRows.find((r) => r.t.issuer === "prestocks");
    const chips = [...genRows.slice(0, 3), ...[worstX, worstPre].filter(Boolean)]
      .filter((r, i, self) => self.indexOf(r) === i)
      .sort((a, b) => b.c.gap - a.c.gap);
    return (
      "<span>Worst right now:</span> " +
      chips
        .map(
          (r) =>
            `<button type="button" class="chip" data-sym="${genEscape(r.t.symbol)}">` +
            `${genEscape(r.t.symbol)} <span>${(r.c.gap * 100).toFixed(0)}%</span></button>`,
        )
        .join("")
    );
  })();
  const genTable = () =>
    genRows
      .map(({ t, c }) => {
        const ctl = [];
        if (t.security.permanentDelegate) ctl.push("delegate");
        if (t.security.pauseAuthority) ctl.push("pause");
        return (
          `<tr><td>${genEscape(t.symbol)}</td>` +
          `<td class="num" title="exact: ${c.stored}">${Number(Number(c.stored).toPrecision(6))}</td>` +
          `<td class="num" title="exact: ${c.eff}">${Number(Number(c.eff).toPrecision(6))}</td>` +
          `<td class="num">${(c.gap * 100).toFixed(2)}% ${genTag(c.gap * 100)}</td>` +
          `<td class="num">${c.days == null ? "-" : Math.round(c.days)}</td>` +
          `<td class="mono">${ctl.join(" + ") || "-"}</td></tr>`
        );
      })
      .join("");
  const genStats = [
    ["Official mints scanned (both issuers)", genAll.length, ""],
    ["Stored field is not what applies", genRows.length, "hot"],
    ["Error ≥ 1% (the ones that bite)", genRows.filter((r) => r.c.gap >= 1).length, genRows.some((r) => r.c.gap >= 1) ? "hot" : "ok"],
    ["Worst error", genRows[0] ? Math.round(genRows[0].c.gap * 100) + "%" : "-", "hot"],
    ["Mints with a permanent delegate", `${genAll.filter((r) => r.t.security.permanentDelegate).length} / ${genAll.length}`, ""],
    ...(feed.issuers ?? []).map((i) => [
      `… on ${i.name} (${i.kind})`,
      `${i.trap} of ${i.total} out of date`,
      i.trap ? "hot" : "ok",
    ]),
  ]
    .map(
      ([k, v, cls]) =>
        `<div class="stat ${cls}"><b>${v}</b><span>${k}</span></div>`,
    )
    .join("");
  const genSub =
    `Feed generated <strong>${new Date(feed.generatedAt).toUTCString()}</strong> from ` +
    `<span class="mono">${genEscape(feed.source?.rpc || "mainnet RPC")}</span>, re-classified against your clock just now.`;
  // Clock-stability, honestly derived: the baked numbers survive the page's
  // live re-render check only when no activation timestamp sits within +/-48h
  // of the feed's clock - any reasonable viewer clock then classifies
  // identically. Near a boundary the page re-renders, which is the case where
  // static numbers could mislead.
  const nearBoundary = [...feed.tokens, ...(feed.preStocks ?? [])].some((t) => {
    const ts = Number(t.scaled?.state?.newMultiplierEffectiveTimestamp ?? 0);
    return ts > 0 && Math.abs(genNow - ts) < 48 * 3600;
  });
  const staticMatch = nearBoundary ? "0" : "1";
  const swapStatic = (src, marker, html) =>
    src.replace(
      new RegExp(`(<!-- owed:${marker}:start -->)[\\s\\S]*?(<!-- owed:${marker}:end -->)`, "m"),
      `$1${html}$2`,
    );
  diff = swapStatic(diff, "stats", genStats);
  diff = swapStatic(
    diff,
    "sub",
    `<span class="static-match">${staticMatch}</span>${genSub}`,
  );
  diff = swapStatic(diff, "chips", genChips);
  diff = swapStatic(
    diff,
    "hero-worst",
    genRows.length
      ? `<p class="hero-worst"><strong>${genRows.length} of ${genAll.length} mints</strong> read a different multiplier from the stored field than the runtime applies, worst: ` +
        genRows
          .filter((r) => r.c.gap >= 1)
          .slice(0, 4)
          .map((r) => `${genEscape(r.t.symbol)} ${(r.c.gap * 100).toFixed(0)}%`)
          .join(", ") +
        `.</p>`
      : "",
  );
  // Two counts live outside marker blocks and are set by script only, which
  // left the no-JS page reading "all - mints". Baked from the feed, re-matched
  // regardless of current content so reruns stay idempotent.
  const totalStr = genAll.length.toLocaleString("en-US");

  // The title and the OG card are the whole first impression for most readers of
  // a shared link, so they state the finding rather than a slogan. Written by the
  // generator for the same reason every other number here is: a hand-typed count
  // is wrong the first time a mint activates.
  const titleText = genRows.length
    ? `${genRows.length} of ${genAll.length}`
    : `all ${genAll.length} of`;
  // The marker holds the count and lives outside <title>, because <title> is
  // RCDATA: a comment inside it is not a comment, it is text, and the markers
  // would be visible in the browser tab and in every social card. The marker is
  // rewritten here and the three title strings are rewritten from it, so there is
  // still one source for the number and nothing rendered contains markup.
  // All three titles in one pass, with the trailing words anchored as the end of
  // the match. Anchoring on the tail is what stops the replacement from swallowing
  // the rest of the sentence: a pattern that consumed up to the closing quote and
  // then re-emitted only the count truncated two of the three titles to
  // "Owed - 383 of 933", which the guard test below caught immediately.
  diff = diff
    .replace(/(<!-- owed:title:start -->)[\s\S]*?(<!-- owed:title:end -->)/, `$1${titleText}$2`)
    .replace(
      /((?:<title>|property="og:title" content="|name="twitter:title" content=")Owed - )[^"<]*?( tokenized stocks)/g,
      `$1${titleText}$2`,
    );

  // The alert lane, as a strip.
  //
  // Read from the published document rather than re-deriving the events here:
  // the point of feed/alerts.json is that the site, a bot and a judge all see the
  // same thing, and a second derivation would be a second answer. Missing file is
  // a state, not an error - the aging snapshot is still current for the checker.
  let alertsDoc = null;
  try {
    alertsDoc = JSON.parse(readFileSync(join(root, "feed", "alerts.json"), "utf8"));
  } catch {
    alertsDoc = null;
  }
  const strip = [];
  const stamp = (sec) =>
    new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const until = (sec) => {
    const h = Math.round(sec / 3600);
    return h < 1 ? "under an hour" : h < 48 ? `${h}h` : `${Math.round(h / 24)} days`;
  };
  if (alertsDoc?.nextActivation) {
    const a = alertsDoc.nextActivation;
    strip.push(
      `<div class="alert-row now"><span class="kind">next activation</span><span>` +
        `<b>${genEscape(a.symbol)}</b>: a ${Number(Number(a.next).toPrecision(6))}x multiplier ` +
        `activates in ${until(a.secondsUntil)} (${stamp(a.activatesAt)}). The field reads ` +
        `${Number(Number(a.stored).toPrecision(6))}x today and will diverge from the runtime ` +
        `the moment it lands.</span></div>`,
    );
  }
  if (alertsDoc?.mostRecent) {
    const m = alertsDoc.mostRecent;
    const ago =
      m.daysAgo < 1
        ? `${Math.max(1, Math.round(m.daysAgo * 24))}h ago`
        : `${Math.round(m.daysAgo)} days ago`;
    strip.push(
      `<div class="alert-row now"><span class="kind">freshest</span><span>` +
        `<b>${genEscape(m.symbol)}</b> diverged ${ago}: the field reads ` +
        `${Number(Number(m.stored).toPrecision(6))}x and the runtime applies ` +
        `${Number(Number(m.effective).toPrecision(6))}x.</span></div>`,
    );
  }
  for (const h of (alertsDoc?.history ?? []).slice(0, 2)) {
    strip.push(
      `<div class="alert-row"><span class="when">${genEscape(
        String(h.at).replace("T", " ").slice(0, 16),
      )}</span><span class="kind">${genEscape(h.kind)}</span><span>${genEscape(h.message)}</span></div>`,
    );
  }
  if (!strip.length) {
    strip.push(
      alertsDoc
        ? `<p class="alert-none">Nothing to report. No mint changed state at the last refresh, and no activation lands in the next 48h. That is the lane working, not the lane failing.</p>`
        : `<p class="alert-none">The alert lane has not published yet. The checker above and the feed are current regardless.</p>`,
    );
  }
  diff = swapStatic(diff, "alerts", strip.join(""));
  diff = diff
    .replace(/(<span id="foldTotal">)[^<]*(<\/span>)/, `$1${totalStr}$2`)
    .replace(/(<span id="coverage">)[^<]*(<\/span>)/, `$1${totalStr}$2`);
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
    `> **${s.trap} of ${s.total} official xStocks carry a stored multiplier field that is not the\n` +
    `> value the Token-2022 runtime applies**\n` +
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
    `| **Reader traps** (activation passed, stored field no longer what applies) | **${s.trap}** |`,
    `| … off by **10x** (10-for-1 splits) | **${s.ge10x}** (${tenX.map((x) => `\`${x}\``).join(", ") || "none"}) |`,
    `| … off by **≥100%** | **${s.ge100}** |`,
    `| … off by **≥1%** | **${s.ge1}** |`,
    `| … off by **≥0.5%** | **${s.ge0_5}** |`,
    `| Median magnitude of the gap | **${median(stale.map((t) => Math.abs(t.trap.gapPct))).toFixed(2)}%** |`,
    `| Median time since the stored field diverged | **${Math.round(median(stale.map((t) => t.trap.daysStale)))} days** |`,
    `| Longest divergence | **${Math.round(longest.trap.daysStale)} days** (\`${longest.symbol}\`) |`,
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
      `(${s.trap}/${s.total} divergent at ${at})`
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

    // The same record, rendered as HTML for the Integrate page. That page's job is
    // to make the devnet deployment undeniable rather than to summarise it, so it
    // needs its own markup - but it must come from this one file, or the page and
    // the README drift and the guard below stops meaning anything.
    const REJECTED_HTML = {
      "snapshot_holders(short register)":
        "the program's own <code>SupplyMismatch</code>: a register that does not sum to supply cannot be recorded",
      "claim(replay)":
        "the receipt PDA already exists, so a settled claim can never be paid twice",
    };
    const htmlRows = report.steps
      .map((s) =>
        s.rejected
          ? `<tr><td>${s.label}</td><td><span class="tag no">rejected</span> ${
              REJECTED_HTML[s.label] ?? ""
            }</td></tr>`
          : `<tr><td>${s.label}</td><td class="mono"><a target="_blank" rel="noopener" href="https://explorer.solana.com/tx/${s.signature}?cluster=devnet">${s.signature.slice(
              0,
              18,
            )}…</a></td></tr>`,
      )
      .join("");
    const integratePath = join(root, "web", "integrate.html");
    if (existsSync(integratePath)) {
      const html = readFileSync(integratePath, "utf8");
      const marker = /<!-- owed:devnet-rows:start -->[\s\S]*?<!-- owed:devnet-rows:end -->/;
      if (!marker.test(html)) {
        throw new Error("web/integrate.html is missing the owed:devnet-rows block");
      }
      const filled = html.replace(
        marker,
        `<!-- owed:devnet-rows:start -->${htmlRows}<!-- owed:devnet-rows:end -->`,
      );
      if (filled !== html) {
        writeFileSync(integratePath, filled);
        console.log(`web/integrate.html: devnet table updated from ${newest}`);
      } else {
        console.log(`web/integrate.html: devnet table already current (${newest})`);
      }
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
