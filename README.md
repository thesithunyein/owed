# Owed — the corporate-actions risk layer for tokenized equities on Solana

> **Live: <https://owed.sithunyein.com>** · feed: `/feed/owed-risk.json` · schema: `/feed/schema.json`

<!-- owed:stats:start -->
> **379 of 925 official xStocks carry a stale on-chain multiplier field**
> (classified at 2026-09-22 08:13 UTC); 4 are off by 100% or more, and 2 by a full 10x.
> Not in theory: every mint was scanned and the effective value read from the chain.
<!-- owed:stats:end -->

## What we found (live mainnet snapshot)

xStocks (Backed Finance) rebases dividends and splits through the Token-2022
**Scaled UI Amount** extension. The extension stores `multiplier` plus a pending
change with an activation timestamp. The field is **not self-maintaining**: after
an activation passes, the stored `multiplier` keeps the old value until the issuer
overwrites it, while the *effective* multiplier is time-dependent:

```
effective(now) = now >= newMultiplierEffectiveTimestamp ? newMultiplier : multiplier
```

An app that reads the stored field alone — the obvious integration — computes the
wrong price for every affected token. Our full scan of the official mint list:

| Finding | Count |
|---|---|
<!-- owed:table:start -->
| Official xStocks Solana mints scanned | **925** |
| **Reader traps** (activation passed, stored field stale) | **379** |
| … off by **10x** (10-for-1 splits) | **2** (`PPLTx`, `NFLXx`) |
| … off by **≥100%** | **4** |
| … off by **≥1%** | **28** |
| … off by **≥0.5%** | **110** |
| Median magnitude of the gap | **0.32%** |
| Median time already stale | **28 days** |
| Longest stale | **348 days** (`GMEx`) |
| Mints with a **permanent delegate** (issuer can move anyone's tokens) | **925 / 925** |
| Mints with a **pause authority** (issuer can freeze all transfers) | **925 / 925** |
| Currently paused | 0 |
<!-- owed:table:end -->

Most gaps are small — and saying so is the point. `AAPLx` (`XsbEhL…zJp`) has
stored `1.00266…` while `1.00327…` took effect on **2026-08-07**, a 0.06% error.
But the tail is not small: `NFLXx` still carries a stored `1.0` while the chain
applies **10**, 309 days after the split activated. Anyone valuing an `NFLXx`
position from that field is wrong by an order of magnitude, and it has been wrong
since November 2025.

**Precise scope of the claim** (it is falsifiable, so state it precisely): this
traps apps that read `scaledUiAmountConfig.multiplier` from the mint account — the
obvious integration when you cache token config, build an indexer, or value
collateral. Apps that call `getTokenSupply` / `amountToUiAmount` get the correct
effective value from the runtime and are unaffected.

**How the assumption was verified, not assumed.** The whole thesis depends on
Token-2022 applying the pending multiplier automatically once its timestamp
passes. `scripts/verify-trap.mjs` tests that against mainnet instead of reasoning
about it: `getTokenSupply` reports the runtime's effective scaled amount, so the
ratio `uiAmount / rawAmount` is ground truth. Result: **8 of 8 sampled traps match
the pending multiplier, not the stored one** — including `NFLXx` at exactly `10`.

```
node scripts/verify-trap.mjs            # worst offenders, auto-selected
node scripts/verify-trap.mjs AAPLx NFLXx
```

### The reader is verified against the runtime, not just argued for

`scripts/conformance.mjs` checks our rule against the chain mint by mint:
`getTokenSupply` reports the runtime's effective scaled amount, so the ratio it
returns is ground truth.

```
$ node scripts/conformance.mjs --all
924/924 mints match the Token-2022 runtime (tolerance 1e-9), 1 not checked
                          # ARx hit a transient HTTP 403 mid-sweep;
                          # `--only ARx` retried it clean: 1/1
```

That is the **entire official xStocks set — 925 of 925 mints — with our reader
agreeing with the runtime to nine decimal places.** The default `--n` sample is
stratified (every mint with a real gap is included, then the rest filled from
fresh mints), so a pass cannot be earned by only testing mints where the two
readings trivially agree.

### Why this is a settlement bug, not a display bug

`scripts/collateral-scenario.mjs` models the consequence without a price feed: a
valuation is `raw × multiplier × price`, so price and position size cancel out of
the error entirely. What is left is a multiplier ratio, and a loan-to-value is
inflated by exactly that ratio.

| Position genuinely at 10% LTV, 75% liquidation threshold | Outcome |
|---|---|
| The mints at 10× | reads as **100% LTV** → liquidated while healthy |
| Mints in the 2–5× range | reads 20–50% → wrong, not liquidatable |
| Median across the mispriced set | under 1% → immaterial |

**Only the handful at 10× would liquidate a position that is genuinely at 10% LTV.**
Not the whole mispriced set. The rest are wrong in a way that has not yet cost
anyone money, and saying so is the difference between a finding and a sales pitch.
The exact counts are generated above from the published feed, never typed by hand.

And the security surface nobody markets: **every official xStock carries a
permanent delegate and a pause authority.** One compromised issuer key can
confiscate or freeze any holder's balance. Presence is not an attack — but any
protocol integrating these tokens as collateral must know, and none of it is
visible in a wallet UI.

## What Owed ships

**1. `feed/owed-risk.json` — the integration surface.** One document that answers
"what multiplier is in force for this mint, and is anything about it dangerous?"
for all 925 mints, with a JSON Schema at `feed/schema.json`. Two design choices
make it auditable rather than trustworthy-by-assertion:

- It publishes the **raw `scaledUiAmountConfig` state** alongside our answer, so a
  consumer can recompute the rule and disagree with us. A test enforces that every
  published value is reproducible from the published state.
- `effectiveMultiplier` is stamped with the clock it was computed at, because the
  value is time-dependent and a silently stale feed is worse than no feed.

**2. `web/differential.html` — the harm, clickable.** Single self-contained file:
pick a token, enter a position and a debt, and see what a naive reader says beside
what the chain applies, with the liquidation consequence stated plainly. Below it,
every stale multiplier, worst first, re-classified against your clock on load.

**3. `web/board.html` — the risk board.** All 925 mints with stored vs effective
multiplier, gap, days stale, and issuer-control flags. Same offline, no-build
property; optional live re-scan with your own RPC URL.

**4. The correct reader, tested** — `keeper/src/trap.mjs` (`effectiveMultiplier`,
`readerTrapGap`, `matchVerdict`, `classifyRecord`, `summarize`) plus
`keeper/src/scaled.mjs` for parsing the extensions themselves, with tests pinned to
real mainnet account shapes.

**5. The registry primitive (the deeper fix)** — an on-chain corporate-actions
registry: issuer declares an action, the holder set is snapshotted at the record
slot into a Merkle root, holders claim with proofs. `programs/owed/` is the
Anchor reference program; `core/` (Rust) and `keeper/` carry the same math with
cross-language golden vectors.

## What we could not establish

We tried to show that the largest Solana DEX aggregator misstates xStock supply,
and **could not**. `scripts/aggregator-audit.mjs` recovers the aggregator's implied
supply as `marketCap / priceUsd` and compares it to `getTokenSupply`, but the
control tokens miss too — JUP implies 0.48× total supply (vesting), USDC 9.6×
(aggregated across chains). A mismatch is therefore consistent with a different
*supply definition*, not with an inability to read supply. One control one cannot
attribute blame to a single party. The probe is kept as a record of an open
question and is deliberately not cited as evidence anywhere above.

## Repository layout

```
owed/
├── programs/owed/        # Anchor program: initialize_asset, declare/snapshot/claim/settle
├── core/                 # Rust crate: register, Merkle tree, split/dividend math
├── keeper/               # TS: trap logic, scaled reader, snapshot builder, RPC
│   ├── data/             # official mint list, latest scan, conformance reports
│   └── test/             # 73 tests, one live-gated
├── feed/                 # owed-risk.json + schema.json (the integration contract)
├── web/                  # differential.html (harm, clickable) + board.html (risk table)
├── shared/vectors/       # cross-language golden vectors (generated, committed)
├── scripts/              # scan, verify-trap, conformance, collateral, risk-feed, gen-*
└── docs/                 # SPEC.md, DEMOSCRIPT.md

site/                     # deploy output (gitignored) — built by build-site.mjs
```

## What is verified in this checkout

| Component | Status |
|---|---|
| Mainnet scan | ✅ 925/925 mints read and classified via public RPC; snapshot committed |
| **Conformance** | ✅ **925/925 mints** — our reader equals the Token-2022 runtime at 1e-9 relative tolerance across the whole official set (`node scripts/conformance.mjs --all`) |
| **Trap verification** | ✅ 8/8 sampled traps confirmed against `getTokenSupply`; 2 at exactly 10× |
| **Risk feed** | ✅ 925 tokens; every published `effectiveMultiplier` reproducibly recomputed from published raw state (tested) |
| `keeper/` TS | ✅ 73 tests — trap logic, scaled classifier pinned to real account shapes, feed contract, page build integrity, Merkle parity, RPC parsing, base58, 500-holder stress |
| `core/` Rust | ✅ 21 tests — Merkle (exhaustive n=1..17 + 33, tamper rejection), supply conservation, split/dividend math, golden vectors |
| Golden vectors | ✅ Regenerated in CI; Node↔Rust drift fails the build |
| `web/` pages | ✅ Both run from the file system with no network; re-classify against the viewer's clock |
| `tests/owed.mjs` | ✅ **Executed on every push** — the `settlement` CI job deploys to a throwaway validator and settles a 4:1 split end to end, asserting holder balances before and after |
| `programs/owed/` Anchor | ✅ **Compiles for SBF and settles on-chain** — `owed.so` from a real `anchor build`, then the whole lifecycle runs against a validator in CI. Not deployed to devnet, not audited |

## Honest scope boundary

The scanner, reader, feed and pages read real mainnet state and are immediately
useful. The **registry program** now compiles, runs, and settles on a validator —
but it has **never been deployed to a public cluster** and has not been audited.
Its committed ID is still the `anchor init` placeholder; the deploy workflow and
the settlement job each run `anchor keys sync` to generate a real one at run time.

What a settlement actually does, and what CI proves each push:

| Step | Instruction | What moves |
|---|---|---|
| Issuer hands mint control to the registry | `arm_split_authority` | mint authority → asset PDA (unreachable by any key) |
| Registrars freeze the holder set | `snapshot_holders` | nothing — but a register that does not sum to supply is **rejected** |
| Holders collect a 4:1 split | `claim` | +180 / +120 / +75 shares minted to each holder; supply 125 → 500 |
| A replayed claim | `claim` | rejected by the `ClaimReceipt` PDA, not by a weaker proof check |
| Holders collect a distribution | `claim` | payout currency transferred out of the action's vault, pro-rata |
| Registrar closes the action | `settle_action` | unclaimed remainder swept back to the issuer; vault ends at zero |

### The program compiles now — and it took four real bugs to get there

`programs/owed/` shipped as a bare `src/lib.rs` with no crate around it: no
`Cargo.toml`, no `Anchor.toml`, just the default `anchor init` program id. Nothing
could have compiled it, and nothing ever had. Once it was a crate and CI ran a
real build, the compiler found four errors that no amount of reading would have:

| Error | Cause |
|---|---|
| `expected identifier, found '#'` | a `///` doc comment on a **function parameter**, which desugars to an attribute Rust forbids there |
| `unresolved crate solana_program` | `sha256` called it directly without it being a dependency |
| `undeclared type COption` | `mint.mint_authority` is an SPL `COption`; anchor's prelude does not re-export it |
| `Unsupported type` ×2 | `Vec<(Pubkey, u64)>` and `Vec<([u8; 32], u8)>` — Anchor's IDL cannot express tuples, so **both instructions were unbuildable** |

The last one is the instructive one: `snapshot_holders` and `claim` were written
in the most natural way to write them and could never have been deployed. They now
take `Vec<HolderEntry>` and `Vec<ProofNode>`, mapping 1:1 onto the core types.

The settlement above is reproducible by anyone, with no keys and no funded
account:

```bash
npm install
# The program's address is fixed by the committed keypair; do not `keys sync`.
mkdir -p target/deploy && cp programs/owed/owed-keypair.json target/deploy/
# `anchor build` emits an SBPFv3 ELF, which devnet and mainnet both accept:
# their enable_sbpf_v1/v2/v3_deployment_and_execution gates are all active.
# A FRESH LOCAL VALIDATOR, though, starts with no gates and accepts only v0 —
# so a local deploy of this artifact fails with "Detected sbpf_version required
# by the executable which are not enabled" unless the three gates are passed at
# validator start, exactly as the CI settlement job does:
solana-test-validator --reset --ledger .anchor/test-ledger --quiet \
  --activate-feature JE86WkYvTrzW8HgNmrHY7dFYpCmSptUpKupbo2AdQ9cG \
  --activate-feature F6UVKh1ujTEFK3en2SyAL3cdVnqko1FVEXWhmdLRu6WP \
  --activate-feature 5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC &

# A throwaway validator, started and deployed to explicitly. `anchor test`
# manages this itself, but it deploys silently (and not at all with
# --skip-build), so the steps are spelled out. The `mkdir` matters: the validator
# creates the ledger directory but not its parent. The `--activate-feature`
# flags matter: without them a fresh validator accepts only SBPFv0, which no
# current toolchain emits.
mkdir -p .anchor
solana --url http://127.0.0.1:8899 airdrop 500
solana program deploy target/deploy/owed.so \
  --program-id target/deploy/owed-keypair.json --url http://127.0.0.1:8899

# Prints one signature per instruction; writes tests/settlement-report.json
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
ANCHOR_WALLET="$HOME/.config/solana/id.json" \
  npx mocha --timeout 1000000 tests/**/*.mjs
```

That is CI's `settlement` job, and it is a stronger claim than a devnet signature
a judge cannot re-run. **A devnet deployment is still outstanding**: it needs a
funded `SOLANA_KEYPAIR` secret and a manual dispatch of
`.github/workflows/deploy-devnet.yml`.

Two honest limitations remain. `claim` pays a cash action out of the action's
vault in the **payout currency**, so a holder must have an account for that
mint — a deployment where they don't cannot be paid, and the vault stays funded
until settlement sweeps it. And the register is bounded by transaction size;
concurrent Merkle trees are the roadmap. `SECURITY.md` lists what a reviewer
should check first. Nothing here is investment advice.

## Development

```bash
# Rust core (offline, no external crates)
cd core && cargo test

# TypeScript keeper (zero dependencies, hermetic)
cd keeper && node --test

# Live devnet integration test (needs a funded mint)
OWED_LIVE_RPC=1 OWED_TEST_MINT=<addr> node --test test/live.test.mjs

# Regenerate shared golden vectors (CI fails if they drift)
node scripts/gen-vectors.mjs

# Refresh the data, then rebuild every derived artifact
node scripts/scan-xstocks.mjs        # keeper/data/xstocks-scan.json (925 mints)
node scripts/risk-feed.mjs           # feed/owed-risk.json + feed/schema.json
node scripts/conformance.mjs         # keeper/data/conformance.json (live)
node scripts/collateral-scenario.mjs # keeper/data/collateral.json (price-free model)
node scripts/gen-webdata.mjs         # inject into web/board.html + web/differential.html

# Evidence, on demand
node scripts/verify-trap.mjs         # is the stored field really stale?
node scripts/verify-trap.mjs AAPLx NFLXx
node scripts/conformance.mjs --all   # every official mint (925 RPC calls)

# Build and ship the site (site/ is generated, not source)
node scripts/build-site.mjs
cd site && vercel deploy --prod --yes --project owed

# Runnable demo (synthetic register without args; live with a mint)
node keeper/demo/snapshot-demo.mjs [<MINT_ADDRESS>]

# Anchor program (requires the anchor + solana toolchains, Linux/macOS only)
mkdir -p target/deploy && cp programs/owed/owed-keypair.json target/deploy/
anchor build
# Then the validator (with its three --activate-feature flags) + deploy + mocha
# sequence shown in the repro block, or read `.github/workflows/ci.yml`, whose
# `settlement` job is exactly those commands and runs them on every push.
# Then the validator + deploy + mocha sequence shown under "Honest scope
# boundary", or read `.github/workflows/ci.yml`, whose `settlement` job is exactly
# those commands and runs them on every push.
```

## License

MIT — Copyright (c) 2026 Sithu Nyein
