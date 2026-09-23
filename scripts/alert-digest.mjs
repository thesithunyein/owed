/**
 * Post the alert digest, and remember what was already true last time.
 *
 *   node scripts/alert-digest.mjs            # print the digest
 *   node scripts/alert-digest.mjs --post     # also POST it to ALERT_WEBHOOK
 *
 * The webhook is optional, exactly like PYTH_API_KEY is in the divergence lane:
 * with no webhook configured this still prints the digest and exits 0, because
 * "no channel configured" is a state, not a failure. A job that fails when a
 * secret is absent teaches everyone to ignore the job.
 *
 * State lives in `keeper/data/alert-state.json` and is written on every run. It
 * holds only what the next run needs to diff, so a refresh that changed nothing
 * that matters produces an identical file and therefore no commit.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { alertState, classifyAlerts, formatDigest } from "../keeper/src/alerts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FEED = join(ROOT, "feed", "owed-risk.json");
const STATE = join(ROOT, "keeper", "data", "alert-state.json");

const WEBHOOK = process.env.ALERT_WEBHOOK || null;
const shouldPost = process.argv.includes("--post") && !!WEBHOOK;

if (!existsSync(FEED)) {
  console.error(`alert-digest: no feed at ${FEED} - run scripts/risk-feed.mjs first`);
  process.exit(1);
}

const feed = JSON.parse(readFileSync(FEED, "utf8"));
const previous = existsSync(STATE)
  ? JSON.parse(readFileSync(STATE, "utf8"))
  : null;

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
  `State written: ${next.mints.length} mints, ${next.mints.filter((m) => m.stale).length} stale.`,
);
