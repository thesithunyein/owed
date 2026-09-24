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
const PAGES = ["board.html", "differential.html", "integrate.html"];

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

test("differential page ships a non-empty static fallback", () => {
  // Everything on the front page renders client-side, so any script failure
  // used to leave a blank page. The generator now bakes the summary between
  // markers; if a regeneration stops filling them, this fails instead of
  // shipping an empty page to whoever arrives with JavaScript off.
  const html = readFileSync(join(WEB, "differential.html"), "utf8");
  const grab = (m) => {
    const x = html.match(new RegExp(`<!-- owed:${m}:start -->([\\s\\S]*?)<!-- owed:${m}:end -->`));
    return x ? x[1] : null;
  };
  const stats = grab("stats");
  const chips = grab("chips");
  const sub = grab("sub");
  const worst = grab("hero-worst");
  for (const [name, content] of [["stats", stats], ["chips", chips], ["sub", sub], ["hero-worst", worst]]) {
    assert.ok(content !== null, `owed:${name} marker present`);
    assert.ok(content.trim().length > 0, `owed:${name} fallback is non-empty`);
  }
  // The bake must agree with the committed feed, not just exist.
  const feed = JSON.parse(readFileSync(join(ROOT, "feed", "owed-risk.json"), "utf8"));
  assert.ok(
    stats.includes(`<b>${feed.tokens.length + (feed.preStocks ?? []).length}</b>`),
    "stats tile carries the feed's total mint count",
  );
  assert.ok(chips.includes("data-sym="), "chips carry clickable tickers");
  // The generator flags clock-stability honestly: near an activation boundary
  // the static numbers could mislead, so the page must re-render.
  const nearBoundary = [...feed.tokens, ...(feed.preStocks ?? [])].some((t) => {
    const ts = Number(t.scaled?.state?.newMultiplierEffectiveTimestamp ?? 0);
    return ts > 0 && Math.abs(feed.clock - ts) < 48 * 3600;
  });
  const match = sub.match(/<span class="static-match">([01])<\/span>/);
  assert.ok(match, "sub block carries the static-match flag");
  assert.equal(
    match[1],
    nearBoundary ? "0" : "1",
    "static-match flag equals the feed's actual clock-stability",
  );
});

test("page script preserves the static fallback when the clocks agree", () => {
  // The guard cuts both ways: the script must keep the bake when the flag says
  // it is safe, and must re-render when it does not. Both branches are tested
  // here against the page's own source so neither can rot silently.
  const src = readFileSync(join(WEB, "differential.html"), "utf8");
  assert.ok(src.includes("function statsMatchesStatic()"), "statsMatchesStatic defined");
  assert.ok(src.includes("function chipsMatchStatic("), "chipsMatchStatic defined");
  assert.ok(
    /if \(statsMatchesStatic\(\)\) return;/.test(src),
    "stats() keeps the static copy when it matches",
  );
  assert.ok(
    /if \(chipsMatchStatic\(chips\)\) return;/.test(src),
    "examples() keeps static chips when they match",
  );
});

