import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DIVERGENCE_TOLERANCE_PCT,
  basis,
  buildPythRow,
  feedCandidates,
  indexCatalogue,
  quoteMid,
  resolveFeeds,
  summarizePyth,
} from "../src/pyth.mjs";

/**
 * Guards for the Pyth lane.
 *
 * The lane has two halves with different trust levels, and most of what can go
 * wrong is a confusion between them:
 *
 *   - the **registry** (which feed describes which mint) needs no key, is built
 *     from Pyth's open catalogue, and is committed. It is checkable offline.
 *   - the **prices** need a Bearer key that may not be configured. When it is
 *     not, the artifact must publish nothing numeric rather than something
 *     plausible, and the surfaces must say which state they are in.
 *
 * So the invariants here are: the registry is self-consistent, the divergences
 * recompute from their own published inputs, and an unconfigured lane carries no
 * numbers anywhere.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const REGISTRY = join(ROOT, "keeper", "data", "pyth-feeds.json");
const DIVERGENCE = join(ROOT, "keeper", "data", "pyth-divergence.json");
const FEED = join(ROOT, "feed", "owed-risk.json");
const WEB = join(ROOT, "web");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const hex64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------- unit level

test("pyth: candidates strip the wrapper suffix and keep dotted tickers", () => {
  const a = feedCandidates("AAPLx");
  assert.equal(a.base, "AAPL");
  assert.deepEqual(a.xstock, ["Crypto.AAPLX/USD"]);
  assert.deepEqual(a.equity, ["Equity.US.AAPL/USD"]);
  // Exactly one candidate: for a dot-free ticker both forms coincide, and a list
  // that repeats itself overstates the search it describes.
  assert.deepEqual(a.redemptionRate, ["Crypto.AAPLX/AAPL.RR"]);

  const b = feedCandidates("BRK.Bx");
  assert.equal(b.base, "BRK.B");
  assert.deepEqual(b.equity, ["Equity.US.BRK.B/USD"]);
  // A dotted ticker genuinely has two distinct forms, so both are searched.
  assert.deepEqual(b.redemptionRate, ["Crypto.BRK.BX/BRK.B.RR", "Crypto.BRK.BX/BRKB.RR"]);
});

test("pyth: resolution prefers the US equity listing, then any market", () => {
  const feed = (symbol, assetType = "Equity") => ({
    id: "a".repeat(64),
    market_hours: { is_open: true },
    attributes: { symbol, asset_type: assetType, description: symbol },
  });
  const index = indexCatalogue([
    feed("Equity.US.AAPL/USD"),
    feed("Equity.HK.0002/HKD"),
    feed("Crypto.AAPLX/USD", "Crypto"),
  ]);
  const us = resolveFeeds(index, "AAPLx");
  assert.equal(us.equity.symbol, "Equity.US.AAPL/USD");
  assert.equal(us.xstock.symbol, "Crypto.AAPLX/USD");

  // No US listing: the ticker match across markets is the fallback.
  const hk = resolveFeeds(index, "0002x");
  assert.equal(hk.equity.symbol, "Equity.HK.0002/HKD");
  assert.equal(hk.xstock, null, "a missing feed is null, not an error");
});

test("pyth: quote prefers the issuer bid/ask mid, then their single price", () => {
  assert.deepEqual(quoteMid({ bid: 100, ask: 102 }), { mid: 101, source: "issuer bid/ask mid" });
  assert.equal(quoteMid({ tokenPrice: 42.5 }).mid, 42.5);
  assert.equal(quoteMid({ markPrice: 10 }).mid, 10);
  assert.equal(quoteMid({}), null);
  // A one-sided or zeroed book is not a mid.
  assert.equal(quoteMid({ bid: 0, ask: 5, tokenPrice: 4 }).mid, 4);
});

test("pyth: basis flags at the tolerance and names the direction", () => {
  const near = basis(101, 100, 1);
  assert.equal(near.basisPct, 1, "a deviation on the tolerance is published as 1, not 1.0000000000000009");
  assert.equal(near.flagged, false, "the band is inclusive: 1% is not yet a disagreement");
  assert.equal(near.direction, "PREMIUM");
  const far = basis(110, 100, 1);
  assert.equal(far.flagged, true);
  assert.equal(far.basisPct, 10);
  assert.equal(basis(90, 100, 1).direction, "DISCOUNT");
  assert.equal(basis(100, 100, 1).flagged, false, "an exact match is not flagged");
  assert.equal(basis(100, 100, 1).basisPct, 0, "and normalises to a positive zero");
  assert.equal(basis(100, 0, 1), null, "a zero reference cannot be compared");

  // The flag must follow the published number, not the division behind it. These
  // ratios are all exactly at or just past the tolerance in decimal terms.
  assert.equal(basis(1.01, 1, 1).flagged, false, "1.01/1 is exactly 1%");
  assert.equal(basis(10.1, 10, 1).flagged, false);
  assert.equal(basis(0.3, 0.297, 1).flagged, true, "0.3/0.297 is 1.0101%, past the band");
});

test("pyth: a row without a price publishes no number, and keeps its feed id", () => {
  const row = buildPythRow({
    issuer: "xstocks",
    symbol: "AAPLx",
    mint: "MINT",
    quote: { mid: 118, source: "issuer bid/ask mid" },
    xstock: { feedId: "b".repeat(64), symbol: "Crypto.AAPLX/USD" },
    equity: { feedId: "c".repeat(64), symbol: "Equity.US.AAPL/USD" },
    redemptionRate: null,
    priceFor: () => null,
    tolerancePct: DIVERGENCE_TOLERANCE_PCT,
  });
  assert.equal(row.xstock.price, null);
  assert.equal(row.xstock.basisPct, null);
  assert.equal(row.xstock.flagged, null);
  assert.equal(row.xstock.feedId, "b".repeat(64), "the feed id still travels");
  assert.equal(row.redemptionRate, null);
  assert.equal(row.equity.symbol, "Equity.US.AAPL/USD");
});

test("pyth: a priced row derives its basis from the injected price", () => {
  const row = buildPythRow({
    issuer: "xstocks",
    symbol: "AAPLx",
    mint: "MINT",
    quote: { mid: 118, source: "issuer bid/ask mid" },
    xstock: { feedId: "b".repeat(64), symbol: "Crypto.AAPLX/USD" },
    equity: null,
    redemptionRate: null,
    priceFor: () => ({ price: 100, publishTime: 1_790_000_000 }),
    tolerancePct: DIVERGENCE_TOLERANCE_PCT,
  });
  assert.equal(row.xstock.price, 100);
  assert.ok(Math.abs(row.xstock.basisPct - 18) < 1e-9);
  assert.equal(row.xstock.flagged, true);
  assert.equal(row.xstock.direction, "PREMIUM");

  const summary = summarizePyth([row]);
  assert.equal(summary.priced, 1);
  assert.equal(summary.flagged, 1);
  assert.ok(Math.abs(summary.worstBasisPct - 18) < 1e-9);
});

test("pyth: an unpriced row is counted as unpriced, not as agreement", () => {
  const row = buildPythRow({
    issuer: "prestocks",
    symbol: "OPENAI",
    mint: "MINT",
    quote: { mid: 1048, source: "issuer token price" },
    xstock: null,
    equity: { feedId: "d".repeat(64), symbol: "Equity.Index.OPENAI/USD" },
    redemptionRate: null,
    priceFor: () => null,
  });
  assert.equal(row.xstock, null, "no same-asset feed means no comparison at all");
  const s = summarizePyth([row]);
  assert.equal(s.priced, 0);
  assert.equal(s.flagged, 0);
  assert.equal(s.withEquityReference, 1);
});

// ------------------------------------------------------------ committed data

const hasRegistry = existsSync(REGISTRY);

test("pyth registry: every feed id is a 64-hex id and coverage is derived", { skip: !hasRegistry }, () => {
  const reg = readJson(REGISTRY);
  assert.ok(Number.isInteger(reg.catalogueSize) && reg.catalogueSize > 100);
  assert.ok(reg.source.includes("price_feeds"));

  for (const a of reg.assets) {
    assert.ok(["xstocks", "prestocks"].includes(a.issuer), `${a.symbol} has a lane`);
    assert.ok(a.mint, `${a.symbol} has a mint`);
    for (const key of ["xstock", "equity", "redemptionRate"]) {
      const f = a[key];
      if (!f) continue;
      assert.match(f.feedId, hex64, `${a.symbol}.${key} feed id is 64 hex`);
      assert.equal(typeof f.symbol, "string");
    }
  }

  // Coverage must be a count of the rows, not a number typed beside them.
  for (const lane of ["xstocks", "prestocks"]) {
    const rows = reg.assets.filter((a) => a.issuer === lane);
    assert.equal(reg.coverage[lane].total, rows.length, `${lane} total`);
    assert.equal(reg.coverage[lane].xstockFeed, rows.filter((r) => r.xstock).length);
    assert.equal(reg.coverage[lane].equityFeed, rows.filter((r) => r.equity).length);
    assert.equal(reg.coverage[lane].redemptionRate, rows.filter((r) => r.redemptionRate).length);
  }
});

test("pyth registry: a resolved feed matches the mint it was resolved for", { skip: !hasRegistry }, () => {
  // Anti-typo: the feed symbol has to be the one this roster entry implies, so a
  // matcher that starts returning a neighbouring ticker cannot pass silently.
  const reg = readJson(REGISTRY);
  let checked = 0;
  for (const a of reg.assets) {
    if (a.xstock) {
      assert.equal(a.xstock.symbol.toUpperCase(), `CRYPTO.${a.symbol.toUpperCase()}/USD`, `${a.symbol}`);
      checked += 1;
    }
    if (a.redemptionRate) {
      assert.ok(
        a.redemptionRate.symbol.toUpperCase().startsWith(`CRYPTO.${a.symbol.toUpperCase()}/`),
        `${a.symbol} redemption rate belongs to the same wrapper`,
      );
    }
  }
  assert.ok(checked > 0, "the registry matched at least one same-asset feed");
});

test("pyth registry: pre-IPO wrappers have no same-asset feed", { skip: !hasRegistry }, () => {
  // A pinned property of the world rather than of our code: Pyth publishes feeds
  // for listed equities, and these are private companies. If that ever changes,
  // the lane should notice rather than quietly keep publishing a gap.
  const reg = readJson(REGISTRY);
  const pre = reg.assets.filter((a) => a.issuer === "prestocks");
  assert.ok(pre.length > 0);
  for (const a of pre) {
    assert.equal(a.xstock, null, `${a.symbol} has no wrapper feed`);
  }
});

const hasDivergence = existsSync(DIVERGENCE);

test("pyth divergence: the lane's status is one of the three it can be", { skip: !hasDivergence }, () => {
  const d = readJson(DIVERGENCE);
  assert.ok(["ok", "unconfigured", "error"].includes(d.status), `status ${d.status}`);
  assert.equal(typeof d.rule, "string");
  assert.equal(d.tolerancePct, DIVERGENCE_TOLERANCE_PCT);
});

test("pyth divergence: an unconfigured lane publishes no price anywhere", { skip: !hasDivergence }, () => {
  // This is the honesty invariant. A missing key must never look like a market
  // that agrees, and it must never produce a number to fill the gap.
  const d = readJson(DIVERGENCE);
  if (d.status === "ok") return;
  assert.deepEqual(d.rows, [], "no rows while the lane is not ok");
  assert.equal(d.pricedFeeds, 0);
  for (const row of d.rows) {
    assert.equal(row.xstock?.price ?? null, null);
  }
});

test("pyth divergence: every published basis recomputes from published inputs", { skip: !hasDivergence }, () => {
  const d = readJson(DIVERGENCE);
  if (d.status !== "ok") return;
  const reg = readJson(REGISTRY);
  const byMint = new Map(reg.assets.map((a) => [a.mint, a]));

  let priced = 0;
  for (const row of d.rows) {
    assert.ok(byMint.has(row.mint), `${row.symbol} is in the registry`);
    if (row.xstock?.price == null) continue;
    priced += 1;
    const b = basis(row.quote.mid, row.xstock.price, d.tolerancePct);
    assert.ok(
      Math.abs(b.basisPct - row.xstock.basisPct) < 1e-9,
      `${row.symbol} basis recomputes`,
    );
    assert.equal(row.xstock.flagged, b.flagged, `${row.symbol} flag follows the tolerance`);
  }
  assert.equal(d.summary.priced, priced, "summary counts the rows it summarises");
});

// --------------------------------------------------------------- feed wiring

const hasFeed = existsSync(FEED);

test("pyth: the feed carries the lane and states its status", { skip: !hasFeed }, () => {
  const feed = readJson(FEED);
  assert.ok(feed.pyth, "feed publishes a pyth block");
  assert.ok(["ok", "unconfigured", "error"].includes(feed.pyth.status));
  assert.equal(typeof feed.pyth.rule, "string");
  assert.ok(feed.pyth.coverage, "the lane reports its registry coverage even when unpriced");

  if (existsSync(DIVERGENCE)) {
    assert.equal(feed.pyth.status, readJson(DIVERGENCE).status, "feed and artifact agree");
  }
});

test("pyth: every row carries the same lane shape in both rosters", { skip: !hasFeed }, () => {
  const feed = readJson(FEED);
  const shape = (t) => Object.keys(t.pyth).sort().join(",");
  const rows = [...feed.tokens, ...(feed.preStocks ?? [])];
  const shapes = new Set(rows.map(shape));
  assert.equal(shapes.size, 1, `one pyth shape per row: ${[...shapes].join(" | ")}`);
  assert.deepEqual([...shapes], ["equity,redemptionRate,xstock"]);

  if (feed.pyth.status !== "ok") {
    for (const t of rows) {
      for (const key of ["xstock", "equity", "redemptionRate"]) {
        assert.equal(t.pyth[key]?.price ?? null, null, `${t.symbol}.${key} publishes no price`);
      }
    }
  }
});

test("pyth: the pages carry the lane and agree with its status", { skip: !hasFeed }, () => {
  const feed = readJson(FEED);
  const injected = (file, name) => {
    const src = readFileSync(join(WEB, file), "utf8");
    const re = new RegExp(`^const ${name} = /\\*__${name}__\\*/(.*);\\r?$`, "m");
    const m = src.match(re);
    assert.ok(m, `${file} carries ${name}`);
    return JSON.parse(m[1]);
  };

  const board = injected("board.html", "PYTH");
  assert.equal(board.status, feed.pyth.status, "the board states the real status");
  assert.equal(
    Object.keys(board.refs).length,
    (feed.tokens ?? []).concat(feed.preStocks ?? []).filter((t) => t.pyth?.xstock).length,
    "the board lists every mint with a same-asset feed",
  );

  const payload = injected("differential.html", "RISK");
  assert.equal(payload.pyth.status, feed.pyth.status, "the app states the real status");
  const refs = payload.tokens.filter((t) => t.pyth);
  assert.equal(refs.length, Object.keys(board.refs).length, "both pages agree on coverage");
  for (const t of payload.tokens) {
    if (!t.pyth) continue;
    assert.equal(typeof t.pyth.xstock, "string");
    if (payload.pyth.status !== "ok") assert.equal(t.pyth.price, null);
  }
});

test("pyth: both surfaces actually consume the lane, not just carry it", { skip: !hasFeed }, () => {
  // A payload nobody renders is not a surface. The lane has three honest states
  // and each page has to keep handling all three, so pin the handling itself:
  // the priced case, the reference-with-no-price case, and the status line.
  const board = readFileSync(join(WEB, "board.html"), "utf8");
  assert.match(board, /function pythFlag\(/, "the board has a per-row marker");
  assert.match(board, /ref\.price == null/, "and distinguishes no-price from a measured gap");
  assert.match(board, /PYTH\.status/, "and names the lane's state rather than going blank");
  assert.match(board, /ref\.flagged/, "and renders the flag when prices exist");

  const app = readFileSync(join(WEB, "differential.html"), "utf8");
  assert.match(app, /t\.pyth/, "the app reads the per-token lane");
  assert.match(app, /RISK\.pyth\?\.status/, "and states the lane's state on the card");
  assert.match(app, /ref\.basisPct/, "and shows the gap once priced");

  // `escapeHtml` is what keeps an interpolated feed symbol from becoming markup,
  // and it is not shared between the two files. This is a real bug that shipped:
  // the helper existed only in the app page while the board called it too.
  for (const file of ["board.html", "differential.html"]) {
    const src = readFileSync(join(WEB, file), "utf8");
    assert.match(src, /const escapeHtml =/, `${file} defines escapeHtml before using it`);
    const def = src.indexOf("const escapeHtml =");
    const use = src.indexOf("escapeHtml(", def + 1);
    assert.ok(use > def, `${file} defines escapeHtml before its first call`);
  }
});
