# Owed Protocol Specification

Version 0.1 — September 2026
Status: draft, devnet-scoped

## 1. Purpose

Owed is a registry and settlement layer for corporate actions on tokenized
equities: dividends, splits, mergers, and ticker changes. It answers, on-chain
and verifiably, the question every other system answers off-chain:

> **Who held this asset at the record time, and what are they owed?**

## 2. Roles

| Role | Key | Powers |
|---|---|---|
| **Issuer** | `asset.issuer_authority` | Declares actions, funds dividend escrow, delegates the registrar |
| **Registrar / Keeper** | `asset.registrar` | Submits holder snapshots at record slots |
| **Holder** | any wallet | Claims entitlements with Merkle proofs |

## 3. Lifecycle

```
declare_action ──► snapshot_holders ──► claim(s) ──► settled
   (issuer)          (registrar)         (holders)
```

An `Action` moves `Declared → Snapshotted → Settled` and never backwards.

## 4. Canonical encodings (normative)

These are shared byte-for-byte across `core/` (Rust), `keeper/` (TypeScript),
and the on-chain program. Golden vectors in `shared/vectors/` pin them.

### 4.1 Register entry (40 bytes)

```
owner_pubkey[32] ++ amount_u64_little_endian[8]
```

### 4.2 Hashes

```
leaf = SHA-256(0x00 ++ entry_bytes)
node = SHA-256(0x01 ++ left ++ right)
```

### 4.3 Tree shape

At every level, hashes are sorted lexicographically, then paired. An odd
trailing hash is hashed with itself (`node(h, h)`). The empty register's root
is `leaf(empty)`.

### 4.4 Proofs

A proof is an ordered list of `(sibling, side)` from leaf to root.
`side ∈ {Left, Right}` is the position the **sibling** occupied in the sorted
pair. Verification applies them bottom-up; one direction per level.

## 5. Invariants (enforced on-chain, mirrored off-chain)

1. **Supply conservation** — every snapshot's holder amounts must sum exactly
   to the mint supply at the record slot. No exceptions.
2. **Register order** — entries sorted by owner, no duplicates.
3. **Single claim** — one `ClaimReceipt` PDA per `(action, holder)`; the PDA
   seeds make a second claim impossible, not merely discouraged.
4. **Issuer authority** — only `issuer_authority` declares actions.
5. **Rounding** — split adjustments floor per holder
   (`floor(balance × num / den)`); dividend entitlements are
   `balance × amount_per_token` in u128. Floor dust is not minted.

## 6. Price-reference semantics

After a `SPLIT` of `num/den`, the expected token reference price becomes
`reference × num / den`. A token still quoting pre-split prices against the
adjusted underlying exhibits a `4×`-class divergence — Owed's divergence
monitor flags exactly this, live, from Pyth and DEX prices.

## 7. Out of scope for v0

* Real-world legal transfer agency (see the legal note in README).
* Corporate-action *discovery* — declarations are issuer-attested; automating
  discovery from filings is future work.
* SPL token CPIs in the reference program (math is proven in `core/`; wiring
  is mechanical).
