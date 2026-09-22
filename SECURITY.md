# Security Policy

## Supported scope

Owed is **pre-production research software**. The on-chain program in
`programs/owed/` compiles for SBF and executes end to end in CI, but it has
**never been deployed to a public cluster and has never been audited**. Do not
point it at mainnet assets or real treasuries.

A note on the keypair in this repository: `programs/owed/owed-keypair.json` is
committed on purpose, so the program's address is a single fixed value rather
than one regenerated per build. **It controls nothing.** The program is deployed
to no cluster, and the authority to upgrade it belongs to whatever keypair
deploys it (the `SOLANA_KEYPAIR` secret, for the manual devnet workflow). If you
ever deploy this for real, generate a fresh keypair and treat the deployment
authority as a secret.

Two specific things a reviewer should know before trusting anything downstream:

1. **The settlement test passes, but only on a throwaway validator and on the
   shapes it constructs.** It proves the mechanics — mint deltas, vault
   transfers, replay rejection, the sweep — not that the program is safe against
   an adversarial issuer, registrar, or holder. There is no devnet deployment.
2. **`claim` moves value, which is exactly why it needs review.** It now performs
   the escrow transfer, the split mint, and the reverse-split burn. Every payout
   authority is the asset PDA, signed inside the program — no caller-supplied key
   can move a vault or mint a share — but this is the code where a mistake costs
   tokens rather than a wrong number on a page.

## What is actually verified here

- `core/` (Rust) and `keeper/` (TypeScript) share byte-identical Merkle
  conventions, pinned by committed golden vectors that both languages
  verify in CI (the `vectors` job fails if they drift).
- Supply conservation, sorted/unique registers, split floor-rounding, and
  dividend escrow math are unit-tested in `core/` (21 tests) and `keeper/`
  (34 tests), plus a 500-holder stress register with full proof-set and
  tamper verification.
- The payout mechanics are exercised on a real validator by `tests/owed.mjs` on
  every push: balances are read before and after each claim, so a payout that
  silently did nothing fails the build.
- Everything else — registrar key management, upgrade authority, and the
  operational side — is reference-quality and explicitly marked as such.

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
3. **A cash payout requires the holder to already have an account for the payout
   currency.** `claim` transfers into `holder_payout_account`, which is
   constrained to be the holder's own account for the action's `escrow_mint`. A
   holder without one cannot claim a distribution (their shares are unaffected),
   and the vault keeps the funds until `settle_action` sweeps them to the issuer.
4. **Mint authority is handed to a PDA, and only the issuer can do it.**
   `arm_split_authority` moves the mint authority to the asset PDA so splits can
   be permissionless. The consequence to weigh: no key can mint afterwards, so
   the issuer loses unilateral minting — recovery requires the asset PDA's seeds,
   which only this program holds. That is the intended trade, not an accident,
   but it is irreversible and should be a deliberate decision.
5. **`initialize_asset` is first-come** on the asset PDA: whoever registers
   a mint first sets its issuer. The registration does check that the caller is
   the mint authority, so a mint cannot be claimed by an unrelated party — but a
   production deployment should still add an issuer allowlist.

## Reporting

Open a private security advisory via GitHub
(Security → Report a vulnerability) or contact **sithunyein.mailto@gmail.com**.
Please do not open public issues for exploitable findings.
