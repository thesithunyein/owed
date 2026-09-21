import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  leaf,
  node,
  sha256,
  buildFromLeafHashes,
  buildFromData,
  encodeEntry,
  entryLeaf,
  buildRegister,
  registerRootAndProofs,
} from "../src/merkle.mjs";

const hex = (b) => Buffer.from(b).toString("hex");

test("sha256 known digests (FIPS vectors)", () => {
  assert.equal(
    hex(sha256(Buffer.from("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.equal(
    hex(sha256(Buffer.alloc(0))),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});

test("leaf/node domain separation matches spec", () => {
  const d = Buffer.from("x");
  assert.equal(
    hex(leaf(d)),
    hex(sha256(Buffer.concat([Buffer.from([0x00]), d])))
  );
  const a = Buffer.alloc(32, 1);
  const b = Buffer.alloc(32, 2);
  assert.equal(
    hex(node(a, b)),
    hex(sha256(Buffer.concat([Buffer.from([0x01]), a, b])))
  );
});

test("golden vectors: TS verifies every committed vector", () => {
  const vectors = JSON.parse(
    readFileSync(new URL("../../shared/vectors/vectors.json", import.meta.url))
  );
  for (const v of vectors.cases) {
    const leaves = v.leaves.map((h) => Buffer.from(h, "hex"));
    const { root, proofs } = buildFromLeafHashes(leaves);
    assert.equal(hex(root), v.root, `case ${v.name}: root mismatch`);
    for (let i = 0; i < leaves.length; i++) {
      const cur = (() => {
        let c = leaves[i];
        for (const [sib, side] of proofs[i].siblings) {
          c = side === "Left" ? node(sib, c) : node(c, sib);
        }
        return c;
      })();
      assert.equal(hex(cur), v.root, `case ${v.name}: proof ${i} failed`);
    }
  }
});

test("register: supply conservation enforced", () => {
  const o1 = Buffer.alloc(32, 1);
  const o2 = Buffer.alloc(32, 2);
  assert.throws(
    () => buildRegister([{ owner: o1, amount: 60 }, { owner: o2, amount: 39 }], 100),
    /supply mismatch/
  );
  // Duplicate owner rejected.
  assert.throws(
    () => buildRegister([{ owner: o1, amount: 50 }, { owner: Buffer.from(o1), amount: 50 }], 100),
    /duplicate owner/
  );
});

test("register: entry encoding matches Rust layout", () => {
  const owner = Buffer.alloc(32, 7);
  const enc = encodeEntry(owner, 123456789n);
  assert.equal(enc.length, 40);
  assert.equal(enc.readBigUInt64LE(32), 123456789n);
  assert.equal(hex(enc.subarray(0, 32)), hex(owner));
});

test("parity with Rust core on register root", () => {
  // Same register as core/src/register.rs tests: 4 holders summing to 100.
  const mk = (n, amt) => ({ owner: Buffer.alloc(32, n), amount: amt });
  const reg = buildRegister([mk(9, 10), mk(3, 30), mk(5, 50), mk(1, 10)], 100);
  const { root, proofs } = registerRootAndProofs(reg);
  assert.equal(root.length, 32);
  for (let i = 0; i < reg.entries.length; i++) {
    const e = reg.entries[i];
    const ok = proofs[i].verify(encodeEntry(e.owner, e.amount), root);
    assert.ok(ok, `holder ${i} proof failed`);
  }
});

test("buildFromData end-to-end with 33 leaves", () => {
  const datas = [];
  for (let i = 0; i < 33; i++) datas.push(Buffer.from([i % 251]));
  const { root, proofs } = buildFromData(datas);
  for (let i = 0; i < 33; i++) {
    assert.ok(proofs[i].verify(datas[i], root), `leaf ${i} failed`);
  }
});
