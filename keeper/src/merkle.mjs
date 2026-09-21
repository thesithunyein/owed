/**
 * Merkle conventions shared with owed-core (Rust) and the on-chain program.
 *
 * MUST stay byte-identical to core/src/merkle.rs:
 *   leaf = sha256(0x00 ++ data)
 *   node = sha256(0x01 ++ left ++ right)
 *   levels are sorted lexicographically before pairing;
 *   an odd trailing hash is duplicated onto itself.
 *
 * Golden vectors in ../shared/vectors/ pin these conventions across languages.
 */
import { createHash } from "node:crypto";

export const LEAF_PREFIX = 0x00;
export const NODE_PREFIX = 0x01;

export function sha256(data) {
  return createHash("sha256").update(data).digest();
}

export function leaf(data) {
  return sha256(Buffer.concat([Buffer.from([LEAF_PREFIX]), data]));
}

export function node(left, right) {
  return sha256(
    Buffer.concat([Buffer.from([NODE_PREFIX]), left, right])
  );
}

/** Build a tree over Buffers/typed-arrays of raw leaf DATA.
 *  Returns { root, proofs } where proofs[i] verifies data[i].
 *  Each node carries the original indices it covers (same algorithm as
 *  merkle::build in owed-core). */
export function buildFromData(datas) {
  const leaves = datas.map((d) => leaf(Buffer.from(d)));
  return buildFromLeafHashes(leaves);
}

/** Build over already-hashed leaves. Index alignment matches input order. */
export function buildFromLeafHashes(leaves) {
  if (leaves.length === 0) {
    return { root: leaf(Buffer.alloc(0)), proofs: [] };
  }

  const proofTracks = leaves.map(() => []);
  // (hashHex, coveredIndices)
  let level = leaves.map((h, i) => [h.toString("hex"), [i]]);

  while (level.length > 1) {
    level.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const next = [];

    for (let i = 0; i < level.length; i += 2) {
      const odd = i + 1 >= level.length;
      const [lh, lidx] = level[i];
      const [rh, ridx] = odd ? [lh, []] : level[i + 1];

      const leftBuf = Buffer.from(lh, "hex");
      const rightBuf = Buffer.from(rh, "hex");

      for (const idx of lidx) proofTracks[idx].push([rh, "Right"]);
      if (!odd) for (const idx of ridx) proofTracks[idx].push([lh, "Left"]);

      const covered = odd ? [...lidx] : [...lidx, ...ridx];
      next.push([node(leftBuf, rightBuf).toString("hex"), covered]);
    }

    level = next;
  }

  const root = Buffer.from(level[0][0], "hex");
  const proofs = proofTracks.map((siblings) => ({
    siblings: siblings.map(([h, side]) => [Buffer.from(h, "hex"), side]),
    verify(data, rootBuf) {
      let cur = leaf(Buffer.from(data));
      for (const [sib, side] of this.siblings) {
        cur = side === "Left" ? node(sib, cur) : node(cur, sib);
      }
      return cur.equals(rootBuf);
    },
  }));

  return { root, proofs };
}

/** Register entry encoding — MUST match register.rs:
 *  owner(32 bytes) ++ amount_u64_le(8 bytes); leaf over that. */
export function encodeEntry(owner32, amountU64) {
  if (owner32.length !== 32) throw new Error("owner must be 32 bytes");
  const buf = Buffer.alloc(40);
  Buffer.from(owner32).copy(buf, 0);
  buf.writeBigUInt64LE(BigInt(amountU64), 32);
  return buf;
}

export function entryLeaf(owner32, amountU64) {
  return leaf(encodeEntry(owner32, amountU64));
}

/** Build a register like Register::new: sorted by owner, uniqueness and
 *  supply conservation enforced. Throws on violation. */
export function buildRegister(entries, totalSupply) {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.owner), Buffer.from(b.owner))
  );
  for (let i = 1; i < sorted.length; i++) {
    if (Buffer.compare(sorted[i - 1].owner, sorted[i].owner) === 0) {
      throw new Error("duplicate owner in register");
    }
  }
  const sum = sorted.reduce((acc, e) => acc + BigInt(e.amount), 0n);
  if (sum !== BigInt(totalSupply)) {
    throw new Error(
      `supply mismatch: holders sum to ${sum}, mint supply is ${totalSupply}`
    );
  }
  return { entries: sorted, totalSupply: BigInt(totalSupply) };
}

/** Root + proofs for a built register. */
export function registerRootAndProofs(register) {
  const leaves = register.entries.map((e) =>
    entryLeaf(e.owner, e.amount)
  );
  return buildFromLeafHashes(leaves);
}
