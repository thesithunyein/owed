//! Owed on-chain program (Anchor) — REFERENCE SOURCE
//!
//! ⚠️ Not compiled in this checkout: this file requires the Anchor/Solana
//! toolchain (`anchor build`). The registry math it relies on is proven in
//! `core/` (cargo test) and mirrored byte-for-byte by `keeper/` (node --test),
//! including cross-language golden vectors in `shared/vectors/`.
//!
//! Design notes:
//! * `declare_action` is issuer-only; dividends must fund escrow at
//!   declaration (token transfer CPI, elided here).
//! * `snapshot_holders` enforces supply conservation on-chain: the submitted
//!   register must sum to the mint supply at the record slot.
//! * `claim` verifies a Merkle proof against the stored root and pays from
//!   escrow (dividends) or mints the split delta; `ClaimReceipt` PDAs make
//!   double claims impossible at the account level.
//! * Merkle leaf layout MUST match core/src/register.rs:
//!   leaf = sha256(0x00 ++ owner(32) ++ amount_u64_le(8))

use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

/// Action kinds (u8 discriminant).
pub const ACTION_DIVIDEND: u8 = 0;
pub const ACTION_SPLIT: u8 = 1;
pub const ACTION_MERGER: u8 = 2;
pub const ACTION_TICKER: u8 = 3;

/// Action lifecycle: Declared -> Snapshotted -> Settled.
pub const STATUS_DECLARED: u8 = 0;
pub const STATUS_SNAPSHOTTED: u8 = 1;
pub const STATUS_SETTLED: u8 = 2;

#[program]
pub mod owed {
    use super::*;

    /// Issuer declares a corporate action.
    ///
    /// For dividends (`action_type == ACTION_DIVIDEND`), the caller must also
    /// fund `escrow` with the full `amount_per_token * supply` before or in
    /// the same transaction — enforced off this skeleton via a CPI.
    pub fn declare_action(
        ctx: Context<DeclareAction>,
        action_type: u8,
        effective_ts: i64,
        ratio_num: u64,
        ratio_den: u64,
        amount_per_token: u64,
        source_hash: [u8; 32], // sha256 of the filing / board resolution
    ) -> Result<()> {
        require!(action_type <= ACTION_TICKER, OwedError::InvalidActionType);
        require!(
            action_type == ACTION_DIVIDEND || (ratio_num > 0 && ratio_den > 0),
            OwedError::InvalidRatio
        );

        let asset = &mut ctx.accounts.asset;
        let action = &mut ctx.accounts.action;

        action.asset = asset.key();
        action.action_type = action_type;
        action.effective_ts = effective_ts;
        action.ratio_num = ratio_num;
        action.ratio_den = ratio_den;
        action.amount_per_token = amount_per_token;
        action.record_slot = 0;
        action.merkle_root = [0u8; 32];
        action.holder_count = 0;
        action.status = STATUS_DECLARED;
        action.escrow = ctx.accounts.escrow.key();
        action.source_hash = source_hash;
        action.bump = ctx.bumps.action;

        asset.action_count = asset.action_count.checked_add(1).ok_or(OwedError::Overflow)?;

        emit!(ActionDeclared {
            asset: asset.key(),
            action: action.key(),
            action_type,
            effective_ts,
            ratio_num,
            ratio_den,
            amount_per_token,
        });
        Ok(())
    }

    /// Registrar snapshots the holder set at (or after) the record slot.
    ///
    /// `holders` is the sorted register [(owner, amount)]. The program
    /// enforces the same invariant the Rust core and TS keeper test for:
    /// entries must be sorted, unique by owner, and sum exactly to the mint
    /// supply. The Merkle root is computed on-chain over
    /// `sha256(0x00 ++ owner ++ amount_u64_le)` with sorted-pairing nodes
    /// (sha256(0x01 ++ l ++ r), odd trailing node hashed with itself).
    pub fn snapshot_holders(
        ctx: Context<SnapshotHolders>,
        holders: Vec<(Pubkey, u64)>,
    ) -> Result<()> {
        let asset = &ctx.accounts.asset;
        let action = &mut ctx.accounts.action;

        require!(
            action.status == STATUS_DECLARED,
            OwedError::WrongStatus
        );
        require!(!holders.is_empty(), OwedError::EmptyRegister);

        // Sorted + unique by owner (mirrors Register::new in core).
        for w in holders.windows(2) {
            require!(w[0].0 < w[1].0, OwedError::RegisterNotSorted);
        }

        // Supply conservation: sum(holders) == mint.supply.
        let mut sum: u128 = 0;
        for (_, amount) in &holders {
            sum = sum.checked_add(*amount as u128).ok_or(OwedError::Overflow)?;
        }
        let supply = ctx.accounts.mint.supply as u128;
        require!(sum == supply, OwedError::SupplyMismatch);

        // Root computation delegates to the same conventions as core/keeper;
        // a compact on-chain builder over the (small) devnet register set.
        let root = compute_register_root(&holders)?;
        let clock = Clock::get()?;
        action.record_slot = clock.slot;
        action.merkle_root = root;
        action.holder_count = holders.len() as u32;
        action.status = STATUS_SNAPSHOTTED;

        emit!(HoldersSnapshotted {
            action: action.key(),
            root,
            count: holders.len() as u32,
            total: sum,
        });
        Ok(())
    }

