# Security Policy

## Supported scope

Owed is **pre-production, devnet-scoped research software**. The on-chain
program in `programs/owed/` is reference source that has not been compiled,
deployed, or audited. Do not point it at mainnet assets or real treasuries.

## What is actually verified here

- `core/` (Rust) and `keeper/` (TypeScript) share byte-identical Merkle
  conventions, pinned by committed golden vectors that both languages
  verify in CI (the `vectors` job fails if they drift).
- Supply conservation, sorted/unique registers, split floor-rounding, and
  dividend escrow math are unit-tested in `core/` (21 tests) and `keeper/`
  (34 tests), plus a 500-holder stress register with full proof-set and
  tamper verification.
- Everything else — CPI wiring, payout transfer, registrar key management —
  is reference-quality and explicitly marked as such.

## Known limitations (not vulnerabilities, but read before integrating)

1. **`compute_register_root` on-chain is O(n log n) compute and the register
   must fit in one transaction.** Production registers need
   `spl-account-compression` (concurrent Merkle trees). Tracked in the README
   roadmap.
2. **Snapshot is registrar-trusted.** The keeper submits the holder set; the
   program verifies conservation and root math, but cannot verify the keeper
   fetched the *right* set. A malicious registrar could snapshot a stale set
   before the record slot. Mitigation: publish `record_slot` before the
   snapshot and let watchers re-derive and challenge.
3. **Payout CPIs are unwired.** `claim` writes a receipt and updates
   accounting but does not yet transfer tokens. Wiring SPL transfers is
   mechanical but must be reviewed as security-critical code.
4. **`initialize_asset` is first-come** on the asset PDA: whoever registers
   a mint first sets its issuer. For devnet that is fine; a production
   deployment needs an issuer allowlist or issuer-proof registration.

## Reporting

Open a private security advisory via GitHub
(Security → Report a vulnerability) or contact **sithunyein.mailto@gmail.com**.
Please do not open public issues for exploitable findings.
