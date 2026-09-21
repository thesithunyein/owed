/**
 * End-to-end: settle a real corporate action against the Owed registry.
 *
 * ⚠️  THIS FILE HAS NEVER BEEN EXECUTED. It cannot run on the machine where it
 * was written: there is no Anchor CLI, no Solana CLI, no `cargo-build-sbf`, and
 * WSL is unavailable. It is written so that running it produces exactly what the
 * submission needs — transaction signatures for a settled action — and it is
 * marked unverified rather than presented as passing.
 *
 * Run it where the toolchain exists (WSL, a Linux box, or the
 * "Deploy registry to devnet" GitHub workflow):
 *
 *   solana-keygen new --outfile ~/.config/solana/id.json   # if none exists
 *   solana airdrop 2                                        # devnet SOL for fees
 *   npm install
 *   anchor build
 *   anchor keys sync          # writes a real program id into Anchor.toml + lib.rs
 *   anchor test --skip-build  # runs this file against devnet
 *
 * What it does, in order: creates a mint with three holders summing to total
 * supply, registers the asset, declares a 4:1 split, snapshots the holder set
 * (the program enforces sum == supply), then has each holder claim with a Merkle
 * proof, then proves a second claim reverts.
 *
 * Design choice worth noticing: proofs come from `keeper/src/merkle.mjs`, the
 * same module that is already verified byte-for-byte against the Rust core by
 * committed golden vectors. Re-implementing the tree here would test a
 * re-implementation instead of the thing that ships.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { buildRegister, registerRootAndProofs } from "../keeper/src/merkle.mjs";

// Action type codes — must match the constants in programs/owed/src/lib.rs.
const ACTION_SPLIT = 1;

/** Signature log, printed at the end for the submission write-up. */
const signatures = [];
const record = (label, sig) => {
  signatures.push({ label, sig });
  console.log(`  ${label}: ${sig}`);
};

/** A committed, deterministic "filing" hash for the declared action. */
const sha256 = (s) => createHash("sha256").update(s).digest();

