# Submission text

Paste-ready. Written for a judge who has six other entries to read, so the
short answer comes first and the proof is one click away.

Everything below was true as of the committed snapshot (2026-09-24 10:36 UTC).
The live page re-classifies against the reader's own clock, so if a number has
moved, the page is right and this file is one refresh behind.

---

## Main track

### The short version

**Two RPC calls to the same node, for the same mint, disagree - and neither one
is marked as the wrong one.** `getAccountInfo` returns Token-2022's
`scaledUiAmountConfig` as the chain stores it: `multiplier`, `newMultiplier`, and
the timestamp the switch takes effect, with **no field saying which of the two is
in force**. `getTokenSupply` returns a `uiAmount` the runtime has already scaled.
On `PPLTx` those two responses differ by **10x**, silently.

**385 of the 933 official tokenized-equity mints are in that state right now.**
Owed measures it from chain state for every official mint, publishes it as an
auditable feed with an alert when it changes, ships the one-line reader that
fixes it, and settles corporate actions correctly on-chain when an issuer would
rather not make every integrator implement it.

**The hazard is understood - the coverage is what is missing.** Solana's own
explorer implements the same selection rule, and Kamino's lending oracle parses
the extension from raw bytes and suspends its price for 24 hours ahead of a
scheduled switch. A protocol that has built a suspension window around this still
has to know, per mint, whether the field it is reading is the one in force.

### Who has the problem

Anyone building on tokenized equities: lending markets and vaults taking
tokenized stocks as collateral, wallets and portfolio trackers showing balances,
oracles and indexers serving their scale, and pricing bots. The end user with
money at risk is a borrower whose collateral is misevaluated by up to a factor
of ten.

### What the problem is

Tokenized stocks rebase splits and dividends on-chain through Token-2022's
Scaled UI Amount extension. That extension stores a `multiplier` field **plus a
pending change with an activation timestamp**:

```
effective = now >= newMultiplierEffectiveTimestamp ? newMultiplier : multiplier
```

Once the activation passes, the stored `multiplier` is stale and the runtime
still applies the new value. Reading `multiplier` directly is the obvious thing
to do and produces the wrong balance after every corporate action. It is silent:
no error, no event, no failed transaction. The token just means 10x more than
the reader thinks.

To be exact about what we are and are not claiming: the **runtime is correct**,
and we have verified our reader against it on all 925 official mints at a
relative tolerance of 1e-9. The defect is in naive integrations, and the fix is
a function call.

### What we built

1. **The measurement.** A scanner that reads live mainnet state for every
   official mint and classifies it. Not a sample: all 925 xStocks mints, plus all
   8 PreStocks mints through the same classifier.
2. **The published feed.** `feed/owed-risk.json` (v1.2.0) plus a JSON Schema:
   one row shape for both issuers, every published value recomputable from the
   raw state published beside it. This is the integration surface, not a
   dashboard.
3. **The one-line fix.** `sdk/owed.mjs` - `getEffectiveMultiplier(mint)`, zero
   dependencies, no API key, with an example and tests that run against a real
   committed mainnet account.
4. **The on-chain fix for issuers who want it.** An Anchor program that settles
   corporate actions properly: declare an action, snapshot holders into a Merkle
   root at a record slot, let holders claim with proofs, settle. Compiles for
   SBF, runs a full split plus dividend lifecycle on every push in CI, and has
   settled on devnet with real explorer-verifiable signatures.
5. **The app.** `owed.sithunyein.com` - search any official ticker and see the
   stored value, the chain-correct value, the resulting error, and what it does
   to a position. Plus a risk board, a read-only wallet scan that answers the
   question per user, and a no-wallet path: paste a list of holdings - ticker or
   mint, optionally an amount and a value - and get the same answer for a whole
   book, before connecting anything.
6. **The integration page.** `owed.sithunyein.com/integrate` - the same fix in
   four languages you can copy in sixty seconds: the JS call, the CPI-callable
   Rust reader, the HTTP feed with a `jq` one-liner, and the CLI to measure your
   own mint list. The integration surface is the product, so it has a page rather
   than a paragraph.
7. **The alert lane.** `feed/alerts.json`, plus a strip on the front page. It
   fires for exactly two things - a mint whose field just stopped matching the
   runtime, and an activation inside 48h - and is deliberately silent otherwise,
   because a channel that repeats "383 are still wrong" every six hours trains
   its readers to ignore the one message that matters.

### The evidence

Measured today from mainnet state; the app recomputes it in the visitor's
browser on load:

