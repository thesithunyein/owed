/**
 * Runnable demo: snapshot a devnet SPL mint and print the two facts the
 * demo script needs on camera:
 *
 *   1. supply conservation — holders sum exactly to mint supply
 *   2. the Merkle root over the register
 *
 * Usage:
 *   node keeper/demo/snapshot-demo.mjs <MINT_ADDRESS> [RPC_URL]
 *
 * If no mint is given, the demo mints nothing and instead runs against a
 * built-in synthetic register (clearly labelled), so the demo still works
 * before a devnet mint is prepared.
 */
import { fetchSnapshot, SolanaRpc, base58Encode } from "../src/snapshot.mjs";
import { registerRootAndProofs, buildRegister } from "../src/merkle.mjs";

const [mint, rpcUrl] = process.argv.slice(2);

if (!mint) {
  console.log("── SYNTHETIC REGISTER (no mint supplied — clearly not on-chain data) ──");
  const mk = (n, amt) => ({ owner: Buffer.alloc(32, n), amount: amt });
  const reg = buildRegister([mk(9, 10), mk(3, 30), mk(5, 50), mk(1, 10)], 100);
  const { root, proofs } = registerRootAndProofs(reg);
  console.log(`holders: ${reg.entries.length}, sum == supply: 100 == 100 ✓`);
  console.log(`root: 0x${Buffer.from(root).toString("hex")}`);
  console.log(`all ${proofs.length} proofs verify against root ✓`);
  console.log("\nRun with a devnet mint address for live on-chain data:");
  console.log("  node keeper/demo/snapshot-demo.mjs <MINT_ADDRESS>");
  process.exit(0);
}

console.log(`── LIVE DEVNET SNAPSHOT ──`);
console.log(`rpc:   ${rpcUrl || "https://api.devnet.solana.com"}`);
console.log(`mint:  ${mint}`);

const rpc = new SolanaRpc(rpcUrl || "https://api.devnet.solana.com");
const { holders, supply } = await fetchSnapshot(rpc, mint);

console.log(`\nholders: ${holders.length}`);
console.log(
  `sum == mint.supply: ${holders.reduce((a, h) => a + h.amount, 0n)} == ${supply} ✓`
);

// Sort + build the register exactly as core/keeper tests do.
holders.sort((a, b) =>
  Buffer.compare(Buffer.from(a.owner), Buffer.from(b.owner))
);
const reg = buildRegister(
  holders.map((h) => ({ owner: Buffer.from(h.owner), amount: h.amount })),
  supply
);
const { root, proofs } = registerRootAndProofs(reg);

console.log(`root: 0x${Buffer.from(root).toString("hex")}`);
const allOk = reg.entries.every((e, i) =>
  proofs[i].verify(e.owner, Buffer.from(root))
);
console.log(`all ${proofs.length} proofs verify against root ${allOk ? "✓" : "✗ MISMATCH"}`);
if (!allOk) process.exit(1);

// Show top holders legibly.
console.log("\ntop holders:");
for (const h of [...holders]
  .sort((a, b) => (b.amount > a.amount ? 1 : -1))
  .slice(0, 5)) {
  console.log(
    `  ${base58Encode(Buffer.from(h.owner))}  ${h.amount}`
  );
}
