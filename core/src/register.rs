//! The holder register: canonical entries, leaf encoding, supply checks.

use crate::error::Error;
use crate::merkle;
use crate::Result;

/// One holder's position in a register snapshot.
///
/// The leaf encoding is fixed and shared across languages:
/// `leaf = H(0x00 ++ owner_pubkey(32) ++ amount_u64_le(8))`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisterEntry {
    pub owner: [u8; 32],
    pub amount: u64,
}

impl RegisterEntry {
    pub const ENCODED_LEN: usize = 32 + 8;

    pub fn new(owner: [u8; 32], amount: u64) -> Self {
        RegisterEntry { owner, amount }
    }

    /// Canonical byte encoding used for the Merkle leaf.
    pub fn encode(&self) -> [u8; 40] {
        let mut buf = [0u8; 40];
        buf[..32].copy_from_slice(&self.owner);
        buf[32..].copy_from_slice(&self.amount.to_le_bytes());
        buf
    }

    /// Leaf hash for this entry.
    pub fn leaf_hash(&self) -> [u8; 32] {
        merkle::leaf(&self.encode())
    }
}

/// A validated register snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Register {
    /// Sorted by owner (lexicographic) — the canonical order.
    entries: Vec<RegisterEntry>,
    total_supply: u64,
}

impl Register {
    /// Build a register, enforcing uniqueness and supply conservation.
    ///
    /// This is the off-chain mirror of the on-chain `snapshot_holders`
    /// constraint: the holder amounts must sum exactly to the mint supply.
    pub fn new(mut entries: Vec<RegisterEntry>, total_supply: u64) -> Result<Self> {
        entries.sort_by(|a, b| a.owner.cmp(&b.owner));

        // Duplicate check after sorting: equal neighbours.
        for w in entries.windows(2) {
            if w[0].owner == w[1].owner {
                return Err(Error::DuplicateOwner);
            }
        }

        let sum: u128 = entries.iter().map(|e| e.amount as u128).sum();
        if sum != total_supply as u128 {
            return Err(Error::SupplyMismatch { sum, supply: total_supply });
        }

        Ok(Register { entries, total_supply })
    }

    pub fn entries(&self) -> &[RegisterEntry] {
        &self.entries
    }

    pub fn total_supply(&self) -> u64 {
        self.total_supply
    }

    pub fn holder_count(&self) -> usize {
        self.entries.len()
    }

    /// Merkle root over the register, plus proofs per entry index
    /// (index into the sorted `entries()` slice).
    pub fn merkle_root_and_proofs(&self) -> ([u8; 32], Vec<merkle::Proof>) {
        merkle::from_register(&self.entries)
    }

    /// Prove that `owner` held `amount` in this register.
    pub fn prove(
        &self,
        owner: [u8; 32],
        amount: u64,
    ) -> Result<(merkle::Proof, u32)> {
        let target = RegisterEntry::new(owner, amount);
        let idx = self
            .entries
            .binary_search_by(|e| e.owner.cmp(&owner))
            .map_err(|_| Error::BadProof)?;
        if self.entries[idx] != target {
            return Err(Error::BadProof); // owner exists but amount differs
        }
        let (root, proofs) = self.merkle_root_and_proofs();
        let proof = proofs[idx].clone();
        let _ = root;
        Ok((proof, idx as u32))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(n: u8) -> [u8; 32] {
        let mut o = [0u8; 32];
        o[0] = n;
        o
    }

    #[test]
    fn accepts_conserving_register() {
        let reg = Register::new(
            vec![RegisterEntry::new(owner(1), 60), RegisterEntry::new(owner(2), 40)],
            100,
        )
        .unwrap();
        assert_eq!(reg.holder_count(), 2);
        assert_eq!(reg.total_supply(), 100);
    }

    #[test]
    fn rejects_supply_mismatch() {
        let err = Register::new(
            vec![RegisterEntry::new(owner(1), 60), RegisterEntry::new(owner(2), 39)],
            100,
        )
        .unwrap_err();
        assert_eq!(err, Error::SupplyMismatch { sum: 99, supply: 100 });
    }

    #[test]
    fn rejects_duplicate_owner() {
        let err = Register::new(
            vec![RegisterEntry::new(owner(1), 50), RegisterEntry::new(owner(1), 50)],
            100,
        )
        .unwrap_err();
        assert_eq!(err, Error::DuplicateOwner);
    }

    #[test]
    fn proofs_verify_for_every_holder() {
        let reg = Register::new(
            vec![
                RegisterEntry::new(owner(9), 10),
                RegisterEntry::new(owner(3), 30),
                RegisterEntry::new(owner(5), 50),
                RegisterEntry::new(owner(1), 10),
            ],
            100,
        )
        .unwrap();
        let (root, proofs) = reg.merkle_root_and_proofs();
        for (i, e) in reg.entries().iter().enumerate() {
            assert!(proofs[i].verify(&e.encode(), &root));
        }
        // A wrong amount for a real owner must not verify.
        assert!(reg.prove(owner(3), 31).is_err());
    }
}
