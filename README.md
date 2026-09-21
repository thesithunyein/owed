# Owed — the corporate-actions registry for tokenized equities

> You can buy Apple on-chain at 3am. You just don't get paid.

Tokenized equities on Solana have trading (850,000 holders, $684M supply) but no
**register**: no canonical record of who held what at the record time, no on-chain
settlement of dividends, and no adjustment when the underlying stock splits — which
silently corrupts every dependent price, pool, and loan.

**Owed** is the missing registrar: an on-chain registry and settlement layer where an
issuer declares a corporate action, the holder set is snapshotted at the record slot
into a verifiable Merkle root, and holders claim entitlements with proofs.

## Repository layout

```
owed/
├── programs/owed/        # Anchor (Solana) program: full instruction set
├── core/                 # Rust crate: register, Merkle tree, split/dividend math
├── keeper/               # TypeScript: snapshot builder, divergence monitor, live demo
├── web/                  # Live divergence board (single-file, deployable anywhere)
├── shared/vectors/       # Cross-language golden vectors (generated, committed)
├── scripts/              # Vector generator (Node)
└── docs/                 # SPEC.md, DEMOSCRIPT.md
```

## What is verified in this checkout

| Component | Status |
|---|---|
| `core/` Rust crate | ✅ 21 tests — Merkle (exhaustive n=1..17 + 33, tamper rejection), supply conservation, split/dividend math, **cross-language golden vectors** |
| `keeper/` TypeScript | ✅ 36 tests — byte-identical Merkle conventions, RPC parsing, base58 encode/decode, 500-holder stress register, Pyth auth handling |
| Golden vectors | ✅ Regenerated in CI; a drift fails the build |
| `programs/owed/` Anchor | ⚠️ Reference source. Full instruction set (`initialize_asset`, `set_registrar`, `declare_action`, `snapshot_holders`, `claim`, `settle_action`), typed SPL accounts, escrow-funding check. Requires the Anchor/Solana toolchain to compile — not bundled here |
| `web/` board | ✅ Runs live in any browser; degraded mode when no Pyth key |

## The mechanism (6 instructions)

1. `initialize_asset` — issuer registers a mint (mint-authority checked on-chain).
2. `set_registrar` — issuer delegates snapshot rights to a keeper key (rotatable).
3. `declare_action` — issuer declares dividend / split / merger / ticker change,
   with effective time, ratio or per-token amount, source document hash.
   **Dividends must be fully funded in escrow at declaration** (checked against
   the live mint supply).
4. `snapshot_holders` — registrar freezes the holder set at the record slot. The
   program **enforces supply conservation**: `sum(holder amounts) == mint.supply`,
   plus sorted/unique register. Emits the Merkle root.
5. `claim` — holder proves membership against the root with an explicit-side
   Merkle proof. `ClaimReceipt` PDA makes double claims impossible at the
   account level; totals accumulate in `total_claimed`.
6. `settle_action` — registrar finalizes once the effective timestamp passes.

## The divergence board (`web/`)

The flagship screen: a live board comparing each tokenized equity's on-chain
token price against its Pyth reference, flagging unadjusted corporate actions
(the "quoting 4× the real price" failure). Open `web/index.html` in a browser —
no build step, no server.

**Pyth auth note:** since the Pyth Core upgrade (2026-08-26), Hermes price-data
endpoints require a Bearer API key; feed *metadata* stays open. The board
resolves feeds live without a key and runs in a clearly-labelled DEGRADED mode
(no fabricated numbers) until you paste a key — which stays in your browser's
localStorage. The keeper reads `PYTH_API_KEY` from the env the same way.

## Honest scope boundary

This checkout proves the registry math and the Merkle scheme with runnable tests,
and ships the Anchor program as reference code with typed accounts and on-chain
escrow checks. It does **not** yet include: payout CPIs (escrow transfer /
split mint-to), mainnet deployment, a security review, concurrent-Merkle-tree
scaling for large registers, or issuer integrations. `SECURITY.md` lists the
known limitations a reviewer should read first.

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

# Runnable demo (synthetic register without args; live with a mint)
node keeper/demo/snapshot-demo.mjs [<MINT_ADDRESS>]

# Anchor program (requires anchor toolchain)
cd programs/owed && anchor build && anchor test
```

## License

MIT — Copyright (c) 2026 Sithu Nyein
