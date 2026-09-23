//! Token-2022 **Scaled UI Amount** reader over raw account bytes.
//!
//! This is the reader for things that cannot call the TypeScript SDK: an
//! on-chain program (`programs/owed` uses it directly, via CPI-free in-process
//! parsing), or any other Rust program that wants to stop reading the stale
//! `multiplier` field. `keeper/src/scaled.mjs` is the same rule expressed for
//! clients, and `scripts/conformance.mjs` pins that one to the runtime on all
//! 933 official mints; this one is pinned to the same mainnet bytes by the
//! fixtures in `shared/vectors/scaled-raw/` (see `scripts/fetch-scaled-fixtures.mjs`).
//!
//! # Why bytes and not `jsonParsed`
//!
//! A program cannot ask an RPC for a parsed account - it gets the account's
//! data and has to read it. So the offsets below are the whole problem, and they
//! were established by reading real mainnet accounts rather than from memory:
//!
//! ```text
//!   0   .. 82    base Mint state (authority, supply, decimals, ...)
//!   82  .. 165   zero padding (keeps the legacy 165-byte layout readable)
//!   165          AccountType byte: 1 = Mint, 2 = Account
//!   166 ..       TLV entries: type u16 LE, length u16 LE, payload
//! ```
//!
//! Confirmed on 933 official mints: `[165] == 1` everywhere, and exactly one
//! entry of type 25 is present on every tokenized equity.
//!
//! # Using this from a program
//!
//! ```ignore
//! use owed_core::multiplier::read_multiplier;
//!
//! let now = Clock::get()?.unix_timestamp;
//! let mint = ctx.accounts.mint.to_account_info();
//! let data = mint.try_borrow_data()?;
//! match read_multiplier(&data, now)? {
//!     Some(r) if r.stale => // the stored field is wrong right now
//!         msg!("stored {} effective {} ({}x)", r.stored, r.effective, r.factor()),
//!     Some(_) => {} // current
//!     None => {}    // no scaled config on this mint
//! }
//! ```
//!
//! The crate is a plain library with no RPC, no allocator use in this module,
//! and `#![forbid(unsafe_code)]`, so it drops into an SBF build as-is. The one
//! property a program depends on that a client does not is that **a panic aborts
//! the whole transaction**, so this module never indexes without a length check
//! and never unwraps - `a_hostile_account_never_panics` below is the test for
//! that, and it walks every truncation of every fixture.
//!
//! # Why the walk matters
//!
//! Extension entries are ordered by how the mint was constructed, not by type.
//! The xStocks fixtures happen to place the scaled config first, but the
//! PreStocks `SPACEX` mint places it at byte 575, so a reader that assumes a
//! fixed payload offset passes every xStocks test and silently misreads a second
//! issuer's assets. The TLV list is walked, and `SPACEX` is a test.

use crate::Error;

/// Length of the legacy SPL mint base state.
pub const MINT_BASE_LEN: usize = 82;

/// Offset of the Token-2022 `AccountType` discriminant.
///
/// Token-2022 keeps the base state at the start and places the discriminant at
/// the end of the legacy 165-byte region, so this is the same for mints and for
/// token accounts - the discriminant is what tells them apart.
pub const ACCOUNT_TYPE_OFFSET: usize = 165;

/// `AccountType::Mint`.
pub const ACCOUNT_TYPE_MINT: u8 = 1;

/// First byte of the extension TLV list.
pub const TLV_START: usize = ACCOUNT_TYPE_OFFSET + 1;

/// `ExtensionType::ScaledUiAmountConfig`.
pub const EXT_SCALED_UI_AMOUNT_CONFIG: u16 = 25;

/// Fixed payload length of a `ScaledUiAmountConfig` entry.
pub const SCALED_UI_AMOUNT_CONFIG_LEN: usize = 56;

/// The `ScaledUiAmountConfig` extension, unpacked.
///
/// Field order is the on-chain struct's:
/// `authority(32) | multiplier(f64 LE) | new_multiplier_effective_timestamp(i64 LE) | new_multiplier(f64 LE)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScaledUiAmountConfig {
    /// Authority allowed to change the multiplier. All-zero means none.
    pub authority: [u8; 32],
    /// The value stored in the account. **Not** necessarily what applies now.
    pub multiplier: f64,
    /// Activation time of `new_multiplier`, epoch seconds. `0` means none.
    pub new_multiplier_effective_timestamp: i64,
    /// The value the runtime applies once the timestamp has passed.
    pub new_multiplier: f64,
}

