import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyScaled,
  extractExtensions,
  readScaledMint,
  scaledAmount,
} from "../src/scaled.mjs";

const NOW = 1_800_000_000; // fixed "now" for determinism (2027-01-15)

// Real AAPLx mainnet state (captured 2026-09-21).
const AAPLX_LIKE = {
  multiplier: "1.0026642075893797",
  newMultiplier: "1.0032690125398187",
  newMultiplierEffectiveTimestamp: 1_786_149_000, // 2026-08-07 — before NOW
};

test("classify: activation passed -> effective is newMultiplier, readerTrap flagged", () => {
  const c = classifyScaled(AAPLX_LIKE, NOW);
  assert.equal(c.effective, 1.0032690125398187);
  assert.equal(c.readerTrap, true);
  assert.equal(c.pending, false);
});

test("classify: pending activation -> effective is old multiplier until ts", () => {
  const future = { ...AAPLX_LIKE, newMultiplierEffectiveTimestamp: NOW + 86_400 };
  const c = classifyScaled(future, NOW);
  assert.equal(c.effective, 1.0026642075893797);
  assert.equal(c.readerTrap, false);
  assert.equal(c.pending, true);
});

test("classify: no pending change -> plain passthrough", () => {
  const c = classifyScaled(
    { multiplier: "2.5", newMultiplier: "2.5", newMultiplierEffectiveTimestamp: 0 },
    NOW
  );
  assert.equal(c.effective, 2.5);
  assert.equal(c.readerTrap, false);
  assert.equal(c.pending, false);
});

test("classify: boundary — exactly at activation ts, new multiplier applies", () => {
  const at = { ...AAPLX_LIKE, newMultiplierEffectiveTimestamp: NOW };
  const c = classifyScaled(at, NOW);
  assert.equal(c.effective, 1.0032690125398187);
  assert.equal(c.readerTrap, true);
});

test("classify: security surfaces read from the separate mint-level extensions, not the scaled state", () => {
  // This is the shape real mainnet AAPLx returns: security surfaces are
  // sibling extensions of scaledUiAmountConfig, never fields inside it.
  const mintInfo = {
    decimals: 8,
    supply: "15376320604143",
    extensions: [
      { extension: "scaledUiAmountConfig", state: AAPLX_LIKE },
      { extension: "pausableConfig", state: { authority: "a", paused: false } },
      { extension: "permanentDelegate", state: { delegate: "b" } },
      { extension: "transferHook", state: { authority: "c", programId: null } },
    ],
  };
  const ext = extractExtensions({ data: { parsed: { info: mintInfo } } });
  const c = classifyScaled(ext.scaled, NOW, ext);
  assert.equal(c.security.permanentDelegate, true);
  assert.equal(c.security.pausable, true);
  assert.equal(c.security.paused, false);
  assert.equal(c.security.transferHook, null);
});

test("readScaledMint: end-to-end on the real AAPLx mint shape (trap + surfaces)", () => {
  const mintInfo = {
    decimals: 8,
    supply: "15376320604143",
    extensions: [
      { extension: "scaledUiAmountConfig", state: AAPLX_LIKE },
      { extension: "pausableConfig", state: { authority: "a", paused: false } },
      { extension: "permanentDelegate", state: { delegate: "b" } },
    ],
  };
  const m = readScaledMint({ data: { parsed: { info: mintInfo } } }, NOW);
  assert.equal(m.scaled.readerTrap, true);
  assert.equal(m.scaled.security.permanentDelegate, true);
  assert.equal(m.scaled.security.pausable, true);
});

test("classify: security surfaces recorded (explicit args)", () => {
  const c = classifyScaled(AAPLX_LIKE, NOW, {
    permanentDelegate: { delegate: "x" },
    pausable: { authority: "a", paused: false },
  });
  assert.equal(c.security.permanentDelegate, true);
  assert.equal(c.security.pausable, true);
  assert.equal(c.security.paused, false);
});

test("classify: default security arg -> no surfaces reported", () => {
  const c = classifyScaled(AAPLX_LIKE, NOW);
  assert.equal(c.security.permanentDelegate, false);
  assert.equal(c.security.pausable, false);
  assert.equal(c.security.transferHook, null);
});

test("extract: parses jsonParsed mint with extensions", () => {
  const v = {
    data: {
      parsed: {
        info: {
          decimals: 8,
          supply: "15376320604143",
          extensions: [
            { extension: "scaledUiAmountConfig", state: AAPLX_LIKE },
            { extension: "pausableConfig", state: { authority: "a", paused: false } },
            { extension: "permanentDelegate", state: { delegate: "b" } },
          ],
        },
      },
    },
  };
  const e = extractExtensions(v);
  assert.equal(e.decimals, 8);
  assert.equal(e.scaled.multiplier, "1.0026642075893797");
  assert.equal(e.pausable.paused, false);
  assert.ok(e.permanentDelegate);
});

test("scaledAmount: raw * multiplier with 1e9 fixed-point", () => {
  // 1_000_000_000 raw (1.0 token) * 1.00327 -> 1_003_270_000 (approx)
  const out = scaledAmount(1_000_000_000n, 1.0032690125398187);
  assert.equal(out, 1_003_269_013n);
});

test("classify: null state -> null (non-scaled mints skip cleanly)", () => {
  assert.equal(classifyScaled(null, NOW), null);
});
