//! Owed on-chain program (Anchor)
//!
//! Compiled for SBF by CI on every push (`anchor build`), which is the only
//! compiler this program has: the SBF toolchain is Linux/macOS-only, so a
//! Windows dev box cannot build it at all. The registry math it relies on is
//! also proven in `core/` (cargo test) and mirrored byte-for-byte by `keeper/`
//! (node --test), including cross-language golden vectors in `shared/vectors/`.
//!
//! The registry does not merely record entitlements — `claim` moves value:
//! cash actions transfer out of the action's vault, forward splits mint the
//! delta, reverse splits burn the excess, and `settle_action` sweeps whatever
//! went unclaimed back to the issuer. The full lifecycle is executed on a
//! validator by `tests/owed.mjs` on every push.
//!
//! Instructions:
//! * `initialize_asset`      — issuer registers a tokenized-equity mint
//! * `set_registrar`         — issuer delegates snapshot rights to a keeper key
//! * `arm_split_authority`   — issuer hands mint control to the registry
//! * `declare_action`        — issuer declares dividend/split/merger/ticker
//! * `snapshot_holders`      — registrar freezes the holder set at the record slot
//! * `claim`                 — holder proves entitlement and is paid
//! * `settle_action`         — registrar finalizes and sweeps the remainder
//!
//! Merkle leaf layout MUST match core/src/register.rs:
//!   leaf = sha256(0x00 ++ owner(32) ++ amount_u64_le(8))

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
// SPL's `Mint::mint_authority` is a `COption`, which the anchor prelude does not
// re-export. Without this the constraint on `initialize_asset` failed with
// "use of undeclared type `COption`" — the third error this program produced.
use anchor_lang::solana_program::program_option::COption;

// A real program id, derived from the committed keypair at
// `programs/owed/owed-keypair.json`. It replaced the `anchor init` placeholder,
// which was the clearest possible evidence the program had never been deployed —
// and it is fixed rather than regenerated per run, so an address in a log, a
// test, or a submission still refers to this program tomorrow.
declare_id!("42WwVtPQzKiQRtDvaiGM7yjMw8jPSN1hxam24FcFFCLV");

/// Action kinds (u8 discriminant).
pub const ACTION_DIVIDEND: u8 = 0;
pub const ACTION_SPLIT: u8 = 1;
pub const ACTION_MERGER: u8 = 2;
pub const ACTION_TICKER: u8 = 3;

/// Action lifecycle: Declared -> Snapshotted -> Settled.
pub const STATUS_DECLARED: u8 = 0;
pub const STATUS_SNAPSHOTTED: u8 = 1;
pub const STATUS_SETTLED: u8 = 2;

/// How a claim was settled — recorded in the receipt so a holder's entitlement
/// and the tokens that actually moved are both auditable after the fact.
pub const PAYOUT_NONE: u8 = 0; // entitlement equalled the holding
pub const PAYOUT_ESCROW: u8 = 1; // pro-rata transfer out of the action's vault
pub const PAYOUT_MINT: u8 = 2; // forward split: new shares minted to the holder
pub const PAYOUT_BURN: u8 = 3; // reverse split: excess shares burned

#[program]
pub mod owed {
    use super::*;

    /// Issuer registers a tokenized-equity mint with the registry.
    pub fn initialize_asset(ctx: Context<InitializeAsset>, registrar: Pubkey) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        asset.mint = ctx.accounts.mint.key();
        asset.issuer_authority = ctx.accounts.issuer.key();
        asset.registrar = registrar;
        asset.action_count = 0;
        asset.bump = ctx.bumps.asset;