/// What a mint's multiplier actually is, at one instant.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MultiplierReading {
    /// The value stored in the account - the field naive readers use.
    pub stored: f64,
    /// The value the runtime applies at the instant the read was taken.
    pub effective: f64,
    /// The pending value, whether or not it has activated yet.
    pub new_multiplier: f64,
    /// Activation timestamp, or 0 when the config never changes.
    pub effective_timestamp: i64,
    /// The stored field is stale **right now**: a naive reader is wrong.
    pub stale: bool,
    /// An activation is scheduled and has not landed yet.
    pub pending: bool,
}

impl MultiplierReading {
    /// `effective / stored`. `1.0` means the stored field is current.
    pub fn factor(&self) -> f64 {
        self.effective / self.stored
    }

    /// Percentage error a naive reader makes right now. `0.0` when current.
    pub fn gap_pct(&self) -> f64 {
        (self.factor() - 1.0) * 100.0
    }
}

#[inline]
fn read_f64(data: &[u8], at: usize) -> f64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&data[at..at + 8]);
    f64::from_le_bytes(b)
}

#[inline]
fn read_i64(data: &[u8], at: usize) -> i64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&data[at..at + 8]);
    i64::from_le_bytes(b)
}

/// Find the `ScaledUiAmountConfig` entry in raw mint account data.
///
/// Returns `Ok(None)` when the account carries no scaled config - which covers
/// both a legacy SPL mint (too short to hold extensions at all) and a Token-2022
/// mint that simply does not use the extension. Those are ordinary answers, not
/// errors, because the caller usually cannot tell them apart in advance.
///
/// Returns `Err` only when the account claims to be a Token-2022 mint and is
/// internally inconsistent - a wrong discriminant, an entry whose length runs
/// past the end, or a scaled entry too short to hold its fields. A malformed
/// account is never silently reported as "no config": that would turn corrupt
/// data into a plausible-looking `1.0`.
pub fn find_scaled_ui_amount_config(data: &[u8]) -> crate::Result<Option<ScaledUiAmountConfig>> {
    if data.len() <= ACCOUNT_TYPE_OFFSET {
        // Too short for extensions. A legacy mint is exactly this.
        return Ok(None);
    }
    if data[ACCOUNT_TYPE_OFFSET] != ACCOUNT_TYPE_MINT {
        return Err(Error::MalformedMint(
            "account type byte is not Mint (2 = token account)",
        ));
    }

    let mut o = TLV_START;
    while o + 4 <= data.len() {
        let entry_type = u16::from_le_bytes([data[o], data[o + 1]]);
        let entry_len = u16::from_le_bytes([data[o + 2], data[o + 3]]);
        if entry_type == 0 && entry_len == 0 {
            // Rest of the account is zero padding; the list ended.
            break;
        }
        let payload = o + 4;
        let end = payload
            .checked_add(entry_len as usize)
            .ok_or(Error::MalformedMint("extension length overflows"))?;
        if end > data.len() {
            return Err(Error::MalformedMint(
                "extension length runs past the end of the account",
            ));
        }
        if entry_type == EXT_SCALED_UI_AMOUNT_CONFIG {
            if entry_len as usize != SCALED_UI_AMOUNT_CONFIG_LEN {
                return Err(Error::MalformedMint(
                    "scaled UI amount entry has an unexpected length",
                ));
            }
            let mut authority = [0u8; 32];
            authority.copy_from_slice(&data[payload..payload + 32]);
            return Ok(Some(ScaledUiAmountConfig {
                authority,
                multiplier: read_f64(data, payload + 32),
                new_multiplier_effective_timestamp: read_i64(data, payload + 40),
                new_multiplier: read_f64(data, payload + 48),
            }));
        }
        o = end;
    }
    Ok(None)
}

