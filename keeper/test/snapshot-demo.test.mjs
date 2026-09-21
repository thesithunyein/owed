import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const demoPath = join(dirname(fileURLToPath(import.meta.url)), "..", "demo", "snapshot-demo.mjs");

test("demo synthetic mode runs clean and prints conservation", () => {
  const r = spawnSync(process.execPath, [demoPath], { encoding: "utf8" });
  assert.equal(r.status, 0, `demo exited ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /SYNTHETIC REGISTER/);
  assert.match(r.stdout, /sum == supply: 100 == 100 ✓/);
  assert.match(r.stdout, /root: 0x[0-9a-f]{64}/);
});
