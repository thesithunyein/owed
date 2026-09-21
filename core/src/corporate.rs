//! Corporate-action math: splits and dividends.
//!
//! Rounding rules are part of the spec (see `docs/SPEC.md`):
//! * **Split** — each holder receives `floor(balance * num / den)`. The dust
//!   left by floor-division is **not** minted; total post-split supply is the
//!   sum of floored amounts, which the register conserves exactly.
//! * **Dividend** — each holder's entitlement is `balance * amount_per_token`,
//!   computed in u128; the escrow must hold at least the sum of entitlements.

/// Action kinds supported by the registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionType {
    /// Cash/stablecoin distribution: `amount_per_token` per unit held.
    Dividend,
    /// Balance adjustment by `ratio_num / ratio_den` (e.g. 4/1 forward split,
    /// 1/3 reverse split).
    Split,
    Merger,
    TickerChange,
}

/// A split's ratio and the exact adjustment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SplitRatio {
    pub num: u64,
    pub den: u64,
}

impl SplitRatio {
    pub fn new(num: u64, den: u64) -> crate::Result<Self> {
        if num == 0 || den == 0 {
            return Err(crate::Error::InvalidAction("split ratio parts must be nonzero"));
        }
        Ok(SplitRatio { num, den })
    }

    /// Adjust one balance. Returns `None` on overflow.
    pub fn adjust(&self, balance: u64) -> Option<u64> {
        let v = (balance as u128) * (self.num as u128);
        Some(v.checked_div(self.den as u128)?.try_into().ok()?)
    }

    /// Total post-split supply and the dust dropped by floor-division.
    pub fn adjust_supply(&self, total: u64) -> (u64, u64) {
        let v = (total as u128) * (self.num as u128);
        let floored = v / self.den as u128;
        let dust = v % self.den as u128;
        (floored as u64, dust as u64)
    }
}

/// Dividend entitlement for one holder.
pub fn dividend_entitlement(balance: u64, amount_per_token: u64) -> crate::Result<u128> {
    (balance as u128)
        .checked_mul(amount_per_token as u128)
        .ok_or(crate::Error::Overflow)
}

/// Sum of all dividend entitlements — the minimum escrow funding.
pub fn dividend_escrow_requirement(
    entries: &[crate::register::RegisterEntry],
    amount_per_token: u64,
) -> crate::Result<u128> {
    let mut total: u128 = 0;
    for e in entries {
        total = total
            .checked_add(dividend_entitlement(e.amount, amount_per_token)?)
            .ok_or(crate::Error::Overflow)?;
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::register::RegisterEntry;

    fn owner(n: u8) -> [u8; 32] {
        let mut o = [0u8; 32];
        o[0] = n;
        o
    }

    #[test]
    fn forward_split_4to1() {
        let r = SplitRatio::new(4, 1).unwrap();
        assert_eq!(r.adjust(100), Some(400));
        assert_eq!(r.adjust(0), Some(0));
        assert_eq!(r.adjust(1), Some(4));
    }

    #[test]
    fn reverse_split_1to3_floors() {
        let r = SplitRatio::new(1, 3).unwrap();
        assert_eq!(r.adjust(100), Some(33));
        assert_eq!(r.adjust(3), Some(1));
        assert_eq!(r.adjust(2), Some(0));
        // Supply: 100 -> 33 with 1 unit of dust (100/3 = 33.33).
        assert_eq!(r.adjust_supply(100), (33, 1));
    }

    #[test]
    fn zero_or_inverted_ratio_rejected() {
        assert!(SplitRatio::new(0, 1).is_err());
        assert!(SplitRatio::new(4, 0).is_err());
    }

    #[test]
    fn entitlement_fits_u128_and_escrow_overflow_is_caught() {
        // u64 * u64 always fits u128; the escrow *sum* can overflow with
        // enough max-value entries, and that must be an error, not a wrap.
        assert_eq!(dividend_entitlement(u64::MAX, u64::MAX).unwrap(), (u64::MAX as u128) * (u64::MAX as u128));
        let big = RegisterEntry::new([9; 32], u64::MAX);
        let entries = vec![big.clone(), big.clone(), big.clone(), big];
        assert!(dividend_escrow_requirement(&entries, u64::MAX).is_err());
    }

    #[test]
    fn dividend_math_and_escrow() {
        let entries = vec![
            RegisterEntry::new(owner(1), 60),
            RegisterEntry::new(owner(2), 40),
        ];
        // 2 units per token.
        assert_eq!(dividend_entitlement(60, 2).unwrap(), 120);
        assert_eq!(dividend_escrow_requirement(&entries, 2).unwrap(), 200);
    }

    #[test]
    fn split_conserves_register() {
        // After a 4:1 split, the register's amounts scale and still conserve.
        let holders = vec![(owner(1), 60u64), (owner(2), 40), (owner(3), 25)];
        let total: u64 = holders.iter().map(|h| h.1).sum();
        let r = SplitRatio::new(4, 1).unwrap();

        let adjusted: Vec<RegisterEntry> = holders
            .iter()
            .map(|&(o, b)| RegisterEntry::new(o, r.adjust(b).unwrap()))
            .collect();
        let new_total = r.adjust_supply(total).0;

        let reg = crate::register::Register::new(adjusted, new_total).unwrap();
        assert_eq!(reg.holder_count(), 3);
        assert_eq!(reg.entries()[0].amount, 60 * 4);
        assert_eq!(reg.entries()[1].amount, 40 * 4);
        assert_eq!(reg.entries()[2].amount, 25 * 4);
    }
}