    /// Holder claims an entitlement with a Merkle proof.
    ///
    /// Dividends pay pro-rata from escrow (CPI elided). Splits mint/adjust
    /// the delta (CPI elided). `ClaimReceipt` PDA makes double claims
    /// impossible: it is `init`'d in this instruction, so a second claim for
    /// the same (action, holder) fails at account-creation time.
    pub fn claim(
        ctx: Context<Claim>,
        leaf_index: u32,
        amount: u64,
        /// (sibling, side) pairs, bottom-up. side: 0 = sibling was Left,
        /// 1 = sibling was Right — identical to core/src/merkle.rs.
        proof: Vec<([u8; 32], u8)>,
    ) -> Result<()> {
        let action = &mut ctx.accounts.action;
        require!(action.status == STATUS_SNAPSHOTTED, OwedError::WrongStatus);

        // Leaf over the canonical encoding; MUST match register.rs exactly.
        let mut leaf_data = [0u8; 40];
        leaf_data[..32].copy_from_slice(ctx.accounts.holder.key().as_ref());
        leaf_data[32..].copy_from_slice(&amount.to_le_bytes());
        let leaf = hash_leaf(&leaf_data);

        require!(
            verify_proof(&leaf, &proof, &action.merkle_root),
            OwedError::BadProof
        );

        emit!(Claimed {
            action: action.key(),
            holder: ctx.accounts.holder.key(),
            leaf_index,
            amount,
        });

        // Payout CPIs (escrow transfer for dividends, mint for splits) are
        // intentionally elided in this reference; the math is in core/.
        // The ClaimReceipt account init (below) already blocks re-claims.
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Merkle helpers — byte-identical conventions to core/src/merkle.rs.
// ---------------------------------------------------------------------------

fn sha256(data: &[u8]) -> [u8; 32] {
    solana_program::hash::hash(data).to_bytes()
}

fn hash_leaf(data: &[u8]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(data.len() + 1);
    buf.push(0x00);
    buf.extend_from_slice(data);
    sha256(&buf)
}

fn hash_node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 65];
    buf[0] = 0x01;
    buf[1..33].copy_from_slice(left);
    buf[33..65].copy_from_slice(right);
    sha256(&buf)
}

/// Verify a proof carrying explicit sibling sides (same wire format as
/// core/src/merkle.rs `Proof`). One direction per level, no guessing.
fn verify_proof(leaf: &[u8; 32], proof: &[([u8; 32], u8)], root: &[u8; 32]) -> bool {
    let mut cur = *leaf;
    for (sib, side) in proof {
        cur = match side {
            0 => hash_node(sib, &cur), // sibling was Left
            1 => hash_node(&cur, sib), // sibling was Right
            _ => return false,
        };
    }
    &cur == root
}

