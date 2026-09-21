# Owed — the corporate-actions risk layer for tokenized equities on Solana

> **379 of 925 official xStocks have a stale on-chain multiplier field right now,
> and 5 of them are off by 100% or more — two by a full 10x.** Not in theory: we
> scanned every mint and verified the effective value against the chain.

## What we found (all verified live on mainnet, 2026-09-21)

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
| Official xStocks Solana mints scanned | **925** |
| **Reader traps** (activation passed, stored field stale) | **379** |
| … off by **10x** (10-for-1 splits) | **2** (`PPLTx`, `NFLXx`) |
| … off by **≥100%** | **5** |
| … off by **≥1%** | **29** |
| … off by **≥0.5%** | **111** |
| Median magnitude of the gap | **0.32%** |
| Median time already stale | **28 days** |
| Longest stale | **348 days** (`GMEx`) |
| Mints with a **permanent delegate** (issuer can move anyone's tokens) | **925 / 925** |
| Mints with a **pause authority** (issuer can freeze all transfers) | **925 / 925** |
| Currently paused | 0 |

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

And the security surface nobody markets: **every official xStock carries a
permanent delegate and a pause authority.** One compromised issuer key can
confiscate or freeze any holder's balance. Presence is not an attack — but any
protocol integrating these tokens as collateral must know, and none of it is
visible in a wallet UI.

## What Owed ships

**1. The risk board** — `web/board.html`, a single self-contained file (open it,
no server, no build):

- All 925 mints with stored vs **time-correct effective** multiplier, Δ%, how long
  it has been stale, and issuer-control flags.
- The snapshot is embedded at build time and **re-classified against your local
  clock on every render** — rows flip from SCHEDULED to READER TRAP the moment an
  activation passes, with no server and no API key.
- **Live re-scan** (optional): public RPCs reject browser origins, so you paste
  your own RPC URL (Helius/QuickNode); it stays in `localStorage`.

**2. The correct reader, tested** — `keeper/src/scaled.mjs`:
`classifyScaled` / `extractExtensions` / `readScaledMint` / `scaledAmount`, with
tests pinned to the real mainnet account shape (including the gotcha that
security surfaces are *sibling extensions*, not fields of the scaled config).

**3. The full-mint scanner** — `scripts/scan-xstocks.mjs` (Node, public RPC,
chunked `getMultipleAccounts`, retries, timeouts):

```bash
node scripts/scan-xstocks.mjs   # refreshes keeper/data/xstocks-scan.json
node scripts/gen-webdata.mjs    # injects scan + asset list into the board
```

**4. The registry primitive (the deeper fix)** — an on-chain corporate-actions
registry: issuer declares an action, the holder set is snapshotted at the record
slot into a Merkle root, holders claim with proofs. `programs/owed/` is the
Anchor reference program; `core/` (Rust) and `keeper/` carry the same math with
cross-language golden vectors.

## Repository layout

```
owed/
├── programs/owed/        # Anchor program: initialize_asset, declare/snapshot/claim/settle
├── core/                 # Rust crate: register, Merkle tree, split/dividend math
├── keeper/               # TS: scaled reader, snapshot builder, RPC, demo
│   └── data/             # official mint list + latest scan (committed)
├── web/                  # board.html (self-contained) + index.html (price board)
├── shared/vectors/       # cross-language golden vectors (generated, committed)
├── scripts/              # gen-vectors, gen-webdata, scan-xstocks
└── docs/                 # SPEC.md, DEMOSCRIPT.md
```

## What is verified in this checkout

| Component | Status |
|---|---|
| Mainnet scan | ✅ 925/925 mints read and classified via public RPC; snapshot committed |
| `keeper/` TS | ✅ 47 tests — scaled classifier (pinned to real account shapes), Merkle parity, RPC parsing, base58, 500-holder stress, Pyth auth handling |
| `core/` Rust | ✅ 21 tests — Merkle (exhaustive n=1..17 + 33, tamper rejection), supply conservation, split/dividend math, golden vectors |
| Golden vectors | ✅ Regenerated in CI; Node↔Rust drift fails the build |
| `web/board.html` | ✅ Runs from the file system; re-classifies live; embedded snapshot |
| `programs/owed/` Anchor | ⚠️ Reference source with typed SPL accounts and escrow checks — needs the Anchor toolchain to compile; not audited |

## Honest scope boundary

The board and scanner read real mainnet state and are immediately useful. The
registry program is reference code: no deployment, no audit, payout CPIs unwired,
register bounded by transaction size (concurrent Merkle trees are the roadmap).
`SECURITY.md` lists what a reviewer should check first. Nothing here is
investment advice.

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

# Re-scan all xStocks mints + rebuild the board snapshot
node scripts/scan-xstocks.mjs && node scripts/gen-webdata.mjs

# Runnable demo (synthetic register without args; live with a mint)
node keeper/demo/snapshot-demo.mjs [<MINT_ADDRESS>]

# Anchor program (requires anchor toolchain)
cd programs/owed && anchor build && anchor test
```

## License

MIT — Copyright (c) 2026 Sithu Nyein
