/**
 * Emit the Owed risk feed — the integration surface.
 *
 * The board is for humans. This is for code: one JSON document any protocol,
 * indexer, or terminal can fetch to answer "what multiplier is in force for
 * this mint right now, and is anything about it dangerous?"
 *
 * Two deliberate design choices:
 *
 *  1. The feed carries the **raw on-chain state** as well as our computed
 *     answer. A consumer that distrusts us can recompute the effective
 *     multiplier from `scaled.state` using the documented rule. A feed that
 *     only publishes its own conclusion is unauditable.
 *  2. `effectiveMultiplier` is stamped with the clock it was computed at. The
 *     value is time-dependent, so a stale feed silently becomes wrong; the
 *     clock makes that visible instead of invisible.
 *
 * Usage:
 *   node scripts/risk-feed.mjs                     # -> feed/owed-risk.json
 *   node scripts/risk-feed.mjs --out path.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  effectiveMultiplier,
  readerTrapGap,
  summarize,
} from "../keeper/src/trap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SCAN = join(ROOT, "keeper", "data", "xstocks-scan.json");

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUT = argVal("--out", join(ROOT, "feed", "owed-risk.json"));
const SCHEMA_OUT = join(ROOT, "feed", "schema.json");

export const FEED_VERSION = "1.0.0";

/** The rule consumers must apply when they recompute from `scaled.state`. */
export const EFFECTIVE_RULE =
  "now >= scaled.state.newMultiplierEffectiveTimestamp " +
  "? scaled.state.newMultiplier : scaled.state.multiplier";

const now = Math.floor(Date.now() / 1000);
const scan = JSON.parse(readFileSync(SCAN, "utf8"));

const tokens = scan.results.map((rec) => {
  const state = rec.scaledState ?? {};
  const gap = readerTrapGap(state, now);
  const security = rec.security ?? {};
  return {
    symbol: rec.symbol,
    mint: rec.mint,
    decimals: rec.decimals,
    supply: {
      raw: rec.supply,
    },
    scaled: {
      // Raw state, so a consumer can recompute rather than trust.
      state: {
        multiplier: state.multiplier ?? null,
        newMultiplier: state.newMultiplier ?? null,
        newMultiplierEffectiveTimestamp: state.newMultiplierEffectiveTimestamp ?? null,
      },
      effectiveMultiplier: state.multiplier == null ? null : effectiveMultiplier(state, now),
    },
    trap: {
      stale: gap != null,
      gapPct: gap == null ? null : gap * 100,
      daysStale:
        state.newMultiplierEffectiveTimestamp == null || gap == null
          ? null
          : (now - Number(state.newMultiplierEffectiveTimestamp)) / 86_400,
    },
    security: {
      permanentDelegate: security.permanentDelegate?.delegate ?? null,
      pauseAuthority: security.pausable?.authority ?? null,
      paused: Boolean(security.pausable?.paused),
      transferHookAuthority: security.transferHook?.authority ?? null,
    },
  };
});

tokens.sort((a, b) => (b.trap.gapPct ?? -1) - (a.trap.gapPct ?? -1));

const feed = {
  feed: "owed/xstocks-risk",
  version: FEED_VERSION,
  generatedAt: new Date(now * 1000).toISOString(),
  clock: now,
  source: {
    rpc: scan.rpc ?? null,
    assetList: "xstocks-solana.json (official xStocks Solana list)",
    scan: "xstocks-scan.json",
  },
  effectiveMultiplierRule: EFFECTIVE_RULE,
  // Reminder for consumers: recompute against your own clock; this is a snapshot.
  stalenessWarning:
    "effectiveMultiplier is computed at `clock`. Re-evaluate the rule against " +
    "your own clock before use; do not cache beyond one activation boundary.",
  summary: summarize(scan.results, now),
  tokens,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(feed, null, 2) + "\n");

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://owed.sithunyein.com/feed/schema.json",
  title: "Owed xStocks risk feed",
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
    summary: {
      type: "object",
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
      items: {
        type: "object",
        required: ["symbol", "mint", "decimals", "scaled", "trap", "security"],
        properties: {
          symbol: { type: "string" },
          mint: { type: "string" },
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
        },
      },
    },
  },
};
writeFileSync(SCHEMA_OUT, JSON.stringify(schema, null, 2) + "\n");

const s = feed.summary;
console.log(
  `feed: ${feed.tokens.length} tokens | stale ${s.trap} | ` +
    `>=10x ${s.ge10x} | max gap ${s.maxGapPct.toFixed(0)}% | ` +
    `permanent delegate ${s.permanentDelegate}/${s.total}`,
);
console.log(`wrote ${OUT}`);
console.log(`wrote ${SCHEMA_OUT}`);
