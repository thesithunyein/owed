import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { effectiveMultiplier, summarize, MATCH_TOLERANCE } from "../src/trap.mjs";

/**
 * Guards for the second issuer lane.
 *
 * The published claim this file protects is not "PreStocks has a stale field" -
 * that is a fact about one roster. It is "the reader trap is a property of the
 * Token-2022 extension both issuers use". That claim survives only if the two
 * lanes are measured identically and if the second lane's verdicts are backed by
 * the runtime rather than by our own reader agreeing with itself.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FEED = join(ROOT, "feed", "owed-risk.json");
const SCHEMA = join(ROOT, "feed", "schema.json");
const SCAN = join(ROOT, "keeper", "data", "prestocks-scan.json");
const RUNTIME = join(ROOT, "keeper", "data", "prestocks-runtime.json");
const WEB = join(ROOT, "web");

const skip = !existsSync(FEED) || !existsSync(SCAN);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

test("preStocks: the lane is present in the feed", { skip }, () => {
  const feed = readJson(FEED);
  assert.ok(Array.isArray(feed.preStocks), "feed publishes a preStocks array");
  assert.equal(feed.preStocks.length, 8, "all 8 official PreStocks mints");
  for (const row of feed.preStocks) {
    assert.equal(row.issuer, "prestocks", `${row.symbol} is tagged with its issuer`);
  }
});

test("preStocks: both lanes publish one identical row shape", { skip }, () => {
  // Two shapes would make the cross-issuer comparison true only by convention.
  // `meta` (issuer-published context: display name, issuer's own prices) is the
  // one optional key, and only because the PreStocks API describes its tokens
  // and the xStocks list does not. Everything else must match exactly.
  const feed = readJson(FEED);
  const strip = (row) => {
    const { meta, ...rest } = row;
    void meta;
    return Object.keys(rest).sort().join(",");
  };
  const shapes = (rows) => new Set(rows.map(strip));
  const xShapes = shapes(feed.tokens);
  const pShapes = shapes(feed.preStocks);
  assert.equal(xShapes.size, 1, "one xStocks row shape");
  assert.equal(pShapes.size, 1, "one PreStocks row shape");
  assert.deepEqual([...pShapes], [...xShapes], "the same row shape in both lanes");

  // And the optional key must not leak into a lane whose issuer does not
  // publish it, so a consumer can rely on its absence meaning "not described".
  assert.equal(
    feed.preStocks.filter((t) => t.meta).length,
    feed.preStocks.length,
    "every PreStocks row carries its issuer-published context",
  );
});

test("preStocks: issuers[] counts match the lane arrays exactly", { skip }, () => {
  const feed = readJson(FEED);
  const scan = readJson(SCAN);
  assert.ok(Array.isArray(feed.issuers), "feed publishes issuers[]");

  for (const lane of [
    { id: "xstocks", rows: feed.tokens, records: readJson(join(ROOT, "keeper", "data", "xstocks-scan.json")).results },
    { id: "prestocks", rows: feed.preStocks, records: scan.results },
  ]) {
    const declared = feed.issuers.find((i) => i.id === lane.id);
    assert.ok(declared, `issuers[] describes ${lane.id}`);
    const recomputed = summarize(lane.records, feed.clock);
    assert.equal(declared.total, lane.rows.length, `${lane.id} total matches its array`);
    assert.equal(declared.trap, recomputed.trap, `${lane.id} trap count is derived`);
    assert.equal(declared.maxGapPct, recomputed.maxGapPct, `${lane.id} max gap is derived`);
    assert.equal(
      declared.permanentDelegate,
      recomputed.permanentDelegate,
      `${lane.id} permanent-delegate count is derived`,
    );
  }
  assert.equal(feed.summary.total, feed.tokens.length, "summary still describes tokens only");
});

test("preStocks: the two rosters share no mint", { skip }, () => {
  const feed = readJson(FEED);
  const x = new Set(feed.tokens.map((t) => t.mint));
  const overlap = feed.preStocks.filter((t) => x.has(t.mint));
  assert.deepEqual(overlap, [], "no mint appears in both lanes");
  const mints = feed.preStocks.map((t) => t.mint);
  assert.equal(new Set(mints).size, mints.length, "no duplicate PreStocks mints");
});

test("preStocks: every stale flag is recomputable from published state", { skip }, () => {
  // The row must be auditable: a consumer who distrusts the flag can derive it
  // from the raw state shipped beside it, at the clock the feed names.
  const feed = readJson(FEED);
  for (const t of feed.preStocks) {
    const { multiplier, newMultiplier, newMultiplierEffectiveTimestamp } = t.scaled.state;
    const recomputed = effectiveMultiplier(
      { multiplier, newMultiplier, newMultiplierEffectiveTimestamp },
      feed.clock,
    );
    assert.equal(recomputed, t.scaled.effectiveMultiplier, `${t.symbol} effective value`);
    assert.equal(
      t.trap.stale,
      recomputed !== Number(multiplier),
      `${t.symbol} stale flag follows the stored-vs-effective rule`,
    );
    if (t.trap.stale) {
      assert.ok(t.trap.gapPct > 0, `${t.symbol} stale implies a positive gap`);
      assert.ok(t.trap.daysStale >= 0, `${t.symbol} stale implies it is already in the past`);
    } else {
      assert.equal(t.trap.gapPct, null, `${t.symbol} clean implies gapPct null`);
    }
  }
});

test("preStocks: the scan and the feed agree on the roster", { skip }, () => {
  const feed = readJson(FEED);
  const scan = readJson(SCAN);
  assert.equal(feed.preStocks.length, scan.results.length);
  assert.equal(scan.totalOfficial, scan.results.length, "no mint was dropped during the scan");
  assert.equal(scan.failed, 0, "the scan reported no failed chunks");
  assert.deepEqual(
    feed.preStocks.map((t) => t.mint).sort(),
    scan.results.map((r) => r.mint).sort(),
  );
});

test(
  "preStocks: the runtime confirms the classifier on every mint",
  { skip: skip || !existsSync(RUNTIME) },
  () => {
    // This is the test that could falsify the lane: `measuredRatio` is what
    // `getTokenSupply` says the runtime applies, and `rulePredicts` is what our
    // reader says it applies. If they diverge, the second issuer was not
    // measured the way the feed claims, and the cross-issuer finding is void.
    const feed = readJson(FEED);
    const evidence = readJson(RUNTIME);
    const bySymbol = new Map(feed.preStocks.map((t) => [t.symbol, t]));

    assert.equal(evidence.mints.length, feed.preStocks.length, "every mint was checked");
    for (const m of evidence.mints) {
      const row = bySymbol.get(m.symbol);
      assert.ok(row, `${m.symbol} is in the feed`);

      assert.ok(
        Math.abs(m.measuredRatio / m.rulePredicts - 1) < MATCH_TOLERANCE,
        `${m.symbol}: chain applies ${m.measuredRatio}, our rule predicts ${m.rulePredicts}`,
      );

      if (row.trap.stale) {
        assert.equal(m.verdict, "STALE_CONFIRMED", `${m.symbol} stale is confirmed by the chain`);
        assert.ok(m.measuredRatio > 1, `${m.symbol} the runtime really is applying more than 1x`);
      } else {
        assert.notEqual(m.verdict, "STALE_CONFIRMED", `${m.symbol} is not stale`);
        assert.ok(
          Math.abs(m.measuredRatio - 1) < MATCH_TOLERANCE,
          `${m.symbol} clean means the chain applies 1x, measured ${m.measuredRatio}`,
        );
      }
    }

    // The evidence file's own tally must match its rows, or the summary a reader
    // sees first is describing a different measurement than the one recorded.
    const counted = evidence.mints.reduce((acc, m) => {
      acc[m.verdict] = (acc[m.verdict] ?? 0) + 1;
      return acc;
    }, {});
    assert.deepEqual(evidence.verdicts, counted);
    assert.ok(
      evidence.verdicts.STALE_CONFIRMED > 0,
      "the lane's finding still exists (otherwise the README claim is stale too)",
    );
  },
);

test("preStocks: the two issuers share the same control surfaces", { skip }, () => {
  // Generated rather than typed: this is the claim that the two rosters come
  // from one issuance template, and it must move with the scans.
  const feed = readJson(FEED);
  const pct = (rows) =>
    rows.filter((r) => r.security.permanentDelegate && r.security.pauseAuthority).length;
  assert.equal(pct(feed.preStocks), feed.preStocks.length, "every PreStocks mint is controlled");
  assert.equal(pct(feed.tokens), feed.tokens.length, "every xStocks mint is controlled");
});

test("preStocks: the published schema documents the lane", { skip }, () => {
  const schema = readJson(SCHEMA);
  assert.ok(schema.properties.preStocks, "schema describes preStocks");
  assert.ok(schema.properties.issuers, "schema describes issuers");
  assert.equal(schema.properties.preStocks.items.properties.issuer.const, "prestocks");
  assert.equal(schema.properties.tokens.items.properties.issuer.const, "xstocks");
});

test("preStocks: both pages carry the lane", { skip }, () => {
  const injected = (file) => {
    const src = readFileSync(join(WEB, file), "utf8");
    const out = {};
    // Line-anchored: one injected payload is one line, whatever characters it
    // contains. See the note in scripts/gen-webdata.mjs `inject`.
    const re = /^const\s+(\w+)\s*=\s*\/\*__\w+__\*\/(.*);\r?$/gm;
    for (const [, name, payload] of src.matchAll(re)) out[name] = payload;
    return { src, out };
  };

  const diff = injected("differential.html");
  const payload = JSON.parse(diff.out.RISK);
  const lane = payload.tokens.filter((t) => t.issuer === "prestocks");
  assert.equal(lane.length, 8, "the app can answer for every PreStocks mint");
  assert.equal(payload.issuers.length, 2, "the app names both issuers");
  assert.ok(
    /id="laneNote"/.test(diff.src),
    "the page shows which issuers it covers",
  );

  const board = injected("board.html");
  assert.ok(board.out.PRESTOCKS, "the board carries a PreStocks payload");
  assert.equal(JSON.parse(board.out.PRESTOCKS).results.length, 8);
  assert.ok(
    /<th>Issuer<\/th>/.test(board.src),
    "the board labels which issuer each row belongs to",
  );
});