describe("owed — settle a 4:1 split on devnet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Owed;
  const payer = provider.wallet.payer ?? Keypair.generate();

  const connection = provider.connection;
  const ownerA = Keypair.generate();
  const ownerB = Keypair.generate();
  const ownerC = Keypair.generate();

  // 100 units split 60 / 40 / 25 does NOT conserve; these do.
  const holders = [
    { owner: ownerA.publicKey, amount: 60 },
    { owner: ownerB.publicKey, amount: 40 },
    { owner: ownerC.publicKey, amount: 25 },
  ];
  const totalSupply = 125n;

  let mint;
  let assetPda;
  let actionPda;

  const [asset] = PublicKey.findProgramAddressSync(
    [Buffer.from("asset"), mint ? mint.toBuffer() : Buffer.alloc(32)],
    program.programId,
  );

  it("creates a mint and distributes tokens to three holders", async () => {
    mint = await createMint(connection, payer, payer.publicKey, null, 0);

    for (const h of holders) {
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        h.owner,
      );
      await mintTo(connection, payer, mint, ata.address, payer, h.amount);
    }

    const supply = await connection.getTokenSupply(mint);
    assert.equal(BigInt(supply.value.amount), totalSupply);
  });

  it("registers the asset", async () => {
    assetPda = asset;
    const sig = await program.methods
      .initializeAsset(payer.publicKey)
      .accounts({
        asset: assetPda,
        mint,
        issuer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    record("initialize_asset", sig);

    const acct = await program.account.asset.fetch(assetPda);
    assert.equal(acct.mint.toBase58(), mint.toBase58());
    assert.equal(acct.actionCount, 0);
  });

  it("declares a 4:1 split", async () => {
    [actionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("action"), assetPda.toBuffer(), Buffer.from([0, 0, 0, 0])],
      program.programId,
    );

    const escrow = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      assetPda,
      true, // allowOwnerOffCurve — the PDA owns the escrow
    );

    const sig = await program.methods
      .declareAction(
        ACTION_SPLIT,
        new anchor.BN(Math.floor(Date.now() / 1000)),
        new anchor.BN(4), // ratio_num
        new anchor.BN(1), // ratio_den
        new anchor.BN(0), // amount_per_token — splits are not cash
        Array.from(sha256("owed:demo:4-for-1-split")),
      )
      .accounts({
        asset: assetPda,
        action: actionPda,
        mint,
        escrow: escrow.address,
        issuer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    record("declare_action", sig);

    const action = await program.account.action.fetch(actionPda);
    assert.equal(action.ratioNum.toNumber(), 4);
  });

  it("snapshots holders, enforcing sum == supply", async () => {
    // Sorted + unique by owner, which the program requires.
    const sorted = [...holders].sort((a, b) =>
      Buffer.compare(a.owner.toBuffer(), b.owner.toBuffer()),
    );

    // First: the conservation check must reject a register that does not sum to
    // supply. Proving the guard works is the point of the instruction.
    let rejected = false;
    try {
      await program.methods
        .snapshotHolders([{ owner: ownerA.publicKey, amount: new anchor.BN(1) }])
        .accounts({
          asset: assetPda,
          action: actionPda,
          mint,
          registrar: payer.publicKey,
        })
        .rpc();
    } catch {
      rejected = true;
    }
    expect(rejected, "supply conservation must reject a short register").to.equal(true);

    // HolderEntry, not a tuple: Anchor's IDL cannot express `(Pubkey, u64)`,
    // which is why the program declares a named struct.
    const sig = await program.methods
      .snapshotHolders(
        sorted.map((h) => ({ owner: h.owner, amount: new anchor.BN(h.amount) })),
      )
      .accounts({
        asset: assetPda,
        action: actionPda,
        mint,
        registrar: payer.publicKey,
      })
      .rpc();
    record("snapshot_holders", sig);

    const action = await program.account.action.fetch(actionPda);
    assert.equal(action.holderCount, 3);
    assert.notDeepEqual(action.merkleRoot, new Array(32).fill(0));
  });

  it("settles every holder's claim with a Merkle proof", async () => {
    const register = buildRegister(
      holders.map((h) => ({ owner: h.owner.toBuffer(), amount: BigInt(h.amount) })),
      totalSupply,
    );
    const { root, proofs } = registerRootAndProofs(register);

    // The register the keeper builds must agree with the root the program
    // stored — otherwise the proofs are worthless.
    const action = await program.account.action.fetch(actionPda);
    assert.equal(
      Buffer.from(action.merkleRoot).toString("hex"),
      Buffer.from(root).toString("hex"),
      "keeper root must equal on-chain root",
    );

    const sorted = register.entries;
    for (let i = 0; i < sorted.length; i += 1) {
      const entry = sorted[i];
      const holderKey = new PublicKey(Buffer.from(entry.owner));
      const proof = proofs[i].siblings.map(([h, side]) => ({
        sibling: Array.from(h),
        side: side === "Left" ? 0 : 1,
      }));

      const [receipt] = PublicKey.findProgramAddressSync(
        [Buffer.from("receipt"), actionPda.toBuffer(), holderKey.toBuffer()],
        program.programId,
      );

      const sig = await program.methods
        .claim(i, new anchor.BN(entry.amount.toString()), proof)
        .accounts({
          action: actionPda,
          holder: holderKey,
          receipt,
          payer: payer.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      record(`claim[${holderKey.toBase58().slice(0, 6)}…]`, sig);
    }
  });

  it("rejects a second claim (ClaimReceipt PDA already exists)", async () => {
    const register = buildRegister(
      holders.map((h) => ({ owner: h.owner.toBuffer(), amount: BigInt(h.amount) })),
      totalSupply,
    );
    const { proofs } = registerRootAndProofs(register);
    const entry = register.entries[0];
    const holderKey = new PublicKey(Buffer.from(entry.owner));
    const proof = proofs[0].siblings.map(([h, side]) => ({
      sibling: Array.from(h),
      side: side === "Left" ? 0 : 1,
    }));
    const [receipt] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), actionPda.toBuffer(), holderKey.toBuffer()],
      program.programId,
    );

    let rejected = false;
    try {
      await program.methods
        .claim(0, new anchor.BN(entry.amount.toString()), proof)
        .accounts({
          action: actionPda,
          holder: holderKey,
          receipt,
          payer: payer.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch {
      rejected = true;
    }
    expect(rejected, "double claim must fail").to.equal(true);
  });

  after(() => {
    console.log("\n=== signatures for the submission ===");
    for (const { label, sig } of signatures) {
      console.log(`${label}\n  https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    }
  });
});
