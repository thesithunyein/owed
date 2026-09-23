import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "..", "web");
const ROOT = join(HERE, "..", "..");

/**
 * The pages are shipped as single files that must work from disk — no server, no
 * network, no sibling files. A generator that fails to inject leaves a marker
 * that looks harmless in a diff and produces a blank page in front of a judge,
 * so these guards run in CI.
 */
const PAGES = ["board.html", "differential.html"];

test("README numbers match the published feed", () => {
  // The README quotes counts that change with every snapshot refresh, and it
  // quoted them by hand. That already went wrong: it advertised "off by ≥100%:
  // 5" while the feed one directory away published 4, and a scheduled refresh
  // would have widened the gap while the README looked authoritative.
  //
  // gen-webdata.mjs now writes those numbers between markers. This checks the
  // committed README against the committed feed, so a hand edit or a skipped
  // regeneration fails the build instead of shipping a wrong number.
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const feed = JSON.parse(readFileSync(join(ROOT, "feed", "owed-risk.json"), "utf8"));
  const s = feed.summary;

  const block = (name) => {
    const m = readme.match(
      new RegExp(`<!-- owed:${name}:start -->([\\s\\S]*?)<!-- owed:${name}:end -->`),
    );
    assert.ok(m, `README.md has the owed:${name} block`);
    return m[1];
  };

  const stats = block("stats");
  assert.match(stats, new RegExp(`\\b${s.trap} of ${s.total}\\b`), "headline stale count");
  assert.match(stats, new RegExp(`\\b${s.ge100}\\b`), "headline ≥100% count");
  assert.match(stats, new RegExp(`\\b${s.ge10x}\\b`), "headline 10x count");

  // The counts alone are not enough. They can hold steady across a refresh
  // while the time quoted in the same sentence rots, and that is exactly what
  // happened: the README advertised a 15:49 classification while the feed and
  // the board it describes said 17:11, because the refresh workflow
  // regenerated the pages but not this file. Every number here is derived, so
  // the derivation's clock has to be checked too.
  const at = `${new Date(feed.clock * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  assert.ok(
    stats.includes(`classified at ${at}`),
    `the README quotes the feed's own classification time (${at})`,
  );

  const table = block("table");
  const cells = table
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|")[2]?.replace(/[*`]/g, "").trim() ?? "");
  // 12 xStocks rows, then the PreStocks lane's rows. The lane appended rather
  // than replacing anything, so the indices above keep their meaning.
  assert.equal(cells.length, 16, "the findings table has all 16 rows");
  assert.equal(cells[0], String(s.total));
  assert.equal(cells[1], String(s.trap));
  assert.ok(cells[2].startsWith(String(s.ge10x)));
  assert.equal(cells[3], String(s.ge100));
  assert.equal(cells[4], String(s.ge1));
  assert.equal(cells[5], String(s.ge0_5));
  assert.equal(cells[9], `${s.permanentDelegate} / ${s.total}`);
  assert.equal(cells[10], `${s.pauseAuthority} / ${s.total}`);
  assert.equal(cells[11], String(s.paused));

  // The second issuer's numbers are asserted too, because the README's headline
  // sentence now makes a cross-issuer claim and a hand edit there would be
  // exactly the kind of drift these blocks exist to prevent.
  const pre = feed.issuers?.find((i) => i.id === "prestocks");
  if (pre) {
    assert.equal(cells[12], String(pre.total), "PreStocks mints scanned");
    assert.ok(
      cells[13].startsWith(String(pre.trap)),
      "PreStocks stale count matches the feed",
    );
    assert.equal(cells[14], `${pre.maxGapPct.toFixed(0)}%`);
    assert.equal(cells[15], `${pre.permanentDelegate} / ${pre.total}`);
    assert.ok(
      stats.includes(`**${pre.trap} of ${pre.total} PreStocks mints**`),
      "the headline names the second issuer",
    );
  }
});

test("generated pages exist", () => {
  for (const p of PAGES) {
    assert.ok(existsSync(join(WEB, p)), `${p} exists`);
  }
});

test("no un-injected generator marker remains", () => {
  // A marker that still holds `null` was never replaced by gen-webdata.mjs.
  const stale = /const\s+\w+\s*=\s*\/\*__\w+__\*\/\s*null\s*;/g;
  for (const p of PAGES) {
    const src = readFileSync(join(WEB, p), "utf8");
    const hits = src.match(stale) ?? [];
    assert.deepEqual(hits, [], `${p} has un-injected markers: ${hits.join(", ")}`);
  }
});

test("substituted payloads parse as JSON", () => {
  const src = readFileSync(join(WEB, "differential.html"), "utf8");
  // Line-ending agnostic: these files are rewritten by tools on both Windows
  // and Linux, so assuming LF here would make the guard pass or fail based on
  // checkout settings rather than on the content.
  // Line-anchored, so a payload containing a semicolon (a sentence in a reason
  // string, say) is read whole instead of being truncated at that character.
  // Truncating here would make this guard parse a prefix and report a failure
  // that has nothing to do with the payload's real contents.
  const re = /^const\s+(\w+)\s*=\s*\/\*__\w+__\*\/(.*);\r?$/gm;
  let found = 0;
  for (const [, name, payload] of src.matchAll(re)) {
    if (payload === "null") continue;
    assert.doesNotThrow(
      () => JSON.parse(payload),
      `${name} payload is valid JSON`,
    );
    found += 1;
  }
  assert.ok(found >= 1, "at least one payload was injected");
});/**
 * Extract resource URLs that a page *loads* (affects rendering) and narrow the
 * match down to just the URL — matching whole tags makes every downstream check
 * vacuous because the string starts with "<".
 */
