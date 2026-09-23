/**
 * Emit the Owed risk feed - the integration surface.
 *
 * The board is for humans. This is for code: one JSON document any protocol,
 * indexer, or terminal can fetch to answer "what multiplier is in force for
 * this mint right now, and is anything about it dangerous?"
 *
 * Three deliberate design choices:
 *
 *  1. The feed carries the **raw on-chain state** as well as our computed
 *     answer. A consumer that distrusts us can recompute the effective
 *     multiplier from `scaled.state` using the documented rule. A feed that
 *     only publishes its own conclusion is unauditable.
 *  2. `effectiveMultiplier` is stamped with the clock it was computed at. The
 *     value is time-dependent, so a stale feed silently becomes wrong; the
 *     clock makes that visible instead of invisible.
 *  3. Two issuer lanes (`tokens`, `preStocks`) share one row shape and one
 *     classifier. The reader trap is a property of the Token-2022 extension
 *     rather than of one issuer, and a finding about the extension is only
 *     credible if both lanes are measured identically.
 *
 * Usage:
 *   node scripts/risk-feed.mjs                     # -> feed/owed-risk.json
 *   node scripts/risk-feed.mjs --out path.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { summarize } from "../keeper/src/trap.mjs";
import { buildTokens, describeIssuer } from "../keeper/src/feed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SCAN = join(ROOT, "keeper", "data", "xstocks-scan.json");
const PRESTOCKS_SCAN = join(ROOT, "keeper", "data", "prestocks-scan.json");

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUT = argVal("--out", join(ROOT, "feed", "owed-risk.json"));
const SCHEMA_OUT = join(ROOT, "feed", "schema.json");

// 1.1.0 adds the PreStocks lane additively: `tokens`, `summary` and the feed id
// keep their exact meaning, so a consumer written against 1.0.0 is unaffected.
export const FEED_VERSION = "1.1.0";

/** The rule consumers must apply when they recompute from `scaled.state`. */
export const EFFECTIVE_RULE =
  "now >= scaled.state.newMultiplierEffectiveTimestamp " +
  "? scaled.state.newMultiplier : scaled.state.multiplier";

const now = Math.floor(Date.now() / 1000);
const scan = JSON.parse(readFileSync(SCAN, "utf8"));

// The PreStocks lane is optional at the file level so a clone without it still
// publishes a valid, complete feed about the lane it does have.
let preStocksScan = null;
try {
  preStocksScan = JSON.parse(readFileSync(PRESTOCKS_SCAN, "utf8"));
} catch {
  console.warn("no keeper/data/prestocks-scan.json - feed will carry the xStocks lane only");
}

const tokens = buildTokens(scan, now, "xstocks");
const preStocks = preStocksScan ? buildTokens(preStocksScan, now, "prestocks") : [];

const issuers = [
  describeIssuer(
    {
      id: "xstocks",
      name: "xStocks",
      kind: "tokenized public equity",
      list: "xstocks-solana.json (official xStocks Solana list)",
      scan: "xstocks-scan.json",
    },
    scan.results,
    now,
  ),
];
if (preStocksScan) {
  issuers.push(
    describeIssuer(
      {
        id: "prestocks",
        name: "PreStocks",
        kind: "tokenized pre-IPO equity",
        list: "prestocks-solana.json (prestocks.com/api/prestocks)",
        scan: "prestocks-scan.json",
        note:
          "Issued by a different issuer on the same Token-2022 template as xStocks. " +
          "Scanned by the same classifier, which is what makes the finding systemic " +
          "rather than one vendor's bug.",
      },
      preStocksScan.results,
      now,
    ),
  );
}

const feed = {
  // The id is retained for compatibility with consumers written against 1.0.0.
  // It names the feed, not the lane count: `tokens` and `summary` still mean
  // exactly what they meant then.
  feed: "owed/xstocks-risk",
  version: FEED_VERSION,
  generatedAt: new Date(now * 1000).toISOString(),
  clock: now,
  source: {
    rpc: scan.rpc ?? null,
    assetList: "xstocks-solana.json (official xStocks Solana list)",
    scan: "xstocks-scan.json",
    ...(preStocksScan
      ? {
          preStocksList: preStocksScan.listSource ?? "prestocks-solana.json",
          preStocksScan: "prestocks-scan.json",
        }
      : {}),
  },
  effectiveMultiplierRule: EFFECTIVE_RULE,
  // Reminder for consumers: recompute against your own clock; this is a snapshot.
  stalenessWarning:
    "effectiveMultiplier is computed at `clock`. Re-evaluate the rule against " +
    "your own clock before use; do not cache beyond one activation boundary.",
  // `summary` describes `tokens` only, exactly as in 1.0.0. The per-issuer
  // counts, including the PreStocks lane, are in `issuers`.
  summary: summarize(scan.results, now),
  issuers,
  tokens,
  ...(preStocksScan ? { preStocks } : {}),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(feed, null, 2) + "\n");

