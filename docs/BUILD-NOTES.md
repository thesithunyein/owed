# Build and deploy notes

Failure history that makes the artifact more credible, kept out of the README so
the top of the repository stays about the finding rather than the journey.

## The program compiles now, and it took four real bugs to get there

`programs/owed/` shipped as a bare `src/lib.rs` with no crate around it: no
`Cargo.toml`, no `Anchor.toml`, just the default `anchor init` program id. Nothing
could have compiled it, and nothing ever had. Once it was a crate and CI ran a
real build, the compiler found four errors that no amount of reading would have:

| Error | Cause |
|---|---|
| `expected identifier, found '#'` | a `///` doc comment on a **function parameter**, which desugars to an attribute Rust forbids there |
| `unresolved crate solana_program` | `sha256` called it directly without it being a dependency |
| `undeclared type COption` | `mint.mint_authority` is an SPL `COption`; anchor's prelude does not re-export it |
| `Unsupported type` x2 | `Vec<(Pubkey, u64)>` and `Vec<([u8; 32], u8)>` - Anchor's IDL cannot express tuples, so **both instructions were unbuildable** |

The last one is the instructive one: `snapshot_holders` and `claim` were written
in the most natural way to write them and could never have been deployed. They now
take `Vec<HolderEntry>` and `Vec<ProofNode>`, mapping 1:1 onto the core types.

The same lesson recurs in the SBPF deploy path, where a test validator boots with
every feature gate active and therefore rejects an SBPFv0 artifact that devnet and
mainnet accept. Both gates are named in the reproduction block in the README,
because the obvious reading of that failure ("the program is broken") is wrong.

## How the raw reader's byte offsets were established

`core/src/multiplier.rs` reads Token-2022 mints from raw account bytes, because a
program cannot ask an RPC for a parsed account. The offsets it uses were not taken
from documentation:

```text
  0   .. 82    base Mint state
  82  .. 165   zero padding (keeps the legacy 165-byte layout readable)
  165          AccountType byte: 1 = Mint, 2 = Account
  166 ..       TLV entries: type u16 LE, length u16 LE, payload
```

They were read off real mainnet accounts, then confirmed across the whole
catalogue. The extension entry for `ScaledUiAmountConfig` is type 25 with a
56-byte payload; its position in the TLV list is **not fixed**, which the PreStocks
`SPACEX` fixture proves: its scaled entry sits at byte 575 of a 902-byte account,
while the xStocks fixtures put theirs at 275.

Two consequences worth stating plainly:

* A reader that assumes a fixed payload offset passes every xStocks fixture and
  silently misreads a second issuer's assets. That is why the list is walked and
  why `SPACEX` is a committed test fixture rather than a note.
* A legacy SPL mint (82 bytes, no extensions) must answer "no scaled config"
  rather than reading its padding as state. USDC is the committed fixture for
  that branch, and a token account (discriminant 2) must be *rejected*, not
  reported as absent, because the discriminant is the only thing separating a
  holder's balance account from a mint.