function loadedResourceUrls(src) {
  const patterns = [
    /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/g,
    /<img[^>]*\bsrc\s*=\s*["']([^"']+)["']/g,
    /<link[^>]*\bhref\s*=\s*["']([^"']+)["']/g,
    /<source[^>]*\bsrc\s*=\s*["']([^"']+)["']/g,
    /<video[^>]*\bsrc\s*=\s*["']([^"']+)["']/g,
    /<video[^>]*\bposter\s*=\s*["']([^"']+)["']/g,
    /@import\s+["']([^"']+)["']/g,
  ];
  const urls = [];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) urls.push(m[1]);
  }
  return urls;
}

test("both pages load no EXTERNAL resources (relative site assets are fine)", () => {
  for (const p of PAGES) {
    const src = readFileSync(join(WEB, p), "utf8");
    const urls = loadedResourceUrls(src);

    // Sanity: the extractor itself must be finding something, or this test
    // proves nothing. board.html loads one asset (its favicon); differential
    // loads favicon + og poster + hero video/poster.
    assert.ok(urls.length >= 1, `${p}: extractor found ${urls.length} resource urls — it is not matching`);

    // Anything the page *loads* must not point at another origin: scripts,
    // images, stylesheets, fonts, video. Relative assets (favicon, og image,
    // hero video) are part of the site and ship alongside the page; a plain
    // <a href> is navigation, not a dependency, and does not affect rendering.
    const external = urls.filter(
      (u) => /^[a-z][a-z0-9+.-]*:\/\//i.test(u) || u.startsWith("//"),
    );
    assert.deepEqual(
      external,
      [],
      `${p} loads cross-origin resources: ${external.join(", ")}`,
    );

    // Every relative load must be an asset the site actually ships. A cache
    // busting query (?v=N on the favicon) is not part of the path.
    for (const u of urls.filter((u) => !/^[a-z][a-z0-9+.-]*:/i.test(u))) {
      const path = u
        .split("?")[0]
        .replace(/^\.?\//, "")
        .replace(/^assets\//, "");
      assert.ok(
        existsSync(join(WEB, "assets", path)),
        `${p} references "${u}" but web/assets/${path} does not exist`,
      );
    }

    // And it must not depend on a sibling data file existing next to it.
    assert.ok(
      !/fetch\(\s*["'][^"']*(?:data\/|\.json)/.test(src),
      `${p} should not fetch a sibling data file`,
    );
  }
});

test("every devnet signature a page cites is backed by a committed record", () => {
  // The pages link real devnet transactions as evidence. A link no artifact
  // backs is indistinguishable from a fabricated one, and hand-typed evidence
  // rots the moment someone reuses a page for a later run — so the committed
  // settlement records (docs/devnet-settlement-*.json, written by tests/owed.mjs)
  // are the source of truth, and the pages are checked against them.
  const evidence = readdirSync(join(ROOT, "docs"))
    .filter((f) => f.startsWith("devnet-settlement-") && f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(ROOT, "docs", f), "utf8")));
  assert.ok(evidence.length >= 1, "docs/devnet-settlement-*.json exists");

  const signed = new Set();
  for (const record of evidence) {
    for (const step of record.steps ?? []) if (step.signature) signed.add(step.signature);
  }
  assert.ok(signed.size >= 10, `the record holds the devnet signatures (${signed.size})`);

  // The README table is generated from the same record by gen-webdata.mjs, so it
  // must still list exactly those transactions — a hand edit or a skipped
  // regeneration would publish a signature the record does not contain.
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const block = readme.match(
    /<!-- owed:devnet-settlement:start -->([\s\S]*?)<!-- owed:devnet-settlement:end -->/,
  );
  assert.ok(block, "README.md has the owed:devnet-settlement block");
  const listed = [...block[1].matchAll(/explorer\.solana\.com\/tx\/([1-9A-HJ-NP-Za-km-z]{32,90})/g)].map((m) => m[1]);
  assert.equal(
    listed.length,
    signed.size,
    "the README table lists every signed step of the record",
  );
  for (const sig of listed) assert.ok(signed.has(sig), `README lists ${sig}, absent from the record`);

  // The deployment transaction is evidence of a different kind — it appears in
  // the README's deployment table, not in a settlement report.
  const DEPLOY_TX =
    "49haW2jxU32L4XonwB7LtBv4AwR1z5YcVbTLYD5eDQhqnc64taSBSNizk3z9dgen6dWjSz14VNX6Tcpo5pJS3pd6";

  for (const p of PAGES) {
    const src = readFileSync(join(WEB, p), "utf8");
    const cited = new Set(
      [...src.matchAll(/explorer\.solana\.com\/tx\/([1-9A-HJ-NP-Za-km-z]{32,90})/g)].map((m) => m[1]),
    );
    for (const sig of cited) {
      if (sig === DEPLOY_TX) continue;
      assert.ok(
        signed.has(sig),
        `${p} cites devnet transaction ${sig}, which no committed settlement record contains`,
      );
    }
  }
});

test("differential page carries the harm model inputs", () => {
  const src = readFileSync(join(WEB, "differential.html"), "utf8");
  // The calculator must be wired to the injected feed, not to a hardcoded list.
  for (const needle of ["__RISK__", "effective(", "simulateTokenPrice"]) {
    if (needle === "simulateTokenPrice") {
      // Guard against reintroducing fake data to fill the UI.
      assert.ok(!src.includes(needle), "no simulated prices in the harm page");
      continue;
    }
    assert.ok(src.includes(needle), `page references ${needle}`);
  }
});