| symbol | issuer | stored | chain applies | error | stale for |
|---|---|---|---|---|---|
| PPLTx | xStocks | 1 | 10 | **10x** | 130 days |
| NFLXx | xStocks | 1 | 10 | **10x** | 311 days |
| PALLx | xStocks | 1 | 5 | **5x** | 130 days |
| SPACEX | PreStocks | 1 | 5 | **5x** | 106 days |
| CRWDx | xStocks | 1 | 4 | **4x** | 84 days |
| OPENAI | PreStocks | 1 | 1.4861347 | **48.61%** | 69 days |

385 of the 933 mints across both issuers are stale right now; 30 are off by 1% or
more, 6 by 10% or more, and 5 by 100% or more.

**Two issuers, not one vendor's bug.** All 8 PreStocks mints carry the same
Token-2022 extension set as the xStocks set - same issuance template, different
issuer - so the finding is a property of how these assets are issued, not one
team's mistake. That is what makes it worth fixing at the infrastructure layer.

**The 60-second version, no trust required:**

```
node scripts/verify-rpc-mechanism.mjs PPLTx
  multiplier                         1
  newMultiplier                      10
  newMultiplierEffectiveTimestamp    1778985000  (2026-05-17T02:30:00.000Z)
  which one applies?                 not in the response
  raw units x multiplier field       79671.530000
  uiAmount (runtime-scaled)          796715.300000
  disagreement                       10.000000x
```

Two calls, one node, one mint, no API key, no wallet. The exit status is part of
the contract - `0` diverges, `1` no divergence, `2` no extension - so a mint that
is fine is reported as readily as one that is not.

**Confirmed independently three times over, then measured per mint:**

| Source | What it establishes |
|---|---|
| The SPL specification | The interface crate's `current_multiplier` selects between the fields on the timestamp; the docs publish the same rule in reference client code and mark scaled-amount support P0 for wallets, DEXes and aggregators |
| Solana's own explorer | `solana-foundation/explorer` ships `getCurrentTokenScaledUiAmountMultiplier`, comparing the clock against the timestamp and choosing the same field we do |
| Kamino's lending oracle | `Kamino-Finance/scope` parses from raw bytes at the same offsets and treats a change as a first-class risk, suspending the price 24h ahead of a scheduled switch and documenting that an activation timestamp may already be in the past when published |

**Independently verifiable, not asserted:**
- Our reader equals the Token-2022 runtime on 925/925 mints (`scripts/conformance.mjs --all`).
- Every trap mint is confirmed against the runtime's own scaled supply.
- The devnet settlement is a 15-step run: 13 signed transactions plus 2 designed
  rejections (a short register and a replayed claim) proving the guards bite.
- We also publish what we could **not** establish - including a probe that
  failed and is not cited as evidence. `README.md` -> "What we could not establish".

### The demo

- **App:** https://owed.sithunyein.com - search `PPLTx`, watch it price a position
  10x wrong, then correct it.
- **Board:** https://owed.sithunyein.com/board - every mint that diverges, worst first, both issuers.
- **Integrate:** https://owed.sithunyein.com/integrate - the fix in four languages, plus all 15 devnet settlement steps as explorer links.
- **Feed:** https://owed.sithunyein.com/feed/owed-risk.json - the contract other builders read.
- **Alerts:** https://owed.sithunyein.com/feed/alerts.json - what changed, and what lands next.
- **No wallet needed:** the front page takes a pasted list of holdings, not just one ticker.
- **Repo:** https://github.com/thesithunyein/owed
- **Repro in two commands:** `node sdk/example.mjs PPLTx` (stored 1, chain applies 10)
- **Two-minute walkthrough:** `docs/DEMOSCRIPT.md`.

### Why Solana

This is not a product that could exist the same way anywhere else. The defect
lives in Token-2022's extension model - a mint-level, time-dependent multiplier
that is applied by the runtime. Detecting it means reading mint extensions and
comparing them against what the runtime actually returns; fixing it means either
computing the effective value at read time or settling the corporate action
on-chain with an on-chain registry and Merkle-claimed entitlements. Both are
Solana-native primitives, and the tokens themselves only exist here.

### What happens next

1. **Get the integrators to adopt the reader.** Five targets are identified with
   exact mints and messages in `docs/OUTREACH.md`; one confirmation that this
   affects a live product is the traction this needs.
2. **Keep the feed fresh and honest.** It refreshes every six hours with
   tripwires that fail the build if the cross-issuer claim goes stale, and a
   scheduled refresh regenerates the registry, scan, feed and both pages.
3. **Mainnet-deploy the registry** once the program has been reviewed; it is
   deliberately devnet-only and unaudited today, with a pinned address reserved
   for that move.

### Honest scope