        emit!(AssetInitialized {
            asset: asset.key(),
            mint: asset.mint,
            issuer: asset.issuer_authority,
            registrar,
        });
        Ok(())
    }

    /// Issuer re-delegates the registrar key (keeper rotation).
    pub fn set_registrar(ctx: Context<SetRegistrar>, new_registrar: Pubkey) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        let old = asset.registrar;
        asset.registrar = new_registrar;
        emit!(RegistrarChanged {
            asset: asset.key(),
            old,
            new: new_registrar,
        });
        Ok(())
    }

    /// Issuer hands mint control to the registry, once.
    ///
    /// A split has to mint new shares to *every* holder. The program can only
    /// do that if it holds the mint authority, so this instruction moves that
    /// authority to the asset PDA on-chain and in one call — rather than
    /// asking holders to trust that an off-chain `spl-token authorize` happened
    /// and stayed put.
    ///
    /// What it buys: after this, a split executes from the frozen register
    /// alone. No per-holder issuer signature, no batching window, no issuer
    /// uptime dependency — `claim` is the only thing that has to happen, and
    /// holders can call it themselves. The authority is a PDA, so it is
    /// unreachable by any key: it can only be spent by this program's own
    /// `mint_to`, inside a claim that proved against the published root.
    pub fn arm_split_authority(ctx: Context<ArmSplitAuthority>) -> Result<()> {
        anchor_spl::token::set_authority(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::SetAuthority {
                    current_authority: ctx.accounts.issuer_authority.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            anchor_spl::token::spl_token::instruction::AuthorityType::MintTokens,
            Some(ctx.accounts.asset.key()),
        )?;

        emit!(SplitAuthorityArmed {
            asset: ctx.accounts.asset.key(),
            mint: ctx.accounts.mint.key(),
            new_authority: ctx.accounts.asset.key(),
        });
        Ok(())
    }

    /// Issuer declares a corporate action.
    ///
    /// For dividends (`action_type == ACTION_DIVIDEND`), the escrow token
    /// account must already hold `amount_per_token * supply` — checked here
    /// against the mint supply read from the real Mint account.
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
        let is_dividend = action_type == ACTION_DIVIDEND;
        require!(
            is_dividend || (ratio_num > 0 && ratio_den > 0),
            OwedError::InvalidRatio
        );

        // Dividends must be fully funded at declaration.
        if is_dividend {
            let supply = ctx.accounts.mint.supply;
            let required = (amount_per_token as u128)
                .checked_mul(supply as u128)
                .ok_or(OwedError::Overflow)?;
            let escrow_balance = ctx.accounts.escrow.amount as u128;
            require!(escrow_balance >= required, OwedError::EscrowUnderfunded);
        }

        let asset = &mut ctx.accounts.asset;
        let action = &mut ctx.accounts.action;

        action.asset = asset.key();
        action.action_type = action_type;
        action.status = STATUS_DECLARED;
        action.effective_ts = effective_ts;
        action.ratio_num = ratio_num;
        action.ratio_den = ratio_den;
        action.amount_per_token = amount_per_token;
        action.record_slot = 0;
        action.merkle_root = [0u8; 32];
        action.holder_count = 0;
        action.total_claimed = 0;
        action.escrow = ctx.accounts.escrow.key();
        action.escrow_mint = ctx.accounts.escrow_mint.key();
        action.source_hash = source_hash;
        action.bump = ctx.bumps.action;

        asset.action_count = asset
            .action_count
            .checked_add(1)
            .ok_or(OwedError::Overflow)?;

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
    /// enforces the same invariants the Rust core and TS keeper test for:
    /// entries must be sorted, unique by owner, and sum exactly to the mint
    /// supply. The Merkle root is computed on-chain over
    /// `sha256(0x00 ++ owner ++ amount_u64_le)` with sorted-pairing nodes
    /// (sha256(0x01 ++ l ++ r), odd trailing node hashed with itself).
    pub fn snapshot_holders(
        ctx: Context<SnapshotHolders>,
        holders: Vec<HolderEntry>,
    ) -> Result<()> {
        let action = &mut ctx.accounts.action;
        require!(action.status == STATUS_DECLARED, OwedError::WrongStatus);
        require!(!holders.is_empty(), OwedError::EmptyRegister);

        // Sorted + unique by owner (mirrors Register::new in core).
        for w in holders.windows(2) {
            require!(w[0].owner < w[1].owner, OwedError::RegisterNotSorted);
        }

        // Supply conservation: sum(holders) == mint.supply.
        let mut sum: u128 = 0;
        for h in &holders {
            sum = sum
                .checked_add(h.amount as u128)
                .ok_or(OwedError::Overflow)?;
        }
        let supply = ctx.accounts.mint.supply as u128;
        require!(sum == supply, OwedError::SupplyMismatch);

        let root = compute_register_root(&holders)?;
        action.record_slot = Clock::get()?.slot;
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

    /// Holder claims an entitlement with a Merkle proof — and is paid.
    ///
    /// This is the instruction that settles. Three payout modes, selected from
    /// the action's own declared shape (never from caller input):
    ///
    /// * cash action (`amount_per_token > 0`) — pro-rata `token::transfer` out
    ///   of the action's vault, signed by the asset PDA. Only a claim proven
    ///   against the frozen register can move that vault.
    /// * forward split (`ratio_num > ratio_den`) — `token::mint_to` the delta to
    ///   the holder, signed by the asset PDA (see `arm_split_authority`).
    /// * reverse split (`ratio_num < ratio_den`) — `token::burn` the excess from
    ///   the holder's own account, signed by the holder.
    ///
    /// The `ClaimReceipt` PDA is `init`'d here, so a second claim for the
    /// same (action, holder) fails at account-creation time — the account
    /// model itself blocks double claims, before any payout is prepared.
    pub fn claim(
        ctx: Context<Claim>,
        leaf_index: u32,
        amount: u64,
        // (sibling, side) pairs, bottom-up. side: 0 = sibling was Left,
        // 1 = sibling was Right — identical to core/src/merkle.rs.
        //
        // NOTE: these must be `//` and not `///`. A doc comment on a function
        // parameter desugars to an attribute, which Rust rejects with
        // "expected identifier, found `#`" — the first error this program ever
        // produced when it was finally compiled.
        //
        // `ProofNode`, not `([u8; 32], u8)`: the same IDL limitation that made
        // `Vec<(Pubkey, u64)>` unbuildable applies to a tuple inside a Vec.
        proof: Vec<ProofNode>,
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

        // ---- payout ------------------------------------------------------
        //
        // The asset PDA is the only authority that can move the vault or mint
        // shares. Its seeds are derived here from the mint the asset was
        // registered against, so the signer is never a caller-supplied key.
        let mint_key = ctx.accounts.mint.key();
        let bump_seed = [ctx.accounts.asset.bump];
        let asset_seeds: &[&[u8]] = &[b"asset", mint_key.as_ref(), &bump_seed];
        let asset_signer: &[&[&[u8]]] = &[asset_seeds];

        let (mode, payout) = if action.amount_per_token > 0 {
            // Cash action: amount * amount_per_token, exactly as core/ computes
            // it. The multiplication happens in u128 and must fit in u64 — a
            // silently truncated payout is the worst possible failure here.
            let owed = (amount as u128)
                .checked_mul(action.amount_per_token as u128)
                .ok_or(OwedError::Overflow)?;
            let owed = u64::try_from(owed).map_err(|_| OwedError::Overflow)?;

            if owed == 0 {
                (PAYOUT_NONE, 0)
            } else {
                require!(
                    ctx.accounts.escrow.amount >= owed,
                    OwedError::EscrowUnderfunded
                );
                anchor_spl::token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        anchor_spl::token::Transfer {
                            from: ctx.accounts.escrow.to_account_info(),
                            to: ctx.accounts.holder_payout_account.to_account_info(),
                            authority: ctx.accounts.asset.to_account_info(),
                        },
                        asset_signer,
                    ),
                    owed,
                )?;
                (PAYOUT_ESCROW, owed)
            }
        } else {
            // Share action: the entitlement is floor(amount * num / den).
            // For a 4-for-1 split a holder of 60 is entitled to 240, so the
            // program mints the 180 delta; for a 1-for-10 reverse split a
            // holder of 60 is entitled to 6 and the program burns 54.
            let entitled = u64::try_from(
                (amount as u128)
                    .checked_mul(action.ratio_num as u128)
                    .ok_or(OwedError::Overflow)?
                    .checked_div(action.ratio_den as u128)
                    .ok_or(OwedError::InvalidRatio)?,
            )
            .map_err(|_| OwedError::Overflow)?;

            if entitled > amount {
                let delta = entitled - amount;
                // Minting requires the registry to hold the mint authority.
                // Checked explicitly so the failure is a named error rather
                // than an opaque SPL "owner does not match".
                require!(
                    ctx.accounts.mint.mint_authority == COption::Some(ctx.accounts.asset.key()),
                    OwedError::NotMintAuthority
                );
                anchor_spl::token::mint_to(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        anchor_spl::token::MintTo {
                            mint: ctx.accounts.mint.to_account_info(),
                            to: ctx.accounts.holder_token_account.to_account_info(),
                            authority: ctx.accounts.asset.to_account_info(),
                        },
                        asset_signer,
                    ),
                    delta,
                )?;
                (PAYOUT_MINT, delta)
            } else if entitled < amount {
                let excess = amount - entitled;
                // Burning needs no mint authority — the holder signs their own
                // account away, so a reverse split cannot be blocked by an
                // issuer who never armed the registry.
                anchor_spl::token::burn(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        anchor_spl::token::Burn {
                            mint: ctx.accounts.mint.to_account_info(),
                            from: ctx.accounts.holder_token_account.to_account_info(),
                            authority: ctx.accounts.holder.to_account_info(),
                        },
                    ),
                    excess,
                )?;
                (PAYOUT_BURN, excess)
            } else {
                // Ticker change and any ratio that does not move the holding.
                (PAYOUT_NONE, 0)
            }
        };

        // ---- receipt -----------------------------------------------------
        //
        // Written only after the tokens moved, so a receipt can never claim a
        // payout that did not happen.
        let clock = Clock::get()?;
        let receipt = &mut ctx.accounts.claim_receipt;
        receipt.action = action.key();
        receipt.holder = ctx.accounts.holder.key();
        receipt.amount = amount;
        receipt.payout = payout;
        receipt.mode = mode;
        receipt.leaf_index = leaf_index;
        receipt.claimed_at = clock.unix_timestamp;
        receipt.bump = ctx.bumps.claim_receipt;

        // Two separate totals on purpose: `total_claimed` is the register
        // amount proven, `total_paid` is what actually left the vault or was
        // minted. They differ for splits, and conflating them would hide a
        // payout bug inside a number that looks correct.
        action.total_claimed = action
            .total_claimed
            .checked_add(amount as u128)
            .ok_or(OwedError::Overflow)?;
        action.total_paid = action
            .total_paid
            .checked_add(payout as u128)
            .ok_or(OwedError::Overflow)?;

        emit!(Claimed {
            action: action.key(),
            holder: ctx.accounts.holder.key(),
            leaf_index,
            amount,
            payout,
            mode,
        });
        Ok(())
    }

    /// Registrar finalizes the action once the claim window closes.
    /// Only moves Snapshotted -> Settled, so a second call is rejected rather
    /// than sweeping twice.
    ///
    /// Whatever the vault still holds is swept back to the issuer: the funds
    /// behind entitlements nobody claimed. Without this, an action would close
    /// with holder money stranded in an account only the program can move, and
    /// "settled" would be a lie.
    pub fn settle_action(ctx: Context<SettleAction>) -> Result<()> {
        let action = &mut ctx.accounts.action;
        require!(action.status == STATUS_SNAPSHOTTED, OwedError::WrongStatus);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= action.effective_ts, OwedError::BeforeEffective);

        let swept = ctx.accounts.escrow.amount;
        if swept > 0 {
            let mint_key = ctx.accounts.mint.key();
            let bump_seed = [ctx.accounts.asset.bump];
            let asset_seeds: &[&[u8]] = &[b"asset", mint_key.as_ref(), &bump_seed];

            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::Transfer {
                        from: ctx.accounts.escrow.to_account_info(),
                        to: ctx.accounts.issuer_token_account.to_account_info(),
                        authority: ctx.accounts.asset.to_account_info(),
                    },
                    &[asset_seeds],
                ),
                swept,
            )?;
        }

        action.status = STATUS_SETTLED;

        emit!(ActionSettled {
            action: action.key(),
            total_claimed: action.total_claimed,
            total_paid: action.total_paid,
            swept,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Instruction argument types
// ---------------------------------------------------------------------------

/// One row of the holder register, as passed to `snapshot_holders`.
///
/// This exists because `Vec<(Pubkey, u64)>` — the obvious way to write it — is
/// NOT a supported Anchor instruction argument. The IDL has no notion of a Rust
/// tuple, so the build fails with a bare "Unsupported type". A named struct with
/// `AnchorSerialize`/`AnchorDeserialize` is the supported form, and it maps 1:1
/// onto `RegisterEntry` in core/register.rs.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct HolderEntry {
    pub owner: Pubkey,
    pub amount: u64,
}

/// One level of a Merkle proof: the sibling hash and which side it sat on.
///
/// `side`: 0 = the sibling was the left input, 1 = the sibling was the right
/// input, matching `core/src/merkle.rs` exactly. Explicit sides rather than a
/// guessed ordering — the previous draft tried both orderings, which would have
/// accepted proofs that are not the ones the tree produced.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ProofNode {
    pub sibling: [u8; 32],
    pub side: u8,
}

