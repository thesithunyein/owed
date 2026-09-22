/**
 * End-to-end settlement: the registry does not just record entitlements, it
 * moves value.
 *
 * Runs against whatever cluster `AnchorProvider.env()` points at:
 *
 *   anchor test                 # local validator, fully hermetic, no keypair
 *   anchor test --skip-build    # same, without rebuilding
 *
 * and the "Deploy registry to devnet" workflow runs it against devnet with a
 * funded keypair. The local-validator path is the important one: a judge can
 * reproduce the entire settlement from a clone, with no keys and no funded
 * account, and watch the balances change.
 *
 * What it proves, in order:
 *   1. the issuer hands mint authority to the registry (arm_split_authority)
 *   2. a 4-for-1 split is declared and the holder set is frozen
 *      — and a register that does not sum to supply is REJECTED
 *   3. every holder's claim actually mints their 3x delta, checked by reading
 *      their token account before and after (60 -> 240, 40 -> 160, 25 -> 100,
 *      supply 125 -> 500)
 *   4. a second claim reverts
 *   5. a cash action pays pro-rata out of the vault in a *different* mint, and
 *      settle_action sweeps the unclaimed remainder back to the issuer, leaving
 *      the vault at zero
 *
 * Proofs come from `keeper/src/merkle.mjs` — the same module verified
 * byte-for-byte against the Rust core by committed golden vectors.
 * Re-implementing the tree here would test a re-implementation instead of the
 * thing that ships.
 */

import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  getMint,
  mintTo,
  transfer,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { buildRegister, registerRootAndProofs } from "../keeper/src/merkle.mjs";

// Action type codes — must match the constants in programs/owed/src/lib.rs.
const ACTION_DIVIDEND = 0;
const ACTION_SPLIT = 1;

// Payout modes — must match the PAYOUT_* constants.
const PAYOUT_NONE = 0;
const PAYOUT_ESCROW = 1;
const PAYOUT_MINT = 2;
const PAYOUT_BURN = 3;

/** Entitlement math, as an independent check on what the program did. */
const entitledShares = (held, num, den) => (held * num) / den;

const sha256 = (s) => createHash("sha256").update(s).digest();

/** Everything a submission or a skeptic needs, written to disk at the end. */
const report = {
  generatedAt: new Date().toISOString(),
  steps: [],
  actions: [],
};

const record = (label, sig, extra = {}) => {
  const entry = { label, signature: sig, ...extra };
  report.steps.push(entry);
  console.log(`  ${label}: ${sig}`);
  return entry;
};

/** Convert keeper proof siblings into the program's ProofNode wire shape. */
const toProof = (siblings) =>
  siblings.map(([hash, side]) => ({
    sibling: Array.from(hash),
    side: side === "Left" ? 0 : 1,
  }));

