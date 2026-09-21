# Owed — Demo Script

The 90-second walkthrough. Every screen shows a fact a judge can verify.

---

## 0. The line (0:00–0:10)

> "On a stock split day, a tokenized equity that nobody adjusted is quoting
> the wrong price on every Solana AMM — 4× wrong for a 4-for-1 split — and
> nothing tells the pools, the lenders, or the holders.
> Owed is the register that fixes it."

## 1. The live divergence board (0:10–0:35)

Open the board. Point at real prices:

* Pyth reference for the underlying (live).
* On-chain token price (live, DexScreener/Jupiter).
* The gap, and whether it is flagged.

Say: *"These prices are fetched live right now. The flagged row is a token
that missed its corporate action — every pool pricing off it is mispriced
until someone adjusts."*

## 2. The register snapshot (0:35–0:55)

Run the snapshot in the terminal against devnet:

```
node keeper/demo/snapshot-demo.mjs
```

Show the two invariants printing:

* `holders: N, sum == mint.supply ✓` — supply conservation enforced.
* `root: 0x…` — the Merkle root that will anchor every claim.

Say: *"The register is the thing brokerages have and blockchains don't.
This is the shareholder roll, frozen at the record slot, verifiable by
anyone."*

## 3. The claim (0:55–1:15)

Show a claim transaction on devnet, then click the Explorer link:

* Proof verifies, entitlement lands.
* Second attempt with the same wallet **fails at account creation** —
  the `ClaimReceipt` PDA already exists.

Say: *"Double claims aren't blocked by our bookkeeping — they're blocked
by the account model itself."*

## 4. What's honest (1:15–1:30)

> "What you just saw is real: the register, the conservation check, the
> Merkle settlement, the live divergence monitor. What is simulated today:
> issuer declarations are seeded, not pulled from filings — that's the
> integration this roadmap is for."

## 5. Why Solana (1:30–1:40)

> "97% of on-chain equity volume settles here. A register for tokenized
> equities only matters on the chain where the equities actually are."

---

## Definition of done for this script

- [ ] Board shows live Pyth + DEX prices at recording time
- [ ] Snapshot demo prints conservation + root from a real devnet mint
- [ ] Claim tx link opens on Solana Explorer
- [ ] Double-claim rejection captured on camera
- [ ] The honesty line is in the video, not just the README