// ---------------------------------------------------------------------------
// Merkle helpers — byte-identical conventions to core/src/merkle.rs.
// ---------------------------------------------------------------------------

fn sha256(data: &[u8]) -> [u8; 32] {
    // `anchor_lang` re-exports `solana_program`; naming the crate directly here
    // failed to resolve because it was never declared as a dependency. Using the
    // re-export keeps the dependency list minimal and the versions locked
    // together with anchor itself.
    anchor_lang::solana_program::hash::hash(data).to_bytes()
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
fn verify_proof(leaf: &[u8; 32], proof: &[ProofNode], root: &[u8; 32]) -> bool {
    let mut cur = *leaf;
    for node in proof {
        cur = match node.side {
            0 => hash_node(&node.sibling, &cur), // sibling was Left
            1 => hash_node(&cur, &node.sibling), // sibling was Right
            _ => return false,
        };
    }
    &cur == root
}

/// Compute the register root exactly as core/src/merkle.rs `build`:
/// sort hashes lexicographically at each level; odd trailing hash is
/// hashed with itself. On-chain register sizes are bounded by the
/// transaction size limit; the concurrent-Merkle-tree upgrade for
/// large registers is tracked in the roadmap.
fn compute_register_root(holders: &[HolderEntry]) -> Result<[u8; 32]> {
    let mut leaves: Vec<[u8; 32]> = holders
        .iter()
        .map(|h| {
            let mut data = [0u8; 40];
            data[..32].copy_from_slice(h.owner.as_ref());
            data[32..].copy_from_slice(&h.amount.to_le_bytes());
            hash_leaf(&data)
        })
        .collect();
    if leaves.is_empty() {
        return Ok(hash_leaf(&[]));
    }
    while leaves.len() > 1 {
        leaves.sort_unstable();
        let mut next = Vec::with_capacity(leaves.len().div_ceil(2));
        let mut i = 0;
        while i < leaves.len() {
            let right = if i + 1 >= leaves.len() {
                leaves[i] // odd trailing: hash with itself
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
pub struct InitializeAsset<'info> {
    #[account(
        init,
        payer = issuer,
        space = 8 + Asset::LEN,
        seeds = [b"asset", mint.key().as_ref()],
        bump
    )]
    pub asset: Account<'info, Asset>,

    /// The tokenized-equity mint being registered.
    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub issuer: Signer<'info>,

    /// Mint authority must match the issuer — only the entity that controls
    /// the mint may register it.
    #[account(constraint = mint.mint_authority == COption::Some(issuer.key()) @ OwedError::NotMintAuthority)]
    pub mint_authority_check: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRegistrar<'info> {
    #[account(
        mut,
        has_one = issuer_authority,
        seeds = [b"asset", mint.key().as_ref()],
        bump
    )]
    pub asset: Account<'info, Asset>,

    /// CHECK: seed reference only.
    pub mint: UncheckedAccount<'info>,

    pub issuer_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct DeclareAction<'info> {
    #[account(
        mut,
        has_one = issuer_authority,
        seeds = [b"asset", mint.key().as_ref()],
        bump
    )]
    pub asset: Account<'info, Asset>,

    pub mint: Account<'info, Mint>,

    /// The currency an action pays out in — a share mint and its payout
    /// currency are different assets. Storing it per action (rather than once
    /// per asset) lets one issuer pay USDC on one action and a different
    /// stable on the next without re-registering.
    pub escrow_mint: Account<'info, Mint>,

    #[account(mut)]
    pub issuer_authority: Signer<'info>,

    /// The vault backing a cash action, denominated in `escrow_mint` and owned
    /// by the asset PDA. That ownership is what lets `claim` pay holders with no
    /// issuer signature, and pinning it here means an action can never be
    /// declared against a vault someone else controls.
    #[account(token::mint = escrow_mint, token::authority = asset)]
    pub escrow: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = issuer_authority,
        space = 8 + Action::LEN,
        seeds = [b"action", asset.key().as_ref(), &[asset.action_count]],
        bump
    )]
    pub action: Account<'info, Action>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SnapshotHolders<'info> {
    #[account(seeds = [b"asset", mint.key().as_ref()], bump)]
    pub asset: Account<'info, Asset>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        has_one = asset,
        constraint = action.status == STATUS_DECLARED @ OwedError::WrongStatus
    )]
    pub action: Account<'info, Action>,

    /// Registrar — must match the key the issuer delegated snapshot rights to.
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

    /// Read-only here: it acts as the *signer* of the payout CPIs (as a PDA),
    /// never as a caller-supplied authority.
    #[account(seeds = [b"asset", mint.key().as_ref()], bump)]
    pub asset: Account<'info, Asset>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    /// The payout currency the action was declared with — pinned, so a claim
    /// cannot be paid out of a different mint than the one the issuer funded.
    #[account(address = action.escrow_mint)]
    pub escrow_mint: Account<'info, Mint>,

    #[account(mut)]
    pub holder: Signer<'info>,

    /// Pays rent for the receipt; normally the holder themself.
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

    /// The action's own vault, pinned to the account the issuer declared the
    /// action with and owned by the asset PDA — so a claim can only ever drain
    /// the vault belonging to the action it proved against.
    #[account(
        mut,
        address = action.escrow,
        token::mint = escrow_mint,
        token::authority = asset
    )]
    pub escrow: Account<'info, TokenAccount>,

    /// Where share adjustments land: the holder's own account for the share
    /// mint. Passing someone else's account is impossible — the authority must
    /// equal the signer who proved the entitlement.
    #[account(
        mut,
        token::mint = mint,
        token::authority = holder
    )]
    pub holder_token_account: Account<'info, TokenAccount>,

    /// Where a cash payout lands: the holder's own account for the payout
    /// currency. Separate account, separate mint.
    #[account(
        mut,
        token::mint = escrow_mint,
        token::authority = holder
    )]
    pub holder_payout_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleAction<'info> {
    #[account(seeds = [b"asset", mint.key().as_ref()], bump)]
    pub asset: Account<'info, Asset>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        has_one = asset,
        constraint = action.status == STATUS_SNAPSHOTTED @ OwedError::WrongStatus
    )]
    pub action: Account<'info, Action>,

    /// The payout currency of the action being closed out.
    #[account(address = action.escrow_mint)]
    pub escrow_mint: Account<'info, Mint>,

    #[account(
        constraint = registrar.key() == asset.registrar @ OwedError::UnauthorizedRegistrar
    )]
    pub registrar: Signer<'info>,

    /// The vault being closed out — the same one the action was declared with.
    #[account(
        mut,
        address = action.escrow,
        token::mint = escrow_mint,
        token::authority = asset
    )]
    pub escrow: Account<'info, TokenAccount>,

    /// The issuer's own account for the payout currency: the unclaimed
    /// remainder goes back to the party that funded it, not to the registrar
    /// who swept it.
    #[account(
        mut,
        token::mint = escrow_mint,
        constraint = issuer_token_account.owner == asset.issuer_authority @ OwedError::WrongDestination
    )]
    pub issuer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ArmSplitAuthority<'info> {
    #[account(
        seeds = [b"asset", mint.key().as_ref()],
        bump,
        has_one = issuer_authority
    )]
    pub asset: Account<'info, Asset>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    /// Must currently be the mint authority — this instruction *moves* that
    /// authority, so an arbitrary signer cannot redirect it.
    #[account(
        mut,
        constraint = mint.mint_authority == COption::Some(issuer_authority.key()) @ OwedError::NotMintAuthority
    )]
    pub issuer_authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
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