const tokenItem = (extra = {}) => ({
  type: "object",
  required: ["symbol", "mint", "decimals", "scaled", "trap", "security"],
  properties: {
    issuer: {
      type: "string",
      description: "Issuer lane this row belongs to. Matches an `issuers[].id`.",
    },
    symbol: { type: "string" },
    mint: { type: "string" },
    meta: {
      type: "object",
      description:
        "Issuer-published context (display name, mark price, issuer-reported supply). Not chain state.",
      additionalProperties: true,
    },
    decimals: { type: "integer" },
    supply: {
      type: "object",
      properties: { raw: { type: ["string", "number"] } },
    },
    scaled: {
      type: "object",
      required: ["state", "effectiveMultiplier"],
      properties: {
        state: {
          type: "object",
          required: ["multiplier"],
          properties: {
            multiplier: { type: ["string", "number", "null"] },
            newMultiplier: { type: ["string", "number", "null"] },
            newMultiplierEffectiveTimestamp: { type: ["integer", "null"] },
          },
        },
        effectiveMultiplier: { type: ["number", "null"] },
      },
    },
    trap: {
      type: "object",
      required: ["stale"],
      properties: {
        stale: { type: "boolean" },
        gapPct: { type: ["number", "null"] },
        daysStale: { type: ["number", "null"] },
      },
    },
    security: {
      type: "object",
      properties: {
        permanentDelegate: { type: ["string", "null"] },
        pauseAuthority: { type: ["string", "null"] },
        paused: { type: "boolean" },
        transferHookAuthority: { type: ["string", "null"] },
      },
    },
    ...extra,
  },
});

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://owed.sithunyein.com/feed/schema.json",
  title: "Owed tokenized-equity risk feed (xStocks + PreStocks)",
  type: "object",
  required: ["feed", "version", "generatedAt", "clock", "effectiveMultiplierRule", "summary", "tokens"],
  properties: {
    feed: { const: "owed/xstocks-risk" },
    version: { type: "string" },
    generatedAt: { type: "string", format: "date-time" },
    clock: {
      type: "integer",
      description: "Unix seconds at which effectiveMultiplier was computed.",
    },
    effectiveMultiplierRule: {
      type: "string",
      description:
        "Expression consumers apply to scaled.state, evaluated at their own clock.",
    },
    stalenessWarning: { type: "string" },
    issuers: {
      type: "array",
      description:
        "One entry per issuer lane, including the lane `summary`/`tokens` describe. Counts here match the lane arrays.",
      items: {
        type: "object",
        required: ["id", "name", "kind", "total", "trap"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          kind: { type: "string" },
          note: { type: "string" },
          total: { type: "integer" },
          trap: { type: "integer" },
          ge10x: { type: "integer" },
          ge100: { type: "integer" },
          maxGapPct: { type: "number" },
          permanentDelegate: { type: "integer" },
          pauseAuthority: { type: "integer" },
          paused: { type: "integer" },
          source: { type: "object" },
        },
      },
    },
    summary: {
      type: "object",
      description: "Counts for `tokens` only (the xStocks lane). See `issuers` for all lanes.",
      required: ["total", "trap", "permanentDelegate", "pauseAuthority"],
      properties: {
        total: { type: "integer" },
        trap: { type: "integer", description: "Mints whose stored multiplier is stale." },
        ge10x: { type: "integer" },
        ge100: { type: "integer" },
        ge1: { type: "integer" },
        ge0_5: { type: "integer" },
        permanentDelegate: { type: "integer" },
        pauseAuthority: { type: "integer" },
        paused: { type: "integer" },
        maxGapPct: { type: "number" },
      },
    },
    tokens: {
      type: "array",
      description: "The xStocks lane. Unchanged from feed version 1.0.0.",
      items: tokenItem({ issuer: { const: "xstocks" } }),
    },
    preStocks: {
      type: "array",
      description:
        "The PreStocks lane: tokenized pre-IPO equity, same row shape as `tokens`, scanned by the same classifier.",
      items: tokenItem({ issuer: { const: "prestocks" } }),
    },
  },
};
writeFileSync(SCHEMA_OUT, JSON.stringify(schema, null, 2) + "\n");

const s = feed.summary;
console.log(
  `feed: ${feed.tokens.length} xStocks tokens | stale ${s.trap} | ` +
    `>=10x ${s.ge10x} | max gap ${s.maxGapPct.toFixed(0)}% | ` +
    `permanent delegate ${s.permanentDelegate}/${s.total}`,
);
if (preStocksScan) {
  const p = issuers.find((i) => i.id === "prestocks");
  console.log(
    `feed: ${feed.preStocks.length} PreStocks tokens | stale ${p.trap} | ` +
      `max gap ${p.maxGapPct.toFixed(0)}% | permanent delegate ${p.permanentDelegate}/${p.total}`,
  );
}
console.log(`wrote ${OUT}`);
console.log(`wrote ${SCHEMA_OUT}`);
