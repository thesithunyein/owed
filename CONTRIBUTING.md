# Contributing to Owed

Read this before opening a pull request. It is short on purpose: the fastest way
to get a change merged is to make it easy to verify.

## What this project is

Owed is a correctness layer for tokenized equities on Solana: it measures what
the Token-2022 runtime actually applies to a mint versus what a naive reader
would compute, publishes the difference as an auditable feed, and ships a
registry that settles corporate actions correctly on-chain. The project's entire
value is that its claims are checkable — every contribution either strengthens
that property or it does not.

## The standard every change must meet

1. **Claims are derived, never typed.** Numbers that appear in the README, the
   pages, or the feed come from generators (`scripts/gen-webdata.mjs`) or tests
   that fail when they drift. If your change adds a number, add it to the
   generator and the guard, not by hand.
2. **Every claim about a chain is backed by an artifact.** A transaction cited
   in a page or README must appear in a committed record under `docs/`
   (`build-integrity.test.mjs` enforces this). No placeholder signatures,
   invented addresses, or "example" links.
3. **The offline tests stay hermetic.** `keeper` has zero runtime dependencies
   and `core` has no external crates, on purpose. A change that adds a dependency
   needs a reason stronger than convenience.
4. **Golden vectors are shared, not duplicated.** The Rust core and the
   TypeScript keeper must agree byte-for-byte on the Merkle conventions; both
   verify committed vectors in CI. Changing either side means regenerating with
   `node scripts/gen-vectors.mjs` and committing both.
5. **Honesty about scope.** `SECURITY.md` and the README say exactly what is
   verified and what is not (unaudited program, devnet only, snapshot data). A
   change that makes any of those claims stale must update them in the same
   commit.

## Working on it

```bash
# Rust core (offline, no external crates)
(cd core && cargo test && cargo clippy -- -D warnings)

# TypeScript keeper (zero dependencies, hermetic)
(cd keeper && npm ci && node --test)

# Regenerate pages/README/feeds after touching data or generators
node scripts/scan-xstocks.mjs && node scripts/risk-feed.mjs \
  && node scripts/conformance.mjs && node scripts/gen-webdata.mjs

# The site is generated, not source — never edit site/ directly
node scripts/build-site.mjs

# Anchor program (Linux/macOS toolchain; CI is the reference environment)
anchor build && anchor test
```

`node --test` in `keeper/` and `cargo test` in `core/` must pass with no network.
CI runs the same suites plus the on-chain settlement; if CI is red on your
branch, fix or revert — the branch protection expects green.

## Pull requests

- One logical change per PR; describe **why** in the body, not just what.
- New scripts carry the same comment standard as the existing ones: a reader
  should be able to reconstruct the decision, not just the command.
- If your change touches the Merkle wire format, the on-chain program, or the
  feed schema, call it out in the title — those are the load-bearing pieces.
- Security-sensitive findings: do **not** open a public issue. Follow
  `SECURITY.md`.

## Behaviour

Interactions in every project space follow `CODE_OF_CONDUCT.md`. The one-line
version: critique the work, not the person.
