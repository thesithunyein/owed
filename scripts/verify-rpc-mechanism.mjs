/**
 * Two RPC calls on the same mint, and they disagree.
 *
 *   node scripts/verify-rpc-mechanism.mjs            # PPLTx, the 10x case
 *   node scripts/verify-rpc-mechanism.mjs AAPLx      # any official ticker
 *   node scripts/verify-rpc-mechanism.mjs <mint>     # or a mint address
 *
 * This is the whole trap in two endpoints, with no code to read and no feed to
 * trust:
 *
 *   1. `getAccountInfo` with `jsonParsed` returns the extension as the chain
 *      stores it - `multiplier`, `newMultiplier`, and the timestamp the switch
 *      takes effect. It does not return which of the two is in force. There is no
 *      field that answers that; the answer is that timestamp compared against the
 *      clock, and only the consumer can do that comparison.
 *
 *   2. `getTokenSupply` returns a `uiAmount` the runtime has *already* scaled by
 *      the multiplier in force.
 *
 * So a consumer that takes the multiplier out of (1) and applies it to a raw
 * balance gets a number that disagrees with (2) on the same node, for the same
 * mint, at the same instant - and nothing marks either response as the wrong one.
 *
 * Status is set through `process.exitCode`, never `process.exit()`: calling exit
 * while the fetch handle is still tearing down trips a libuv assertion on Windows
 * and replaces every status, including success, with 127.
 *
 *   0  diverges - the stored field is not what the runtime applies
 *   1  no divergence, so a naive reader happens to be right for this mint
 *   2  the mint carries no ScaledUiAmount extension at all
 *
 * Exit 1 is a real answer, not an error: this script exists to try to falsify the
 * claim, and it reports the boring case as readily as the interesting one.
 *
 * No API key. No wallet. Public mainnet state only.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

const arg = process.argv[2] ?? "PPLTx";

/** Resolve a ticker to a mint from the published feed; pass a mint straight through. */
function resolveMint(input) {
  const feedPath = join(ROOT, "feed", "owed-risk.json");
  if (!existsSync(feedPath)) return input;
  const feed = JSON.parse(readFileSync(feedPath, "utf8"));
  const all = [...(feed.tokens ?? []), ...(feed.preStocks ?? [])];
  const hit =
    all.find((t) => t.symbol.toUpperCase() === input.toUpperCase()) ??
    all.find((t) => t.mint === input);
  return hit ? hit.mint : input;
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

const line = (k, v) => console.log(`  ${k.padEnd(34)} ${v}`);

/**
 * Compare what the account stores against what the runtime's own supply endpoint
 * implies, for one mint. Every number here comes from the same two calls; the
 * feed is used only to turn a ticker into a mint.
 */
async function inspect(mint) {
  const account = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  if (!account?.value) throw new Error(`no account at ${mint}`);

  const extensions = account.value.data?.parsed?.info?.extensions ?? [];
  const config = extensions.find((e) => e.extension === "scaledUiAmountConfig");
  if (!config) {
    console.log(`${arg} (${mint}) carries no scaledUiAmountConfig extension.`);
    console.log(
      "Nothing to correct: the stored field cannot disagree with a runtime that does not scale.",
    );
    return 2;
  }

  const supply = await rpc("getTokenSupply", [mint]);
  if (!supply?.value) throw new Error(`no supply for ${mint}`);

  const state = config.state;
  const stored = Number(state.multiplier);
  const next = Number(state.newMultiplier);
  const at = Number(state.newMultiplierEffectiveTimestamp ?? 0);
  const nowSec = Math.floor(Date.now() / 1000);

  // The rule, quoted from the SPL interface crate and the Token-2022 docs.
  const inForce = nowSec >= at ? next : stored;

  const decimals = supply.value.decimals;
  const rawUnits = Number(BigInt(supply.value.amount)) / 10 ** decimals;
  const runtimeDisplay = Number(supply.value.uiAmount);
  const naiveDisplay = rawUnits * stored;

  const factor = stored === 0 ? null : runtimeDisplay / naiveDisplay;
  const diverges = Math.abs(runtimeDisplay - naiveDisplay) > Math.max(1e-9, runtimeDisplay * 1e-9);

  console.log(`\n${arg === mint ? mint : `${arg}  ${mint}`}`);
  console.log("\ngetAccountInfo (jsonParsed) - what the account stores, unresolved");
  line("multiplier", stored);
  line("newMultiplier", next);
  line(
    "newMultiplierEffectiveTimestamp",
    `${at}  (${at ? new Date(at * 1000).toISOString() : "never"})`,
  );
  line("which one applies?", "not in the response");
  line("clock now", `${nowSec}  (${new Date(nowSec * 1000).toISOString()})`);

  console.log(`\nApply the rule yourself:  now >= ${at} ? ${next} : ${stored}`);
  line("multiplier in force", inForce);

  console.log("\ngetTokenSupply - the same node, the same mint, already scaled");
  line("raw base units", supply.value.amount);
  line("raw units", rawUnits.toFixed(6));
  line("uiAmount (runtime-scaled)", runtimeDisplay.toFixed(6));

  console.log("\nWhat a consumer reading the stored field would show");
  line("raw units x multiplier field", naiveDisplay.toFixed(6));
  line("disagreement", factor === null ? "n/a" : `${factor.toFixed(6)}x`);

  if (diverges) {
    console.log(
      `\nThe two endpoints disagree by ${factor.toFixed(4)}x, and nothing in either response ` +
        `says which is right. The runtime is the correct one. A client that reads ` +
        `state.multiplier instead of applying the rule above is wrong by exactly that factor, ` +
        `silently, with no error and no failed transaction.`,
    );
    return 0;
  }

  console.log(
    `\nNo divergence: the stored field is the multiplier the runtime applies for this mint, ` +
      `so a naive reader is right here. This script reports that as readily as the other case.`,
  );
  return 1;
}

process.exitCode = await inspect(resolveMint(arg));