impl Asset {
    pub const LEN: usize = 32 + 32 + 32 + 1 + 1;
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
    /// Sum of register amounts proven. Audit trail, not a payout figure.
    pub total_claimed: u128,
    /// Sum of tokens actually moved (transferred + minted − burned).
    pub total_paid: u128,
    pub escrow: Pubkey,
    /// Payout currency for cash actions; ignored for share adjustments.
    pub escrow_mint: Pubkey,
    pub source_hash: [u8; 32],
    pub bump: u8,
}

impl Action {
    pub const LEN: usize =
        32 + 1 + 1 + 8 + 8 + 8 + 8 + 8 + 32 + 4 + 16 + 16 + 32 + 32 + 32 + 1;
}

/// Proof that a holder claimed, and what they were actually paid.
///
/// `amount` is the entitlement proven against the root; `payout` is what the
/// chain moved. Recording both is what makes a discrepancy detectable after the
/// fact instead of invisible.
#[account]
pub struct ClaimReceipt {
    pub action: Pubkey,
    pub holder: Pubkey,
    pub amount: u64,
    pub payout: u64,
    pub mode: u8,
    pub leaf_index: u32,
    pub claimed_at: i64,
    pub bump: u8,
}

impl ClaimReceipt {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 1 + 4 + 8 + 1;
}

