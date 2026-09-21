//! Errors shared by the registry and corporate-action math.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Snapshot holder amounts do not sum to the mint's total supply.
    SupplyMismatch { sum: u128, supply: u64 },
    /// The same owner appears more than once in a register.
    DuplicateOwner,
    /// Merkle proof failed to verify against the recorded root.
    BadProof,
    /// The holder has already claimed this action.
    AlreadyClaimed,
    /// Corporate-action fields are inconsistent with the action type.
    InvalidAction(&'static str),
    /// Arithmetic overflow.
    Overflow,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::SupplyMismatch { sum, supply } => {
                write!(
                    f,
                    "register supply mismatch: holders sum to {sum}, mint supply is {supply}"
                )
            }
            Error::DuplicateOwner => write!(f, "duplicate owner in register"),
            Error::BadProof => write!(f, "merkle proof rejected"),
            Error::AlreadyClaimed => write!(f, "already claimed"),
            Error::InvalidAction(why) => write!(f, "invalid corporate action: {why}"),
            Error::Overflow => write!(f, "arithmetic overflow"),
        }
    }
}

impl std::error::Error for Error {}
