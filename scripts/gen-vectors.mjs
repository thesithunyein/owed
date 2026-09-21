/**
 * Golden vector generator — the single source of truth for Merkle
 * conventions across languages.
 *
 * Writes:
 *   shared/vectors/vectors.json  (consumed by keeper tests)
 *   shared/vectors/vectors.txt   (consumed by core/tests/golden_vectors.rs)
 *
 * Deterministic: same inputs -> byte-identical output, no timestamps.
 * Run from the repo root:  node scripts/gen-vectors.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  leaf,
  buildFromLeafHashes,
  entryLeaf,
  buildRegister,
  registerRootAndProofs,
} from "../keeper/src/merkle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "shared", "vectors");

const hex = (b) => Buffer.from(b).toString("hex");

/** Same deterministic raw data as core/src/merkle.rs tests: u32 LE of (i*7 % 13). */
function rawFor(i) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE((i * 7) % 13);
  return b;
}

/** Mirror of core/src/register.rs tests' owner(n): 32 bytes with [0] = n. */
function owner32(n) {
  const o = Buffer.alloc(32);
  o[0] = n;
  return o;
}

const cases = [];

// Merkle trees, n = 1..=17 and 33 (odd trailing at several depths).
const sizes = [...Array(17).keys()].map((i) => i + 1).concat([33]);
for (const n of sizes) {
  const hashes = [];
  for (let i = 0; i < n; i++) hashes.push(leaf(rawFor(i)));
  const { root } = buildFromLeafHashes(hashes);
  cases.push({
    name: `merkle-n${n}`,
    leaves: hashes.map(hex),
    root: hex(root),
  });
}

// Register case — mirrors register.rs tests: 4 holders summing to 100.
const mk = (n, amt) => ({ owner: owner32(n), amount: amt });
const register = buildRegister(
  [mk(9, 10), mk(3, 30), mk(5, 50), mk(1, 10)],
  100
);
const regRootProofs = registerRootAndProofs(register);
cases.push({
  name: "register-4-holders",
  leaves: register.entries.map((e) => hex(entryLeaf(e.owner, e.amount))),
  root: hex(regRootProofs.root),
});

// --- vectors.json ---
const json = {
  algorithm: "sorted-pairing merkle; leaf=sha256(0x00||data); node=sha256(0x01||l||r); odd trailing node hashes left onto itself",
  generator: "scripts/gen-vectors.mjs",
  cases,
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "vectors.json"), JSON.stringify(json, null, 2) + "\n");

// --- vectors.txt (trivially parseable by the Rust test) ---
// merkle|<name>|<leafhex,leafhex,...>|<roothex>
// register|<name>|<roothex>
const txt = cases
  .map((c) =>
    c.name.startsWith("merkle-")
      ? `merkle|${c.name}|${c.leaves.join(",")}|${c.root}`
      : `register|${c.name}|${c.root}`
  )
  .join("\n") + "\n";
writeFileSync(join(outDir, "vectors.txt"), txt);

console.log(`wrote ${cases.length} cases to shared/vectors/`);
