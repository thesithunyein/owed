//! # owed-core
//!
//! Registry and corporate-action math for **Owed** — the corporate-actions
//! registry for tokenized equities.
//!
//! Zero external dependencies by design: the Merkle conventions here must be
//! byte-identical between the Rust core, the TypeScript keeper, and the
//! on-chain program. Golden vectors in `shared/vectors/` are generated once
//! and verified by both languages.
//!
//! Conventions (see `docs/SPEC.md`):
//! * leaf  = SHA-256(`0x00` ++ data)
//! * node  = SHA-256(`0x01` ++ left ++ right)
//! * pairs are sorted lexicographically at every level; an odd trailing pair
//!   hashes the left element twice
//! * empty register root = leaf of the empty byte string

#![forbid(unsafe_code)]

pub mod corporate;
pub mod error;
pub mod merkle;
pub mod register;
pub mod sha256;

pub use error::Error;

/// Result alias used across the crate.
pub type Result<T> = std::result::Result<T, Error>;