/// The effective multiplier for a config at `now_sec`.
///
/// This is the Token-2022 rule quoted rather than paraphrased, from
/// `ScaledUiAmountConfig::current_multiplier` in the SPL interface crate:
///
/// ```text
///   if unix_timestamp >= new_multiplier_effective_timestamp
///       { new_multiplier } else { multiplier }
/// ```
///
/// The published documentation states the same thing in words: "Before
/// `new_multiplier_effective_timestamp`, conversions use `multiplier`. At or
/// after that timestamp, conversions use `new_multiplier`."
///
/// Note what is deliberately **not** here: a `ts > 0` special case. With a zero
/// timestamp the comparison is true, so the runtime uses `new_multiplier` -
/// initialization sets both fields to the same value, which is why an earlier
/// version of this function could treat zero as "nothing scheduled" and still
/// agree with the chain on every mint. Quoting the rule removes that coincidence
/// as a load-bearing assumption: measured across all 933 official mints, 541
/// carry a zero timestamp and all 541 have `multiplier == new_multiplier`, so
/// this change moves no published number while making the code match the spec
/// even where the catalogue has no example.
///
/// A config whose pending value equals the stored value is inert: it is neither
/// stale nor pending, and reading the stored field is harmless for it.
pub fn effective_multiplier(config: &ScaledUiAmountConfig, now_sec: i64) -> MultiplierReading {
    let ts = config.new_multiplier_effective_timestamp;
    let activation_passed = now_sec >= ts;
    let changes = config.new_multiplier != config.multiplier;

    MultiplierReading {
        stored: config.multiplier,
        effective: if activation_passed {
            config.new_multiplier
        } else {
            config.multiplier
        },
        new_multiplier: config.new_multiplier,
        effective_timestamp: ts,
        stale: activation_passed && changes,
        pending: !activation_passed && changes,
    }
}