// ---------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------

#[event]
pub struct AssetInitialized {
    pub asset: Pubkey,
    pub mint: Pubkey,
    pub issuer: Pubkey,
    pub registrar: Pubkey,
}

#[event]
pub struct RegistrarChanged {
    pub asset: Pubkey,
    pub old: Pubkey,
    pub new: Pubkey,
}

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
    pub payout: u64,
    pub mode: u8,
}

#[event]
pub struct ActionSettled {
    pub action: Pubkey,
    pub total_claimed: u128,
    pub total_paid: u128,
    pub swept: u64,
}

#[event]
pub struct SplitAuthorityArmed {
    pub asset: Pubkey,
    pub mint: Pubkey,
    pub new_authority: Pubkey,
}

#[error_code]
pub enum OwedError {
    #[msg("invalid action type byte")]
    InvalidActionType,
    #[msg("split ratio parts must be nonzero")]
    InvalidRatio,
    #[msg("dividend escrow holds less than amount_per_token * supply")]
    EscrowUnderfunded,
    #[msg("signer is not the mint authority")]
    NotMintAuthority,
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
    #[msg("effective timestamp not reached yet")]
    BeforeEffective,
    #[msg("signer is not the asset's registrar")]
    UnauthorizedRegistrar,
    #[msg("destination is not the issuer's account for this mint")]
    WrongDestination,
    #[msg("arithmetic overflow")]
    Overflow,
}