The scanner, feed, SDK and pages read real mainnet state and are usable now. The
registry program compiles, settles in CI on every push, and settles on devnet,
but is **not on mainnet and not audited**. Why the stored field is stale is
unknown and we do not attribute intent: a trap is consistent with an issuer that
forgot to republish and with one that expects integrators to compute the
effective value. We measure the divergence.

---

## PreStocks bounty variant

**Every PreStocks token is a rebasing asset, and two of yours are rebasing
silently: SPACEX and OPENAI.** Read the multiplier stored in the mint account -
the obvious thing for an integrator to do - and you report **5x too little
SPACEX** and **48.61% too little OPENAI**, with no error and no failed
transaction. The chain applies a different multiplier than the field says, and
nothing in the account marks which one is in force.

Owed is the correctness layer for that. It scans all 8 PreStocks mints with the
same classifier it runs across all 925 xStocks mints and publishes what it finds,
including what is clean:

- **SPACEX** (`PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh`): stored multiplier
  `1`, chain applies `5`. **5x understatement, stale ~106 days.**
- **OPENAI** (`PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF`): stored `1`, chain
  applies `1.4861347`. **48.61% understatement, stale ~69 days.**
- **ANDURIL, ANTHROPIC, FIGUREAI, KALSHI, NEURALINK, POLYMARKET**: clean today,
  and the page says so by name. A monitor that only ever screams is not a
  monitor.

**What that is worth to PreStocks specifically.** These tokens are only as usable
as the integrations that touch them. A wallet, a lending market, a portfolio
tracker or a tax tool that reads the stored field values your token wrong by 5x -
and the error is silent, so nothing fails loudly enough to get fixed. Owed makes
the correct value one function call and publishes the state of every PreStocks
mint as a feed, so an integrator never has to derive the rule from the spec.

**Verify it in one click, no wallet and no key:**

- `owed.sithunyein.com/board?issuer=prestocks` - all 8 mints, stored vs applied
  multiplier, re-classified against the reader's own clock.
- `owed.sithunyein.com/feed/owed-risk.json` - the `preStocks` lane, one row shape
  with the xStocks lane, every value recomputable from the raw state beside it.
- `owed.sithunyein.com` - type `SPACEX` to see the same finding priced against a
  position, before any connection prompt.

The rest of the set matters for a different reason: **all 8 PreStocks mints carry
the same Token-2022 extension set as the xStocks roster** (scaled UI amount,
permanent delegate, pausable, transfer hook). That is what turns this from a
single issuer's bug into a finding about how tokenized pre-IPO equity is issued,
and it is why the PreStocks lane is published as its own lane rather than folded
into one number.

**Continuing after the hackathon.** The feed refreshes every six hours and the
alert lane fires only on a real change, so this is a running monitor rather than
a one-off scan. The lane is guarded: a test fails the build if it is ever dropped
or if a mint appears in both rosters. Tessera is deliberately not integrated, so
the submission stays inside the bounty's token scope.

The one-line fix is `getEffectiveMultiplier(mint)` from `sdk/owed.mjs` - zero
dependencies, no API key.

---

## Pyth bounty variant

**Pyth data does real work in Owed, and we found something about the feeds
themselves on the way.**

Every one of the 933 mints is matched against Pyth's published catalogue: 22
same-asset wrapper feeds, 638 underlying-equity references, 17 redemption rates.
Those references are not decoration - the app shows the issuer's own quote
against its Pyth reference, and the feed publishes the basis per row:

- `basisPct` - the gap between the issuer's quote and its same-asset Pyth feed.
  Live example: **TSLAx at -2.42%** against `Crypto.TSLAX/USD`, flagged.
- The comparison rule and tolerance ship in the feed itself, so any consumer can
  re-derive the number rather than trust it.

**The finding: the prices are read from Solana, not from an API.** Pyth publishes
sponsored price accounts on-chain as PDAs under the receiver program, so Owed
resolves each feed id to its account and parses the price directly from chain
state - no key, no Hermes dependency, and the reference is verifiable in the same
place the asset lives. That is also what let us measure something a consumer
cannot see from an API response:

**16 of the 17 priced xStock wrapper feeds were stale when read** - published 2
to 11 days earlier, with only TSLAx fresh (4 hours). That is measured live, not
sampled. A consumer dividing by a stale oracle price adds an error of the same
class as the multiplier trap this project exists to measure. Owed therefore
publishes `staleReference` instead of a basis whenever the reference is not
fresh, and only compares against a fresh one - which is why exactly one basis
(`TSLAx`, -2.42%) is published today and 16 rows carry no number at all.

The lane is built to be correct with no configuration: it publishes **no number
at all** when prices are unavailable, and a guard test enforces that, because an
invented gap is worse than an absent one.