fn compute_register_root(holders: &[(Pubkey, u64)]) -> Result<[u8; 32]> {
    let mut leaves: Vec<[u8; 32]> = holders
        .iter()
        .map(|(owner, amount)| {
            let mut data = [0u8; 40];
            data[..32].copy_from_slice(owner.as_ref());
            data[32..].copy_from_slice(&amount.to_le_bytes());
            hash_leaf(&data)
        })
        .collect();
    if leaves.is_empty() {
        return Ok(hash_leaf(&[]));
    }
    while leaves.len() > 1 {
        leaves.sort();
        let mut next = Vec::with_capacity((leaves.len() + 1) / 2);
        let mut i = 0;
        while i < leaves.len() {
            let right = if i + 1 >= leaves.len() {
                leaves[i]
            } else {
                leaves[i + 1]
            };
            next.push(hash_node(&leaves[i], &right));
            i += 2;
        }
        leaves = next;
    }
    Ok(leaves[0])
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct DeclareAction<'info> {
    #[account(
        mut,
        has_one = issuer_authority,
        seeds = [b"asset", mint.key().as_ref()],
        bump
    )]
    pub asset: Account<'info, Asset>,

    /// SPL mint of the tokenized equity.
    /// CHECK: read-only reference for the PDA seed.
    pub mint: UncheckedAccount<'info>,

    #[account(mut)]
    pub issuer_authority: Signer<'info>,

    /// Escrow token account for dividends.
    /// CHECK: validated by CPI in the full implementation.
    pub escrow: UncheckedAccount<'info>,

    #[account(
        init,
        payer = issuer_authority,
        space = 8 + Action::LEN,
        seeds = [b"action", asset.key().as_ref(), &[asset.action_count]],
        bump
    )]
    pub action: Account<'info, Action>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SnapshotHolders<'info> {
    #[account(seeds = [b"asset", mint.key().as_ref()], bump)]
    pub asset: Account<'info, Asset>,

    /// CHECK: supply read for the conservation check.
    pub mint: UncheckedAccount<'info>,

    #[account(
        mut,
        has_one = asset,
        constraint = action.status == STATUS_DECLARED @ OwedError::WrongStatus
    )]
    pub action: Account<'info, Action>,

    /// Registrar — must match the key the issuer delegated snapshot rights to.
    /// CHECK: compared against `asset.registrar` below.
    #[account(
        constraint = registrar.key() == asset.registrar @ OwedError::UnauthorizedRegistrar
    )]
    pub registrar: Signer<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        mut,
        has_one = asset,
        constraint = action.status == STATUS_SNAPSHOTTED @ OwedError::WrongStatus
    )]
    pub action: Account<'info, Action>,

    #[account(seeds = [b"asset", mint.key().as_ref()], bump)]
    pub asset: Account<'info, Asset>,

    /// CHECK: referenced for seeds only.
    pub mint: UncheckedAccount<'info>,

    #[account(mut)]
    pub holder: Signer<'info>,

    /// Payer funds the receipt; normally the holder themself.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + ClaimReceipt::LEN,
        seeds = [b"claim", action.key().as_ref(), holder.key().as_ref()],
        bump
    )]
    pub claim_receipt: Account<'info, ClaimReceipt>,

    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct Asset {
    pub mint: Pubkey,
    pub issuer_authority: Pubkey,
    /// Key allowed to submit snapshots (often the keeper's signer).
    pub registrar: Pubkey,
    pub action_count: u8,
    pub bump: u8,
}

#[account]
pub struct Action {
    pub asset: Pubkey,
    pub action_type: u8,
    pub status: u8,
    pub effective_ts: i64,
    pub record_slot: u64,
    pub ratio_num: u64,
    pub ratio_den: u64,
    pub amount_per_token: u64,
    pub merkle_root: [u8; 32],
    pub holder_count: u32,
    pub escrow: Pubkey,
    pub source_hash: [u8; 32],
    pub bump: u8,
}

impl Action {
    pub const LEN: usize = 32 + 1 + 1 + 8 + 8 + 8 + 8 + 8 + 32 + 4 + 32 + 32 + 1;
}

#[account]
pub struct ClaimReceipt {
    pub action: Pubkey,
    pub holder: Pubkey,
    pub amount: u64,
    pub claimed_at: i64,
    pub bump: u8,
}

impl ClaimReceipt {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 1;
}

// ---------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------

#[event]
pub struct ActionDeclared {
    pub asset: Pubkey,
    pub action: Pubkey,
    pub action_type: u8,
    pub effective_ts: i64,
    pub ratio_num: u64,
    pub ratio_den: u64,
    pub amount_per_token: u64,
}

#[event]
pub struct HoldersSnapshotted {
    pub action: Pubkey,
    pub root: [u8; 32],
    pub count: u32,
    pub total: u128,
}

#[event]
pub struct Claimed {
    pub action: Pubkey,
    pub holder: Pubkey,
    pub leaf_index: u32,
    pub amount: u64,
}

#[error_code]
pub enum OwedError {
    #[msg("invalid action type byte")]
    InvalidActionType,
    #[msg("split ratio parts must be nonzero")]
    InvalidRatio,
    #[msg("register must be sorted by owner without duplicates")]
    RegisterNotSorted,
    #[msg("register must be non-empty")]
    EmptyRegister,
    #[msg("holder amounts must sum exactly to mint supply")]
    SupplyMismatch,
    #[msg("merkle proof invalid")]
    BadProof,
    #[msg("action is not in the required status")]
    WrongStatus,
    #[msg("signer is not the asset's registrar")]
    UnauthorizedRegistrar,
    #[msg("arithmetic overflow")]
    Overflow,
}
