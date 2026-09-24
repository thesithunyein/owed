/**
 * Post the alert digest, remember what was already true last time, and publish
 * the whole lane as a public JSON document.
 *
 *   node scripts/alert-digest.mjs            # print the digest, write feed/alerts.json
 *   node scripts/alert-digest.mjs --post     # also POST it to ALERT_WEBHOOK
 *
 * Three outputs, one run:
 *
 *   1. stdout          the digest, for a log or a shell
 *   2. feed/alerts.json the lane as a document a site, a bot or a judge can read
 *   3. ALERT_WEBHOOK    the digest as a chat message, if one is configured
 *
 * The webhook is optional, exactly like PYTH_API_KEY is in the divergence lane:
 * with no webhook configured this still prints the digest, still writes the feed
 * and exits 0, because "no channel configured" is a state, not a failure. A job
 * that fails when a secret is absent teaches everyone to ignore the job.
 *
 * State lives in `keeper/data/alert-state.json` and holds only what the next run
 * needs to diff, so a refresh that changed nothing that matters produces an
 * identical file and therefore no commit. The public history lives in
 * `feed/alerts.json` instead, because that file is *supposed* to change when
 * there is news and to stay byte-identical when there is not.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { alertState, classifyAlerts, formatDigest, feedFacts } from "../keeper/src/alerts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FEED = join(ROOT, "feed", "owed-risk.json");
const ALERTS = join(ROOT, "feed", "alerts.json");
const STATE = join(ROOT, "keeper", "data", "alert-state.json");

/** How many past events the public document keeps. Bounded so it cannot grow. */
const HISTORY_LIMIT = 20;

const WEBHOOK = process.env.ALERT_WEBHOOK || null;
const shouldPost = process.argv.includes("--post") && !!WEBHOOK;

if (!existsSync(FEED)) {
  console.error(`alert-digest: no feed at ${FEED} - run scripts/risk-feed.mjs first`);
  process.exit(1);
}

const feed = JSON.parse(readFileSync(FEED, "utf8"));
const previous = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
const published = existsSync(ALERTS) ? JSON.parse(readFileSync(ALERTS, "utf8")) : null;

// The feed's own clock, not the wall clock: the digest must describe the
// snapshot it is attached to, and a wall clock would make the same committed
// feed produce a different digest every time it ran.
const nowSec = feed.clock ?? Math.floor(Date.now() / 1000);

const result = classifyAlerts(feed, previous, nowSec);
const digest = formatDigest(feed, result, nowSec);

console.log(digest);
if (result.firstRun) {
  console.log(
    "\n(First run with no previous state: the digest is informational only. " +
      "The next run is the first one that can say what changed.)",
  );
}

// ---------------------------------------------------------------------------
// The public document
// ---------------------------------------------------------------------------
// `nextActivation` is derived from the feed alone, so the lane carries something
// true and useful even on a run with no events at all - which is most runs. An
// alert surface that is empty 95% of the time teaches people to stop opening it,
// so the standing fact (what is scheduled next) lives here permanently while the
// event list stays news-only.
const facts = feedFacts(feed);
const soonest = facts
  .filter((f) => !f.stale && f.effectiveTimestamp > nowSec && f.next !== f.stored)
  .sort((a, b) => a.effectiveTimestamp - b.effectiveTimestamp)[0];

const before = new Set(
  (published?.history ?? []).map((h) => `${h.at}|${h.kind}|${h.symbol ?? h.mint}`),
);
const added = result.events
  .map((e) => ({
    at: new Date(nowSec * 1000).toISOString(),
    kind: e.kind,
    symbol: e.symbol ?? null,
    mint: e.mint,
    message: e.message,
  }))
  // A refresh that re-derives the same event at the same clock is not news
  // twice. Keyed on the event's own clock, so a re-run is idempotent.
  .filter((h) => !before.has(`${h.at}|${h.kind}|${h.symbol ?? h.mint}`));

const alerts = {
  feed: "owed-alerts",
  version: "1.0.0",
  generatedAt: new Date(nowSec * 1000).toISOString(),
  clock: nowSec,
  rule:
    "Two events only. became-stale: a mint's stored field matched the runtime at " +
    "the previous refresh and does not now. activation-imminent: a scheduled " +
    "multiplier change is inside the 48h window and has not landed yet. No " +
    "'still divergent' event is ever emitted, because 383 mints are divergent at " +
    "any moment and a channel that repeats that teaches its readers to ignore it.",
  summary: {
    current: facts.filter((f) => f.stale).length,
    total: facts.length,
    becameOutOfDate: result.events.filter((e) => e.kind === "became-stale").length,
    activationImminent: result.events.filter((e) => e.kind === "activation-imminent").length,
  },
  nextActivation: soonest
    ? {
        symbol: soonest.symbol,
        stored: soonest.stored,
        next: soonest.next,
        activatesAt: soonest.effectiveTimestamp,
        secondsUntil: soonest.effectiveTimestamp - nowSec,
      }
    : null,
  // The freshest divergence, which is the one piece of time-sensitive news the
  // lane can state on any run: an event list is empty whenever nothing changed
  // since the last refresh, and a surface that is blank most of the time stops
  // being read. "Whose field stopped matching most recently" is always true and
  // always useful, so it is a standing field rather than an event.
  mostRecent: (() => {
    const d = facts
      .filter((f) => f.stale && f.daysStale != null)
      .sort((a, b) => a.daysStale - b.daysStale)[0];
    if (!d) return null;
    return {
      symbol: d.symbol,
      issuer: d.issuer,
      daysAgo: d.daysStale,
      stored: d.stored,
      effective: d.effective,
      gapPct: d.gapPct,
    };
  })(),
  events: result.events,
  history: [...added, ...(published?.history ?? [])].slice(0, HISTORY_LIMIT),
};

mkdirSync(dirname(ALERTS), { recursive: true });
writeFileSync(ALERTS, `${JSON.stringify(alerts, null, 2)}\n`);
console.log(
  `Alerts published: ${alerts.summary.current}/${alerts.summary.total} divergent, ` +
    `${result.events.length} event(s), history ${alerts.history.length}.`,
);

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------
if (shouldPost) {
  const body = JSON.stringify({ text: digest, content: digest });
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!res.ok) {
    // Fail loudly: a webhook that silently 4xx'd is worse than none, because the
    // lane looks healthy while nothing is being delivered.
    console.error(`alert-digest: webhook returned ${res.status}`);
    process.exit(1);
  }
  console.log(`\nPosted to the configured webhook (${result.events.length} events).`);
} else if (previous) {
  console.log(
    `\n${result.events.length} event(s). Set ALERT_WEBHOOK and pass --post to deliver them.`,
  );
}

mkdirSync(join(ROOT, "keeper", "data"), { recursive: true });
const next = alertState(feed);
writeFileSync(STATE, `${JSON.stringify(next, null, 1)}\n`);
console.log(
  `State written: ${next.mints.length} mints, ${next.mints.filter((m) => m.stale).length} divergent.`,
);
