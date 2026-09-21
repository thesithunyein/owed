//! Merkle tree with the exact conventions shared by the keeper and the
//! on-chain program. See crate docs and `docs/SPEC.md` for the byte format.
//!
//! Tree shape: at each level, hashes are **sorted lexicographically**, then
//! paired left/right. An odd trailing hash at any level is carried up by
//! hashing it with itself (duplicated). Proofs record which side each sibling
//! occupied after sorting, so verification is unambiguous at any depth.

use crate::sha256::sha256;

/// Domain-separation prefixes. Changing either breaks every golden vector.
pub const LEAF_PREFIX: u8 = 0x00;
pub const NODE_PREFIX: u8 = 0x01;

/// Hash of a leaf: `sha256(0x00 ++ data)`.
pub fn leaf(data: &[u8]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(data.len() + 1);
    buf.push(LEAF_PREFIX);
    buf.extend_from_slice(data);
    sha256(&buf)
}

/// Hash of an internal node: `sha256(0x01 ++ left ++ right)`.
pub fn node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 65];
    buf[0] = NODE_PREFIX;
    buf[1..33].copy_from_slice(left);
    buf[33..65].copy_from_slice(right);
    sha256(&buf)
}

/// Which side a sibling occupied in the sorted pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiblingSide {
    Left,
    Right,
}

/// A Merkle proof from a leaf to the root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proof {
    pub siblings: Vec<([u8; 32], SiblingSide)>,
}

impl Proof {
    /// Verify the leaf hash `leaf_hash` against `root` using this proof.
    pub fn verify_leaf(&self, leaf_hash: &[u8; 32], root: &[u8; 32]) -> bool {
        let mut cur = *leaf_hash;
        for (sib, side) in &self.siblings {
            cur = match side {
                SiblingSide::Left => node(sib, &cur),
                SiblingSide::Right => node(&cur, sib),
            };
        }
        &cur == root
    }

    /// Verify raw `data` (its prefixed leaf is computed here).
    pub fn verify(&self, data: &[u8], root: &[u8; 32]) -> bool {
        self.verify_leaf(&leaf(data), root)
    }
}

/// Build over raw register entries.
pub fn from_register(entries: &[crate::register::RegisterEntry]) -> ([u8; 32], Vec<Proof>) {
    let leaves: Vec<[u8; 32]> = entries.iter().map(|e| e.leaf_hash()).collect();
    build(&leaves)
}