test("README test counts match the suites they describe", () => {
  // These counts were the last hand-written numbers in the README that
  // described the code sitting next to them, and they drifted exactly as that
  // kind of number does: the CI spine sentence advertised "75 keeper tests"
  // while the status table on the same page said 106. A stale count is a small
  // lie in a project whose entire claim is that every published number is
  // recomputable, so the counts are recomputed here.
  //
  // Counting declarations - `^test(` at column 0 for the JS suites, `#[test]`
  // for Rust - reproduces `node --test`'s own total exactly for both JS suites
  // as of this commit (keeper 107, sdk 8). If a suite ever gains nested
  // `describe` blocks or a loop that generates cases, this test is what says
  // the counting rule needs revisiting, instead of quietly passing on a number
  // nobody rechecked.
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");

  const walk = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "target") continue;
        out.push(...walk(join(dir, entry.name)));
      } else {
        out.push(join(dir, entry.name));
      }
    }
    return out;
  };

  const countTests = (dir, ext, re) =>
    walk(join(ROOT, dir))
      .filter((f) => f.endsWith(ext))
      .reduce((n, f) => n + (readFileSync(f, "utf8").match(re) ?? []).length, 0);

  const keeper = countTests("keeper/test", ".mjs", /^test\(/gm);
  const core = countTests("core", ".rs", /#\[test\]/g);
  const sdkSrc = walk(join(ROOT, "sdk", "test"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const sdk = (sdkSrc.match(/^test\(/gm) ?? []).length;

  // keeper is quoted three times: the CI spine sentence, the file-tree legend,
  // and the status table. All three must agree with the suite itself.
  assert.ok(
    readme.includes(`Rust tests, ${keeper} keeper tests`),
    `the CI spine sentence says "${keeper} keeper tests"`,
  );
  assert.ok(
    readme.includes(`${keeper} tests incl. build-integrity guards`),
    `the file-tree legend says "${keeper} tests"`,
  );
  assert.ok(
    readme.includes(`| \`keeper/\` TS | \u2705 ${keeper} tests`),
    `the status table says "| keeper/ TS | ${keeper} tests"`,
  );

  assert.ok(
    readme.includes(`| \`core/\` Rust | \u2705 ${core} tests`),
    `the status table says "${core} core tests"`,
  );

  // Exactly one sdk test hits mainnet, skipped unless OWED_LIVE_SDK=1, so the
  // offline count the README quotes is the total minus one. A second gated test
  // would make that sentence misleading, so its presence is asserted too.
  const gated = (sdkSrc.match(/OWED_LIVE_SDK/g) ?? []).length;
  assert.ok(gated >= 1, "the sdk suite keeps its network-gated test");
  assert.ok(
    readme.includes(`| \`sdk/\` | \u2705 ${sdk - 1} offline tests`),
    `the status table says "${sdk - 1} offline tests"`,
  );
});

test("the front page states the finding in its title, and agrees with its own hero", () => {
  // The title and the OG card are the whole first impression for a shared link,
  // and they used to read "the correctness layer for tokenized equities", which
  // tells a reader nothing they can act on. They are baked by gen-webdata.mjs, so
  // a skipped regeneration would silently ship the previous snapshot's count.
  const src = readFileSync(join(WEB, "differential.html"), "utf8");

  const marker = src.match(/<!-- owed:title:start -->([\s\S]*?)<!-- owed:title:end -->/);
  assert.ok(marker, "the title carries a generator marker");
  assert.match(marker[1], /^\d[\d,]* of [\d,]+$/, `title count is filled in, got "${marker[1]}"`);

  // The marker must sit outside <title>, which is RCDATA: a comment inside it is
  // rendered text, not a comment, and would appear in the browser tab and in every
  // social card. This caught exactly that.
  const rendered = [
    src.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "",
    src.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? "",
    src.match(/<meta name="twitter:title" content="([^"]*)"/)?.[1] ?? "",
  ];
  assert.equal(rendered.length, 3, "title, og:title and twitter:title all exist");
  for (const value of rendered) {
    assert.ok(!value.includes("<!--"), `no markup in rendered title text: "${value}"`);
    assert.ok(value.includes(marker[1]), `title text quotes the marker count: "${value}"`);
  }
  assert.equal(
    new Set(rendered.map((v) => v.replace(marker[1], "#"))).size,
    1,
    "the three titles agree with each other",
  );

  // And the same numbers the hero line states, so one screen cannot tell a reader
  // two different counts.
  const hero = src.match(/<!-- owed:hero-worst:start -->([\s\S]*?)<!-- owed:hero-worst:end -->/);
  assert.ok(hero, "the hero carries the baked finding");
  const heroCount = hero[1].match(/<strong>([\d,]+ of [\d,]+) mints<\/strong>/);
  assert.ok(heroCount, "the hero names the count");
  assert.equal(marker[1], heroCount[1], "the title and the hero quote the same count");
});

test("the proof lives in the README, not on the product page", () => {
  // The front page is the product: check a token, check a whole book, see what is
  // mispriced. The two-RPC demonstration, the corroboration and the settlement
  // evidence used to sit on it, which made a working app read as an argument.
  // They belong in the README, where a reader who wants to falsify a number goes
  // looking - and this test is what stops them creeping back onto the page a
  // visitor is actually trying to use.
  const page = readFileSync(join(WEB, "differential.html"), "utf8");
  for (const gone of [
    'id="mechanism"',
    'id="corroboration"',
    'id="evidence"',
    "verify-rpc-mechanism.mjs",
  ]) {
    assert.ok(!page.includes(gone), `the product page no longer carries ${gone}`);
  }

  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  for (const moved of [
    "verify-rpc-mechanism.mjs",
    "getAccountInfo",
    "getTokenSupply",
    "current_multiplier",
    "solana-foundation/explorer",
    "Kamino",
  ]) {
    assert.ok(readme.includes(moved), `README carries the moved proof: ${moved}`);
  }
});

test("the alert lane is published as a document the page agrees with", () => {
  const feed = JSON.parse(readFileSync(join(ROOT, "feed", "owed-risk.json"), "utf8"));
  const all = [...(feed.tokens ?? []), ...(feed.preStocks ?? [])];
  const divergent = all.filter((t) => t.trap?.stale).length;

  const src = readFileSync(join(WEB, "differential.html"), "utf8");
  const strip = src.match(/<!-- owed:alerts:start -->([\s\S]*?)<!-- owed:alerts:end -->/);
  assert.ok(strip, "differential.html has the owed:alerts block");
  assert.ok(strip[1].trim().length > 0, "the alert strip is not empty");
  assert.ok(!/Loading the alert lane/.test(strip[1]), "the strip is not still the placeholder");

  const alertsPath = join(ROOT, "feed", "alerts.json");
  if (!existsSync(alertsPath)) {
    // The lane is allowed to have never run. When it has not, the strip must say
    // so rather than let a blank box read as "nothing is wrong".
    assert.match(strip[1], /has not published yet/, "an unpublished lane says so");
    return;
  }

  const alerts = JSON.parse(readFileSync(alertsPath, "utf8"));
  assert.equal(alerts.feed, "owed-alerts");
  assert.ok(alerts.summary, "the document carries a summary");
  assert.equal(
    alerts.summary.current,
    divergent,
    "the alert summary counts the same divergent mints the risk feed does",
  );
  assert.equal(alerts.summary.total, all.length, "and the same total");
  assert.ok((alerts.history ?? []).length <= 20, "the published history is bounded");
  for (const h of alerts.history ?? []) {
    assert.ok(
      typeof h.message === "string" && h.message.length > 0,
      "every history entry says something",
    );
    assert.match(h.at, /^\d{4}-\d{2}-\d{2}T/, "every history entry is timestamped");
  }

  // The strip is baked from this document, so the freshest divergence it names has
  // to be the one the document names.
  if (alerts.mostRecent) {
    assert.ok(
      strip[1].includes(alerts.mostRecent.symbol),
      `the strip names the freshest divergence (${alerts.mostRecent.symbol})`,
    );
  }
});

test("the demo script does not put a false claim in the presenter's mouth", () => {
  // This file is read aloud on camera, so a stale line here is worse than a stale
  // line anywhere else: it cannot be corrected after the take. Both of the errors
  // below shipped at some point, and the second one undersold the strongest
  // engineering artifact in the repo - the program is compiled and on devnet.
  const src = readFileSync(join(ROOT, "docs", "DEMOSCRIPT.md"), "utf8");
  // The header blockquote records claims that were removed and why, so it has to
  // quote them - scanning it would fail on the correction itself. Only the spoken
  // body is checked, which starts after the first horizontal rule.
  const rule = src.indexOf("\n---\n");
  assert.ok(rule > 0, "the script has a header block and a body");
  const spoken = src.slice(rule);

  const deployed = readFileSync(join(ROOT, "README.md"), "utf8");
  const liveOnDevnet = /program is live on devnet/i.test(deployed);
  if (liveOnDevnet) {
    assert.ok(
      !/has not been compiled|not been compiled, deployed, or audited/i.test(spoken),
      "the script does not claim the program was never compiled or deployed while the README says it is live",
    );
  }

  // The runtime is correct, so no spoken line may assert that the chain misprices.
  for (const phrase of ["misprice positions", "quoting the wrong price", "the chain is wrong"]) {
    assert.ok(!spoken.includes(phrase), `the script does not assert fault ("${phrase}")`);
  }

  // And it has to give the presenter the command that carries the argument, or the
  // opening section is not reproducible by whoever is watching.
  assert.ok(
    spoken.includes("verify-rpc-mechanism.mjs"),
    "the script names the command that proves the opening claim",
  );

  // The presenter must also be told the program is live, since that is the artifact
  // the old wording undersold.
  if (liveOnDevnet) {
    assert.match(spoken, /devnet/i, "the script tells the presenter the program is on devnet");
    assert.match(spoken, /not audited/i, "and that it is not audited, rather than omitting it");
  }
});

test("the Integrate page is complete, not a stub", () => {
  const src = readFileSync(join(WEB, "integrate.html"), "utf8");

  // Every path a consumer might take has to be on the page: its whole job is to
  // turn "other people could build on this" into sixty seconds of work, and a
  // missing one is a dead end rather than a smaller page.
  for (const needle of [
    "getEffectiveMultiplier",
    "read_multiplier",
    "feed/owed-risk.json",
    "conformance.mjs",
    "schema.json",
  ]) {
    assert.ok(src.includes(needle), `integrate.html documents ${needle}`);
  }

  // The devnet table is filled from the committed record, because an empty table
  // on the page whose purpose is provability is worse than no page at all.
  const rows = src.match(/<!-- owed:devnet-rows:start -->([\s\S]*?)<!-- owed:devnet-rows:end -->/);
  assert.ok(rows, "integrate.html has the owed:devnet-rows block");
  const record = JSON.parse(
    readFileSync(join(ROOT, "docs", "devnet-settlement-2026-09-22.json"), "utf8"),
  );
  assert.equal(
    (rows[1].match(/<tr>/g) ?? []).length,
    record.steps.length,
    "every settlement step is listed",
  );
  assert.equal(
    (rows[1].match(/tag no">rejected<\/span>/g) ?? []).length,
    record.steps.filter((s) => s.rejected).length,
    "the refused steps are labelled as refusals rather than hidden",
  );

  // The scope split this project is careful about has to be stated on the page,
  // not left for a reader to infer from a cluster parameter in a URL.
  assert.match(src, /reads mainnet/, "the page says the measurement is mainnet");
  assert.match(src, /devnet, unaudited/, "the page says the program is devnet and unaudited");
});

test("README's surface-to-evidence table resolves to real artifacts", () => {
  // The README promises that every surface on the live site traces back to the
  // artifact behind it in one click. A path in that table that no longer exists
  // breaks the promise in the one place a reader goes specifically to check it, so
  // the paths are resolved here rather than trusted - the same reason every count
  // in this repo is recomputed instead of typed.
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const block = readme.match(
    /<!-- owed:provenance:start -->([\s\S]*?)<!-- owed:provenance:end -->/,
  );
  assert.ok(block, "README has the owed:provenance block");
  assert.ok(
    /\| *On the live site *\|/.test(block[1]),
    "the provenance block is still a table",
  );

  // Only repo-relative paths count. A bare word (`summary`), a route (`/board`) or a
  // URL is not a file, so a token has to start with one of the repo's own top-level
  // directories to be resolved at all.
  const roots = [
    "feed/",
    "keeper/",
    "core/",
    "sdk/",
    "scripts/",
    "web/",
    "docs/",
    "programs/",
    "tests/",
    ".github/",
  ];
  const paths = new Set();
  for (const [, token] of block[1].matchAll(/`([^`]+)`/g)) {
    const t = token.trim();
    if (roots.some((r) => t.startsWith(r))) paths.add(t);
  }
  assert.ok(paths.size >= 12, `the table resolves at least 12 artifacts, saw ${paths.size}`);
  for (const p of paths) {
    assert.ok(existsSync(join(ROOT, p)), `README points at ${p}, which does not exist`);
  }
});