describe("owed — settle corporate actions end to end", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Owed;
  const connection = provider.connection;
  const payer = provider.wallet.payer ?? Keypair.generate();

  before(async () => {
    // Fund the fee payer so the run is hermetic on a fresh local validator.
    // On devnet this is normally a no-op (the wallet already has SOL) and the
    // faucet is rate-limited, so a failure here must not fail the suite — the
    // real assertions below are what matter.
    try {
      const needed = 2 * anchor.web3.LAMPORTS_PER_SOL;
      if ((await connection.getBalance(payer.publicKey)) < needed) {
        const sig = await connection.requestAirdrop(payer.publicKey, needed);
        const latest = await connection.getLatestBlockhash();
        await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      }
    } catch (err) {
      console.log(`airdrop skipped: ${err.message ?? err}`);
    }
  });

  /** A key that is NOT the issuer: proves snapshot rights are delegated. */
  const registrar = Keypair.generate();

  const holders = [
    { key: Keypair.generate(), initial: 60n },
    { key: Keypair.generate(), initial: 40n },
    { key: Keypair.generate(), initial: 25n },
  ];
  const initialSupply = 125n;

  // The vault is denominated in a payout currency, never in the share mint: an
  // issuer can never fund `amount_per_token * supply` out of a mint that the
  // holders themselves are holding, so a same-mint "dividend" is unpayable by
  // construction.
  const AMOUNT_PER_SHARE = 1000n; // in payout-mint base units
  const ISSUER_FLOAT = 1_000_000n;

  let shareMint;
  let payoutMint;
  let assetPda;
  let escrow;
  let issuerPayoutAta;
  let currentAction = null;
  let splitSnapshot = null;

  const actionPda = (index) =>
    PublicKey.findProgramAddressSync(
      // NOTE: the program's seeds use `&[asset.action_count]` — ONE byte, not a
      // padded u32. Deriving these with a 4-byte buffer produces a different
      // address and the instruction fails with a seed mismatch.
      [Buffer.from("action"), assetPda.toBuffer(), Buffer.from([index])],
      program.programId,
    )[0];

  const receiptPda = (action, holder) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), action.toBuffer(), holder.toBuffer()],
      program.programId,
    )[0];

  // NOTE: `getTokenSupply` does not exist in @solana/spl-token 0.4.x — the
  // supply lives on the mint account, via `getMint`.
  const shareSupply = async () =>
    BigInt((await getMint(connection, shareMint)).supply);

  /** Read the frozen register off-chain from real balances, then snapshot it. */
  async function snapshotFromChain(action, onlyHolders = holders) {
    const balances = [];
    for (const h of onlyHolders) {
      balances.push(BigInt((await getAccount(connection, h.ata)).amount));
    }
    const supply = await shareSupply();

    const register = buildRegister(
      onlyHolders.map((h, i) => ({
        owner: h.key.publicKey.toBuffer(),
        amount: balances[i],
      })),
      supply,
    );
    const { root, proofs } = registerRootAndProofs(register);

    const sig = await program.methods
      .snapshotHolders(
        register.entries.map((e) => ({
          owner: new PublicKey(Buffer.from(e.owner)),
          amount: new anchor.BN(e.amount.toString()),
        })),
      )
      .accounts({
        asset: assetPda,
        mint: shareMint,
        action,
        registrar: registrar.publicKey,
      })
      .signers([registrar])
      .rpc();
    record(`snapshot_holders(action ${action.toBase58().slice(0, 6)}…)`, sig);

    return { register, root, proofs, sig };
  }

  /** Claim and settle one holder, returning what the chain did to their tokens. */
  async function claimAs(action, holder, index, amount, proof) {
    const before = BigInt((await getAccount(connection, holder.ata)).amount);
    const payoutBefore = BigInt((await getAccount(connection, holder.payoutAta)).amount);

    const receipt = receiptPda(action, holder.key.publicKey);
    const sig = await program.methods
      .claim(index, new anchor.BN(amount.toString()), proof)
      .accounts({
        action,
        asset: assetPda,
        mint: shareMint,
        escrowMint: payoutMint,
        holder: holder.key.publicKey,
        payer: payer.publicKey,
        claimReceipt: receipt,
        escrow: escrow.address,
        holderTokenAccount: holder.ata,
        holderPayoutAccount: holder.payoutAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([holder.key])
      .rpc();
    record(`claim[${holder.key.publicKey.toBase58().slice(0, 6)}…]`, sig, {
      entitlement: amount.toString(),
    });

    const after = BigInt((await getAccount(connection, holder.ata)).amount);
    const payoutAfter = BigInt((await getAccount(connection, holder.payoutAta)).amount);
    const receiptState = await program.account.claimReceipt.fetch(receipt);

    return {
      sig,
      receipt,
      sharesBefore: before,
      sharesAfter: after,
      sharesDelta: after - before,
      payoutDelta: payoutAfter - payoutBefore,
      recordedPayout: BigInt(receiptState.payout.toString()),
      recordedMode: receiptState.mode,
    };
  }

  it("creates the share mint, the payout currency, and the holder accounts", async () => {
    // 0 decimals: "shares" are whole units, so the register arithmetic in the
    // test and in core/ is directly comparable.
    shareMint = await createMint(connection, payer, payer.publicKey, null, 0);
    // 6 decimals: a stablecoin-shaped payout currency.
    payoutMint = await createMint(connection, payer, payer.publicKey, null, 6);

    for (const h of holders) {
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        shareMint,
        h.key.publicKey,
      );
      h.ata = ata.address;
      await mintTo(connection, payer, shareMint, h.ata, payer, h.initial);

      const payout = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        payoutMint,
        h.key.publicKey,
      );
      h.payoutAta = payout.address;
    }

    const issuerShare = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      shareMint,
      payer.publicKey,
    );
    // The issuer holds no shares: supply is exactly the holder register.
    assert.equal(BigInt((await getAccount(connection, issuerShare.address)).amount), 0n);

    issuerPayoutAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      payoutMint,
      payer.publicKey,
    ).then((a) => a.address);
    await mintTo(connection, payer, payoutMint, issuerPayoutAta, payer, ISSUER_FLOAT);

    assert.equal(await shareSupply(), initialSupply);
  });

  it("registers the asset and delegates snapshot rights to a separate key", async () => {
    [assetPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("asset"), shareMint.toBuffer()],
      program.programId,
    );

    const sig = await program.methods
      .initializeAsset(registrar.publicKey)
      .accounts({
        asset: assetPda,
        mint: shareMint,
        issuer: payer.publicKey,
        mintAuthorityCheck: shareMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    record("initialize_asset", sig);

    const acct = await program.account.asset.fetch(assetPda);
    assert.equal(acct.mint.toBase58(), shareMint.toBase58());
    assert.equal(acct.registrar.toBase58(), registrar.publicKey.toBase58());
    assert.equal(acct.issuerAuthority.toBase58(), payer.publicKey.toBase58());
    assert.equal(acct.actionCount, 0);
  });

  it("the registry — not the issuer — holds mint authority after arming", async () => {
    const sig = await program.methods
      .armSplitAuthority()
      .accounts({
        asset: assetPda,
        mint: shareMint,
        issuerAuthority: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    record("arm_split_authority", sig);

    const mintInfo = await connection.getParsedAccountInfo(shareMint);
    assert.equal(
      mintInfo.value.data.parsed.info.mintAuthority,
      assetPda.toBase58(),
      "mint authority must be the asset PDA, so no key can mint",
    );
  });

  it("declares a 4-for-1 split and creates its vault", async () => {
    escrow = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      payoutMint,
      assetPda,
      true, // allowOwnerOffCurve — the vault is owned by the asset PDA
    );

    currentAction = actionPda(0);
    const sig = await program.methods
      .declareAction(
        ACTION_SPLIT,
        new anchor.BN(Math.floor(Date.now() / 1000) - 60),
        new anchor.BN(4), // ratio_num
        new anchor.BN(1), // ratio_den
        new anchor.BN(0), // amount_per_token — a split moves no cash
        Array.from(sha256("owed:test:4-for-1-split")),
      )
      .accounts({
        asset: assetPda,
        mint: shareMint,
        escrowMint: payoutMint,
        issuerAuthority: payer.publicKey,
        escrow: escrow.address,
        action: currentAction,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    record("declare_action(split 4:1)", sig);

    const action = await program.account.action.fetch(currentAction);
    assert.equal(action.ratioNum.toNumber(), 4);
    assert.equal(action.status, 0);
    report.actions.push({ kind: "split", ratio: "4:1", action: currentAction.toBase58() });
  });

  it("rejects a holder register that does not sum to supply", async () => {
    // The conservation guard is the whole point of the instruction — prove it
    // refuses, or "supply conservation" is a comment rather than a check.
    let rejected = false;
    let message = "";
    try {
      await program.methods
        .snapshotHolders([
          { owner: holders[0].key.publicKey, amount: new anchor.BN(1) },
        ])
        .accounts({
          asset: assetPda,
          mint: shareMint,
          action: currentAction,
          registrar: registrar.publicKey,
        })
        .signers([registrar])
        .rpc();
    } catch (err) {
      rejected = true;
      message = err?.error?.errorCode?.errorCode ?? String(err).slice(0, 80);
    }
    expect(rejected, "a register short of supply must be rejected").to.equal(true);
    expect(message).to.equal("SupplyMismatch");
    report.steps.push({ label: "snapshot_holders(short register)", rejected: true, code: message });
  });

  it("freezes the holder set at the record slot", async () => {
    splitSnapshot = await snapshotFromChain(currentAction);
    const action = await program.account.action.fetch(currentAction);

    assert.equal(Buffer.from(action.merkleRoot).toString("hex"), Buffer.from(splitSnapshot.root).toString("hex"),
      "on-chain root must equal the keeper's root");
    assert.equal(action.holderCount, 3);
    assert.notEqual(Buffer.from(action.merkleRoot).toString("hex"), "00".repeat(32));
  });

  it("pays every holder their split delta — tokens actually move", async () => {
    const { register, proofs } = splitSnapshot;

    const byOwner = new Map(
      holders.map((h) => [h.key.publicKey.toBase58(), h]),
    );

    for (let i = 0; i < register.entries.length; i += 1) {
      const entry = register.entries[i];
      const holder = byOwner.get(new PublicKey(Buffer.from(entry.owner)).toBase58());
      const result = await claimAs(currentAction, holder, i, entry.amount, toProof(proofs[i].siblings));

      const expected = entitledShares(BigInt(holder.initial), 4n, 1n);
      assert.equal(result.sharesAfter, expected, `${expected} shares expected after a 4:1 split`);
      assert.equal(result.sharesDelta, expected - BigInt(holder.initial));
      assert.equal(result.recordedPayout, expected - BigInt(holder.initial),
        "the receipt must record the tokens that moved");
      assert.equal(result.recordedMode, PAYOUT_MINT, "a forward split pays by minting");
      assert.equal(result.payoutDelta, 0n, "a split moves no cash");
    }

    assert.equal(await shareSupply(), initialSupply * 4n,
      "supply must grow by exactly the ratio");
  });

  it("rejects a replay of a settled claim", async () => {
    // Rebuild the ORIGINAL pre-split register, so the proof is exactly the one
    // that already succeeded. The rejection must therefore come from the
    // ClaimReceipt PDA already existing — i.e. the account model — and not from
    // a bad proof, which would prove nothing about replay protection.
    const original = registerRootAndProofs(
      buildRegister(
        holders.map((h) => ({ owner: h.key.publicKey.toBuffer(), amount: h.initial })),
        initialSupply,
      ),
    );

    let rejected = false;
    let code = "";
    try {
      await program.methods
        .claim(0, new anchor.BN(holders[0].initial.toString()), toProof(original.proofs[0].siblings))
        .accounts({
          action: currentAction,
          asset: assetPda,
          mint: shareMint,
          escrowMint: payoutMint,
          holder: holders[0].key.publicKey,
          payer: payer.publicKey,
          claimReceipt: receiptPda(currentAction, holders[0].key.publicKey),
          escrow: escrow.address,
          holderTokenAccount: holders[0].ata,
          holderPayoutAccount: holders[0].payoutAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([holders[0].key])
        .rpc();
    } catch (err) {
      rejected = true;
      code = err?.error?.errorCode?.errorCode ?? String(err).slice(0, 60);
    }
    expect(rejected, "a replayed claim must fail").to.equal(true);
    expect(code, "the receipt PDA must be what blocks it").to.not.equal("BadProof");
    report.steps.push({ label: "claim(replay)", rejected: true, code });
  });

  it("settles the split with nothing stranded in the vault", async () => {
    const sig = await program.methods
      .settleAction()
      .accounts({
        asset: assetPda,
        mint: shareMint,
        action: currentAction,
        escrowMint: payoutMint,
        registrar: registrar.publicKey,
        escrow: escrow.address,
        issuerTokenAccount: issuerPayoutAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([registrar])
      .rpc();
    record("settle_action(split)", sig);

    const action = await program.account.action.fetch(currentAction);
    assert.equal(action.status, 2, "action must end Settled");
    assert.equal(BigInt((await getAccount(connection, escrow.address)).amount), 0n);
    assert.equal(BigInt(action.totalPaid.toString()), 375n, "125 shares became 500 (delta 375)");
  });

  it("pays a cash distribution in the payout currency and sweeps the remainder", async () => {
    const supply = await shareSupply();
    const required = AMOUNT_PER_SHARE * supply;
    await transfer(connection, payer, issuerPayoutAta, escrow.address, payer, required);
    assert.equal(BigInt((await getAccount(connection, escrow.address)).amount), required);

    const dividendAction = actionPda(1);
    const declareSig = await program.methods
      .declareAction(
        ACTION_DIVIDEND,
        new anchor.BN(Math.floor(Date.now() / 1000) - 60),
        new anchor.BN(1),
        new anchor.BN(1),
        new anchor.BN(AMOUNT_PER_SHARE.toString()),
        Array.from(sha256("owed:test:distribution")),
      )
      .accounts({
        asset: assetPda,
        mint: shareMint,
        escrowMint: payoutMint,
        issuerAuthority: payer.publicKey,
        escrow: escrow.address,
        action: dividendAction,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    record("declare_action(dividend)", declareSig);
    report.actions.push({
      kind: "dividend",
      perShare: AMOUNT_PER_SHARE.toString(),
      required: required.toString(),
      action: dividendAction.toBase58(),
    });

    const { register, proofs } = await snapshotFromChain(dividendAction);
    const byOwner = new Map(holders.map((h) => [h.key.publicKey.toBase58(), h]));

    // Only two of the three holders claim: the third's share is what settle
    // must sweep back to the issuer rather than strand.
    const claimedHolders = [];
    for (let i = 0; i < register.entries.length - 1; i += 1) {
      const holder = byOwner.get(new PublicKey(Buffer.from(register.entries[i].owner)).toBase58());
      const result = await claimAs(
        dividendAction,
        holder,
        i,
        register.entries[i].amount,
        toProof(proofs[i].siblings),
      );
      claimedHolders.push(holder);

      const owed = BigInt(register.entries[i].amount) * AMOUNT_PER_SHARE;
      assert.equal(result.payoutDelta, owed, "cash payout must equal amount * per-share");
      assert.equal(result.recordedMode, PAYOUT_ESCROW);
      assert.equal(result.sharesDelta, 0n, "a cash action must not move shares");
    }

    const unclaimedIndex = register.entries.length - 1;
    const unclaimed = BigInt(register.entries[unclaimedIndex].amount) * AMOUNT_PER_SHARE;

    assert.equal(claimedHolders.length, register.entries.length - 1);
    const escrowAfterClaims = BigInt((await getAccount(connection, escrow.address)).amount);
    assert.equal(
      escrowAfterClaims,
      unclaimed,
      "whatever is left must equal the unclaimed entitlement, to the base unit",
    );

    const issuerBefore = BigInt((await getAccount(connection, issuerPayoutAta)).amount);
    const settleSig = await program.methods
      .settleAction()
      .accounts({
        asset: assetPda,
        mint: shareMint,
        action: dividendAction,
        escrowMint: payoutMint,
        registrar: registrar.publicKey,
        escrow: escrow.address,
        issuerTokenAccount: issuerPayoutAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([registrar])
      .rpc();
    record("settle_action(dividend)", settleSig);

    const issuerAfter = BigInt((await getAccount(connection, issuerPayoutAta)).amount);
    assert.equal(issuerAfter - issuerBefore, unclaimed, "the sweep must return the remainder");
    assert.equal(BigInt((await getAccount(connection, escrow.address)).amount), 0n,
      "the vault must end empty");
    const dividendState = await program.account.action.fetch(dividendAction);
    assert.equal(dividendState.status, 2, "dividend action must end Settled");
    assert.equal(
      BigInt(dividendState.totalPaid.toString()),
      required - unclaimed,
      "totalPaid is what moved, not what was proven",
    );
    report.actions.at(-1).paid = dividendState.totalPaid.toString();
    report.actions.at(-1).swept = unclaimed.toString();
  });

  after(() => {
    report.programId = program.programId.toBase58();
    report.cluster = connection.rpcEndpoint;
    report.shareMint = shareMint?.toBase58();
    report.payoutMint = payoutMint?.toBase58();
    report.asset = assetPda?.toBase58();
    report.holders = holders.map((h) => ({
      owner: h.key.publicKey.toBase58(),
      initial: h.initial.toString(),
    }));

    const explorer = (sig) =>
      connection.rpcEndpoint.includes("devnet")
        ? `https://explorer.solana.com/tx/${sig}?cluster=devnet`
        : `https://explorer.solana.com/tx/${sig}`;

    console.log("\n=== signatures ===");
    for (const { label, signature } of report.steps) {
      if (!signature) continue;
      console.log(`${label}\n  ${explorer(signature)}`);
    }

    try {
      writeFileSync(
        new URL("./settlement-report.json", import.meta.url),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      console.log("\nwrote tests/settlement-report.json");
    } catch (err) {
      console.log(`could not write report: ${err}`);
    }
  });
});
