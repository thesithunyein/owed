import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "..", "web");

/**
 * The pages are shipped as single files that must work from disk — no server, no
 * network, no sibling files. A generator that fails to inject leaves a marker
 * that looks harmless in a diff and produces a blank page in front of a judge,
 * so these guards run in CI.
 */
const PAGES = ["board.html", "differential.html"];

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
  const re = /const\s+(\w+)\s*=\s*\/\*__\w+__\*\/([\s\S]*?);\r?\n/g;
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

    // Every relative load must be an asset the site actually ships.
    for (const u of urls.filter((u) => !/^[a-z][a-z0-9+.-]*:/i.test(u))) {
      const path = u.replace(/^\.?\//, "").replace(/^assets\//, "");
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