/// Build a tree over already-hashed `leaves`.
///
/// Returns `(root, proofs)` where `proofs[i]` corresponds to `leaves[i]`.
/// An empty input yields the root `leaf(b"")` with no proofs.
///
/// Implementation note: each node carries the set of original leaf indices it
/// covers, so a sibling hash is appended to *every* leaf under the opposite
/// node. This is what keeps proofs correct through multi-level merges; the
/// cost is O(n log n) index bookkeeping, fine for register-sized inputs.
pub fn build(leaves: &[[u8; 32]]) -> ([u8; 32], Vec<Proof>) {
    if leaves.is_empty() {
        return (leaf(b""), Vec::new());
    }

    let mut proof_tracks: Vec<Vec<([u8; 32], SiblingSide)>> =
        leaves.iter().map(|_| Vec::new()).collect();

    // (hash, original leaf indices covered by this node)
    let mut level: Vec<([u8; 32], Vec<usize>)> = leaves
        .iter()
        .enumerate()
        .map(|(i, h)| (*h, vec![i]))
        .collect();

    while level.len() > 1 {
        level.sort_by(|a, b| a.0.cmp(&b.0));

        let mut next: Vec<([u8; 32], Vec<usize>)> = Vec::with_capacity(level.len().div_ceil(2));

        let mut i = 0;
        while i < level.len() {
            let (lh, lidx) = (level[i].0, level[i].1.clone());
            let odd = i + 1 >= level.len();
            let (rh, ridx) = if odd {
                // Odd trailing node: duplicated onto itself. It covers its
                // leaves ONCE (the duplicate is a hashing device, not a
                // second coverage), and its own proof step is node(x, x).
                (lh, Vec::new())
            } else {
                (level[i + 1].0, level[i + 1].1.clone())
            };

            // Every leaf under the left node needs the right hash on its Right.
            for &idx in &lidx {
                proof_tracks[idx].push((rh, SiblingSide::Right));
            }
            // Every leaf under the right node needs the left hash on its Left.
            if !odd {
                for &idx in &ridx {
                    proof_tracks[idx].push((lh, SiblingSide::Left));
                }
            }

            let mut covered = lidx;
            if !odd {
                covered.extend(ridx);
            }
            next.push((node(&lh, &rh), covered));
            i += 2;
        }

        level = next;
    }

    let root = level[0].0;
    let proofs = proof_tracks
        .into_iter()
        .map(|siblings| Proof { siblings })
        .collect();
    (root, proofs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::register::RegisterEntry;

    #[test]
    fn empty_root_is_leaf_of_empty() {
        let (root, proofs) = build(&[]);
        assert_eq!(root, leaf(b""));
        assert!(proofs.is_empty());
    }

    #[test]
    fn single_leaf_root_is_leaf_with_empty_path() {
        let l = leaf(b"only");
        let (root, proofs) = build(&[l]);
        assert_eq!(root, l);
        assert!(proofs[0].siblings.is_empty());
        assert!(proofs[0].verify(b"only", &root));
    }

    #[test]
    fn two_leaves_sorted_pairing() {
        let a = leaf(b"a");
        let b = leaf(b"b");
        let (left, right) = if a < b { (a, b) } else { (b, a) };
        let (root, proofs) = build(&[a, b]);
        assert_eq!(root, node(&left, &right));
        assert!(proofs[0].verify(b"a", &root));
        assert!(proofs[1].verify(b"b", &root));
    }

    #[test]
    fn odd_count_duplicates_trailing() {
        let leaves: Vec<[u8; 32]> = (0u8..3).map(|i| leaf(&[i])).collect();
        let (root, proofs) = build(&leaves);
        for (i, data) in (0u8..3).map(|i| [i]).enumerate() {
            assert!(proofs[i].verify(&data, &root), "leaf {i} failed");
        }
    }

    #[test]
    fn many_leaves_all_verify_and_tamper_fails() {
        let n = 33u32; // several levels, odd trailing at multiple depths
        let leaves: Vec<[u8; 32]> = (0..n).map(|i| leaf(&i.to_le_bytes())).collect();
        let (root, proofs) = build(&leaves);
        for i in 0..n {
            let data = i.to_le_bytes();
            assert!(proofs[i as usize].verify(&data, &root), "leaf {i} failed");
        }
        assert!(!proofs[5].verify(&999u32.to_le_bytes(), &root));
    }

    #[test]
    fn exhaustive_small_sizes_all_verify() {
        for n in 1..=17u32 {
            let leaves: Vec<[u8; 32]> = (0..n).map(|i| leaf(&(i * 7 % 13).to_le_bytes())).collect();
            let (root, proofs) = build(&leaves);
            for i in 0..n {
                let data = (i * 7 % 13).to_le_bytes();
                assert!(
                    proofs[i as usize].verify(&data, &root),
                    "n={n} leaf {i} failed"
                );
            }
        }
    }

    #[test]
    fn register_roundtrip() {
        let entries: Vec<RegisterEntry> = (1u8..=7)
            .map(|i| RegisterEntry::new([i; 32], 100 - i as u64))
            .collect();
        let total: u64 = entries.iter().map(|e| e.amount).sum();
        let reg = crate::register::Register::new(entries, total).unwrap();
        let (root, proofs) = reg.merkle_root_and_proofs();
        for (i, e) in reg.entries().iter().enumerate() {
            assert!(proofs[i].verify(&e.encode(), &root));
        }
    }
}
