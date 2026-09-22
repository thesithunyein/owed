/**
 * Assemble the deployable static site from generated artifacts.
 *
 * `site/` is a build output, not source: it is regenerated from `web/` and
 * `feed/` so the deployed pages can never drift from what the repo says. It is
 * gitignored for the same reason the pages are generated — one source of truth.
 *
 * Layout deployed to owed.sithunyein.com:
 *
 *   /                     the harm page (naive vs chain-correct)
 *   /board                the full risk table
 *   /feed/owed-risk.json  the integration contract
 *   /feed/schema.json     its JSON Schema (this is the feed's declared $id)
 *
 * No build step runs on the host: everything here is a copy of an artifact that
 * already exists and is already tested.
 *
 * Usage:
 *   node scripts/risk-feed.mjs && node scripts/gen-webdata.mjs && node scripts/build-site.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SITE = join(ROOT, "site");

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");
const write = (rel, contents) => {
  const dest = join(SITE, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, contents);
  return contents.length;
};

/** Fail loudly rather than deploy an empty or placeholder page. */
function assertDeployable(name, html) {
  if (/const\s+\w+\s*=\s*\/\*__\w+__\*\/\s*null\s*;/.test(html)) {
    throw new Error(`${name} has an un-injected generator marker — run gen-webdata.mjs`);
  }
  if (!/const RISK = \/\*__RISK__\*\/\{/.test(html) && /__RISK__/.test(html)) {
    throw new Error(`${name} carries an unfilled RISK payload`);
  }
  if (html.length < 5000) {
    throw new Error(`${name} looks too small to be a real page (${html.length} bytes)`);
  }
}

// A stale site is worse than no site: these are the numbers judges will see.
rmSync(SITE, { recursive: true, force: true });

const harm = read("web", "differential.html");
const board = read("web", "board.html");
assertDeployable("differential.html", harm);
assertDeployable("board.html", board);

// Static assets (og image, favicon, hero video) are copied verbatim. The video
// is the hero background — shipping a truncated or zero-byte copy would render
// a blank hero in front of a judge, so its presence and size are load-bearing.
mkdirSync(join(SITE, "assets"), { recursive: true });
for (const asset of ["og.png", "favicon.png", "logo.png", "logo-white.png", "hero.mp4", "poster.jpg"]) {
  const src = join(ROOT, "web", "assets", asset);
  if (!existsSync(src)) {
    throw new Error(`web/assets/${asset} is missing — it is part of the site`);
  }
  const bytes = readFileSync(src);
  if (bytes.length === 0) {
    throw new Error(`web/assets/${asset} is empty`);
  }
  if (asset === "hero.mp4" && bytes.length < 1_000_000) {
    throw new Error(
      `web/assets/hero.mp4 is ${bytes.length} bytes — looks truncated (expected ~2.7MB)`,
    );
  }
  writeFileSync(join(SITE, "assets", asset), bytes);
}

const feedPath = join(ROOT, "feed", "owed-risk.json");
const schemaPath = join(ROOT, "feed", "schema.json");
if (!existsSync(feedPath) || !existsSync(schemaPath)) {
  throw new Error("feed/ is missing — run node scripts/risk-feed.mjs first");
}
const feed = JSON.parse(readFileSync(feedPath, "utf8"));

const sizes = {};
sizes["index.html"] = write("index.html", harm);
sizes["board.html"] = write("board.html", board);
sizes["feed/owed-risk.json"] = write("feed/owed-risk.json", read("feed", "owed-risk.json"));
sizes["feed/schema.json"] = write("feed/schema.json", read("feed", "schema.json"));

// The feed is deliberately short-lived: its values are time-dependent, and a
// cached copy past an activation boundary is exactly the bug this project exists
// to catch. Five minutes of edge caching, then revalidate.
write(
  "vercel.json",
  JSON.stringify(
    {
      $schema: "https://openapi.vercel.sh/vercel.json",
      cleanUrls: true,
      trailingSlash: false,
      headers: [
        {
          source: "/feed/(.*)",
          headers: [
            { key: "Cache-Control", value: "public, max-age=300, stale-while-revalidate=3600" },
            { key: "Access-Control-Allow-Origin", value: "*" },
          ],
        },
        {
          source: "/(.*)",
          headers: [{ key: "X-Content-Type-Options", value: "nosniff" }],
        },
      ],
      redirects: [{ source: "/harm", destination: "/", permanent: false }],
    },
    null,
    2,
  ) + "\n",
);

// A tiny machine-readable index so a consumer can find the feed without reading
// documentation.
write(
  "feed/index.json",
  JSON.stringify(
    {
      feed: feed.feed,
      version: feed.version,
      generatedAt: feed.generatedAt,
      tokens: feed.tokens.length,
      risk: "/feed/owed-risk.json",
      schema: "/feed/schema.json",
    },
    null,
    2,
  ) + "\n",
);

console.log(`site/ assembled from generated artifacts:`);
for (const [name, len] of Object.entries(sizes)) {
  console.log(`  ${name.padEnd(26)} ${(len / 1024).toFixed(0)}KB`);
}
console.log(`  vercel.json + feed/index.json + assets/ (og, favicon, logo, hero.mp4)`);
console.log(`\nfeed: ${feed.tokens.length} tokens, generated ${feed.generatedAt}`);
console.log(`deploy: cd site && vercel deploy --prod --yes --project owed`);