/// One call for the whole job: raw mint bytes plus a clock, or `None` when the
/// mint carries no scaled config.
pub fn read_multiplier(data: &[u8], now_sec: i64) -> crate::Result<Option<MultiplierReading>> {
    Ok(find_scaled_ui_amount_config(data)?.map(|c| effective_multiplier(&c, now_sec)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures are real mainnet accounts captured by
    // scripts/fetch-scaled-fixtures.mjs. The expectations below are the numbers
    // published in the risk feed at its own clock (1790181165); the keeper test
    // `scaled-raw.test.mjs` asserts the manifest beside the fixtures still
    // matches the feed, so a stale fixture fails the build rather than this
    // test passing against numbers nobody publishes.
    const NOW: i64 = 1_790_181_165;

    const PPLTX: &[u8] = include_bytes!("../../shared/vectors/scaled-raw/PPLTx.bin");
    const SPACEX: &[u8] = include_bytes!("../../shared/vectors/scaled-raw/SPACEX.bin");
    const AZNX: &[u8] = include_bytes!("../../shared/vectors/scaled-raw/AZNx.bin");
    const SPCXX: &[u8] = include_bytes!("../../shared/vectors/scaled-raw/SPCXx.bin");
    const USDC: &[u8] = include_bytes!("../../shared/vectors/scaled-raw/USDC.bin");

    #[test]
    fn ppltx_10x_split_is_stale_and_a_naive_reader_is_10x_wrong() {
        let r = read_multiplier(PPLTX, NOW).unwrap().expect("scaled config");
        assert_eq!(r.stored, 1.0);
        assert_eq!(r.effective, 10.0);
        assert_eq!(r.new_multiplier, 10.0);
        assert_eq!(r.effective_timestamp, 1_778_985_000);
        assert!(r.stale, "the activation passed 129 days before this clock");
        assert!(!r.pending);
        assert_eq!(r.factor(), 10.0);
        assert_eq!(r.gap_pct(), 900.0);
    }

    #[test]
    fn before_the_activation_the_stored_value_still_applies() {
        // 60 seconds before the timestamp: the same bytes, a different answer.
        let r = read_multiplier(PPLTX, 1_778_985_000 - 60)
            .unwrap()
            .expect("scaled config");
        assert_eq!(r.stored, 1.0);
        assert_eq!(r.effective, 1.0);
        assert!(!r.stale);
        assert!(r.pending, "scheduled, not yet landed");
    }

    #[test]
    fn the_boundary_is_inclusive() {
        // At exactly the timestamp the new value applies; a reader using `>`
        // instead of `>=` is wrong for 1 second per action, which is the kind of
        // bug that never shows up in a test written by the same person.
        let r = read_multiplier(PPLTX, 1_778_985_000).unwrap().unwrap();
        assert_eq!(r.effective, 10.0);
        assert!(r.stale);
    }

    #[test]
    fn second_issuer_fixture_with_the_scaled_entry_not_first() {
        // The TLV list is walked, not indexed: on this PreStocks mint the scaled
        // entry sits at byte 575, so a fixed-offset reader passes every xStocks
        // fixture and silently misreads the second issuer.
        let entry = find_scaled_ui_amount_config(SPACEX)
            .unwrap()
            .expect("scaled config");
        assert_eq!(entry.multiplier, 1.0);
        assert_eq!(entry.new_multiplier, 5.0);

        let r = read_multiplier(SPACEX, NOW).unwrap().unwrap();
        assert_eq!(r.stored, 1.0);
        assert_eq!(r.effective, 5.0);
        assert!(r.stale, "understated 5x, matching the published finding");
        assert_eq!(r.gap_pct(), 400.0);
    }

    #[test]
    fn reverse_split_fixture_is_current_not_stale() {
        // AZNx stores a sub-1 multiplier (0.5111...) that has already activated
        // and equals the pending value - so the stored field is correct here,
        // and a reader that flags it as stale would be crying wolf.
        let r = read_multiplier(AZNX, NOW).unwrap().unwrap();
        assert_eq!(r.stored, 0.5111362527152737);
        assert_eq!(r.effective, r.stored);
        assert!(!r.stale);
        assert!(!r.pending);
        assert_eq!(r.factor(), 1.0);
    }

    #[test]
    fn inert_config_is_neither_stale_nor_pending() {
        let r = read_multiplier(SPCXX, NOW).unwrap().unwrap();
        assert_eq!(r.effective_timestamp, 0);
        assert_eq!(r.stored, 1.0);
        assert_eq!(r.effective, 1.0);
        assert!(!r.stale);
        assert!(!r.pending);
    }

    #[test]
    fn legacy_mint_reports_no_config_rather_than_reading_padding() {
        // USDC is a plain SPL mint: 82 bytes, no extensions, no discriminant.
        // Anything other than `None` here means padding is being read as state.
        assert_eq!(USDC.len(), MINT_BASE_LEN);
        assert_eq!(find_scaled_ui_amount_config(USDC).unwrap(), None);
        assert_eq!(read_multiplier(USDC, NOW).unwrap(), None);
    }

    #[test]
    fn a_token_account_is_rejected_not_reported_as_absent() {
        // AccountType 2 is a token account. Reporting `None` would let a caller
        // treat a holder's balance account as a mint with no scaled config; the
        // discriminant is the only thing that distinguishes them, so it is
        // enforced.
        let mut data = vec![0u8; TLV_START];
        data[ACCOUNT_TYPE_OFFSET] = 2;
        assert!(matches!(
            find_scaled_ui_amount_config(&data),
            Err(Error::MalformedMint(_))
        ));
    }

    #[test]
    fn empty_extension_region_is_no_config() {
        let mut data = vec![0u8; TLV_START];
        data[ACCOUNT_TYPE_OFFSET] = ACCOUNT_TYPE_MINT;
        assert_eq!(find_scaled_ui_amount_config(&data).unwrap(), None);
    }

    #[test]
    fn an_extension_length_past_the_end_is_an_error() {
        let mut data = vec![0u8; TLV_START + 8];
        data[ACCOUNT_TYPE_OFFSET] = ACCOUNT_TYPE_MINT;
        // type 7, length 0xFFFF - far past the end of the buffer.
        data[TLV_START..TLV_START + 4].copy_from_slice(&[7, 0, 0xff, 0xff]);
        assert!(matches!(
            find_scaled_ui_amount_config(&data),
            Err(Error::MalformedMint(_))
        ));
    }

    #[test]
    fn a_short_scaled_entry_is_an_error() {
        let mut data = vec![0u8; TLV_START + 4 + 16];
        data[ACCOUNT_TYPE_OFFSET] = ACCOUNT_TYPE_MINT;
        data[TLV_START..TLV_START + 4].copy_from_slice(&[25, 0, 16, 0]);
        assert!(matches!(
            find_scaled_ui_amount_config(&data),
            Err(Error::MalformedMint(_))
        ));
    }

    #[test]
    fn zero_entries_terminate_the_walk() {
        // A later, non-zero TLV entry behind a zeroed terminator must not be
        // reached: the terminator marks the end of the list, and walking past it
        // would read freed space that a later version might write.
        let mut data = vec![0u8; TLV_START + 4 + 64 + 4 + SCALED_UI_AMOUNT_CONFIG_LEN];
        data[ACCOUNT_TYPE_OFFSET] = ACCOUNT_TYPE_MINT;
        let second = TLV_START + 4 + 64;
        data[second..second + 4].copy_from_slice(&[25, 0, 56, 0]);
        assert_eq!(find_scaled_ui_amount_config(&data).unwrap(), None);
    }

    #[test]
    fn a_hostile_account_never_panics() {
        // On-chain this matters more than correctness: a panic in a programme
        // aborts the whole transaction, so a malformed account passed to this
        // reader must come back as `Ok(None)` or `Err`, never as a crash. Every
        // fixture is replayed at every length, twice - as a mint (discriminant
        // 1) and as a token account (2) - so no offset is ever indexed past the
        // end of the buffer it was given.
        for bytes in [PPLTX, SPACEX, AZNX, SPCXX, USDC] {
            for len in 0..=bytes.len() {
                let prefix = &bytes[..len];
                for discriminant in [1u8, 2u8] {
                    let mut data = prefix.to_vec();
                    if data.len() > ACCOUNT_TYPE_OFFSET {
                        data[ACCOUNT_TYPE_OFFSET] = discriminant;
                    }
                    // The assertion is that neither of these crashes.
                    let found = find_scaled_ui_amount_config(&data);
                    let read = read_multiplier(&data, NOW);
                    assert_eq!(found.is_ok(), read.is_ok(), "both must agree on validity");
                }
            }
        }
    }

    #[test]
    fn effective_multiplier_matches_the_javascript_rule() {
        // Same rule as keeper/src/scaled.mjs, checked on constructed configs so
        // the two implementations cannot diverge on the awkward cases.
        let base = ScaledUiAmountConfig {
            authority: [0u8; 32],
            multiplier: 1.0,
            new_multiplier_effective_timestamp: 100,
            new_multiplier: 2.0,
        };
        assert_eq!(effective_multiplier(&base, 99).effective, 1.0);
        assert_eq!(effective_multiplier(&base, 100).effective, 2.0);
        assert_eq!(effective_multiplier(&base, 101).effective, 2.0);

        let inert = ScaledUiAmountConfig {
            multiplier: 1.0,
            new_multiplier: 1.0,
            new_multiplier_effective_timestamp: 100,
            ..base
        };
        let r = effective_multiplier(&inert, 500);
        assert!(!r.stale && !r.pending, "equal values change nothing");

        // A zero timestamp is NOT "nothing scheduled": the comparison is true,
        // so the spec applies `new_multiplier`. Initialization writes both fields
        // to the same value, which is the only reason the two readings have ever
        // agreed - so the case is asserted here even though the live catalogue
        // contains no mint where it would matter.
        let immediate = ScaledUiAmountConfig {
            new_multiplier_effective_timestamp: 0,
            new_multiplier: 4.0,
            ..base
        };
        let r = effective_multiplier(&immediate, 10_000);
        assert_eq!(r.effective, 4.0, "zero timestamp applies new_multiplier");
        assert!(r.stale, "the stored field is not the one the runtime uses");

        // The zero-timestamp case the catalogue does contain, and the reason
        // this distinction moves no published number: 541 of 933 mints.
        let zero_equal = ScaledUiAmountConfig {
            new_multiplier_effective_timestamp: 0,
            new_multiplier: 1.0,
            ..base
        };
        let r = effective_multiplier(&zero_equal, 10_000);
        assert_eq!(r.effective, 1.0);
        assert!(!r.stale && !r.pending, "equal values change nothing");
    }
}
