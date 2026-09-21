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
├── programs/owed/        # Anchor (Solana) program: registry, declare/snapshot/claim
├── core/                 # Rust crate: register, Merkle tree, split/dividend math (offline-tested)
├── keeper/               # TypeScript: snapshot builder, Merkle vectors, divergence monitor
├── shared/vectors/       # Cross-language golden vectors (generated, committed)
├── scripts/              # Vector generator (Node)
└── docs/                 # SPEC.md, DEMOSCRIPT.md
```

## What is verified in this checkout

| Component | Status |
|---|---|
| `core/` Rust crate | ✅ `cargo test` — unit + cross-language golden vectors |
| `keeper/` TypeScript | ✅ `node --test` — Merkle, math parity, vector generation |
| `programs/owed/` Anchor | ⚠️ Reference source. Requires the Anchor/Solana toolchain (`anchor build`), not bundled here |
| Golden vectors | ✅ `node scripts/gen-vectors.mjs` regenerates; Rust & TS both verify against the same committed file |

## The mechanism (3 instructions)

1. `declare_action` — issuer-signed: dividend / split / merger / ticker change,
   with effective time, ratio or per-token amount, source document hash. Dividends
   fund an escrow vault at declaration.
2. `snapshot_holders` — registrar-signed, at the record slot. The program **enforces
   supply conservation**: `sum(holder amounts) == mint.supply`. Emits the Merkle root.
3. `claim` — holder proves membership against the root. Dividends pay pro-rata from
   escrow; splits adjust balances. `ClaimReceipt` prevents double claims.

## Honest scope boundary

This checkout proves the registry math and the Merkle scheme with runnable tests, and
ships the Anchor program as reference code. It does **not** yet include: mainnet
deployment, security review, issuer integrations, or live dividend data feeds.

## Development

```bash
# Rust core (offline, no external crates)
cd core && cargo test

# TypeScript keeper (zero dependencies)
cd keeper && node --test

# Regenerate shared golden vectors
node scripts/gen-vectors.mjs

# Anchor program (requires anchor toolchain)
cd programs/owed && anchor build && anchor test
```

## License

MIT — Copyright (c) 2026 Sithu Nyein
