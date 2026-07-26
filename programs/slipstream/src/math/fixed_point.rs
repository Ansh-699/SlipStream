use crate::error::SlipstreamError;
use pinocchio::program_error::ProgramError;

pub const PRICE_DECIMALS: u32 = 6;
pub const PRICE_SCALE: u64 = 1_000_000; // 10^6
/// Base-asset (size) decimals. Position/order sizes are denominated in base
/// atoms with 9 decimals (1 SOL = 1_000_000_000). Notional and PnL convert size
/// to quote (6-dp USDC) by dividing out this scale — NOT PRICE_SCALE. Using
/// PRICE_SCALE here was the historical "1000x margin" bug (size carried 9 dp but
/// was only divided by 1e6), which made a $X position lock ~$1000·X/leverage of
/// credit and defeated leverage entirely.
pub const BASE_SCALE: u64 = 1_000_000_000; // 10^9
pub const FUNDING_DECIMALS: u32 = 18;
pub const FUNDING_SCALE: u128 = 1_000_000_000_000_000_000; // 10^18
pub const BPS_SCALE: u64 = 10_000;

/// Multiply two u64 prices (6 decimal) and return u64 result (6 decimal).
/// Uses u128 intermediate to prevent overflow.
/// Result = (a * b) / PRICE_SCALE
pub fn mul_price(a: u64, b: u64) -> Result<u64, ProgramError> {
    let result = (a as u128)
        .checked_mul(b as u128)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?
        / (PRICE_SCALE as u128);
    if result > u64::MAX as u128 {
        return Err(SlipstreamError::MathOverflow.into());
    }
    Ok(result as u64)
}

/// Divide two u64 prices (6 decimal) and return u64 result (6 decimal).
/// Result = (a * PRICE_SCALE) / b
pub fn div_price(a: u64, b: u64) -> Result<u64, ProgramError> {
    if b == 0 {
        return Err(SlipstreamError::DivisionByZero.into());
    }
    let result = (a as u128)
        .checked_mul(PRICE_SCALE as u128)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?
        / (b as u128);
    if result > u64::MAX as u128 {
        return Err(SlipstreamError::MathOverflow.into());
    }
    Ok(result as u64)
}

/// Multiply a u64 size (9-dp base atoms) by a u64 price (6-dp) to get notional
/// in quote atoms (6-dp USDC).
///   notional = size * price / BASE_SCALE
/// Dividing by BASE_SCALE (10^9, the base-asset scale) — not PRICE_SCALE — is
/// what makes notional come out in true 6-dp quote terms, so margin = notional /
/// leverage reserves the economically-correct amount (real leverage).
pub fn compute_notional(size: u64, price: u64) -> Result<u64, ProgramError> {
    let result = (size as u128)
        .checked_mul(price as u128)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?
        / (BASE_SCALE as u128);
    if result > u64::MAX as u128 {
        return Err(SlipstreamError::MathOverflow.into());
    }
    Ok(result as u64)
}

/// Compute initial margin required: notional / max_leverage
pub fn compute_initial_margin(notional: u64, max_leverage: u8) -> Result<u64, ProgramError> {
    if max_leverage == 0 {
        return Err(SlipstreamError::DivisionByZero.into());
    }
    Ok(notional / (max_leverage as u64))
}

/// Compute maintenance margin: initial_margin / 2
pub fn compute_maintenance_margin(initial_margin: u64) -> u64 {
    initial_margin / 2
}

/// Apply basis points to an amount: (amount * bps) / 10000
pub fn apply_bps(amount: u64, bps: u16) -> Result<u64, ProgramError> {
    let result = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?
        / (BPS_SCALE as u128);
    if result > u64::MAX as u128 {
        return Err(SlipstreamError::MathOverflow.into());
    }
    Ok(result as u64)
}

/// Compute unrealized PnL for a position, in quote atoms (6-dp USDC).
/// For longs: (mark_price - entry_price) * abs_size / BASE_SCALE
/// For shorts: (entry_price - mark_price) * abs_size / BASE_SCALE
/// Size is 9-dp base atoms, so dividing by BASE_SCALE yields 6-dp quote PnL
/// (consistent with compute_notional). Returns signed i64.
pub fn compute_unrealized_pnl(
    size: i64,
    entry_price: u64,
    mark_price: u64,
) -> Result<i64, ProgramError> {
    if size == 0 {
        return Ok(0);
    }
    let abs_size = size.unsigned_abs();
    let price_diff: i128 = if size > 0 {
        (mark_price as i128) - (entry_price as i128)
    } else {
        (entry_price as i128) - (mark_price as i128)
    };
    let pnl = price_diff
        .checked_mul(abs_size as i128)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?
        / (BASE_SCALE as i128);
    Ok(pnl as i64)
}

/// Compute health factor: net_margin / maintenance_margin
/// Returns value with 6 decimal places (1_000_000 = 1.0)
pub fn compute_health_factor(
    collateral: u64,
    unrealized_pnl: i64,
    accrued_funding: i64,
    maintenance_margin: u64,
) -> Result<u64, ProgramError> {
    if maintenance_margin == 0 {
        return Ok(u64::MAX);
    }
    let net_margin = (collateral as i128) + (unrealized_pnl as i128) + (accrued_funding as i128);
    if net_margin <= 0 {
        return Ok(0);
    }
    let health = (net_margin as u128)
        .checked_mul(PRICE_SCALE as u128)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?
        / (maintenance_margin as u128);
    if health > u64::MAX as u128 {
        return Ok(u64::MAX);
    }
    Ok(health as u64)
}

/// Compute volume-weighted average entry price when adding to a position.
/// new_entry = (old_size * old_entry + fill_size * fill_price) / (old_size + fill_size)
pub fn compute_vwap_entry(
    old_size: u64,
    old_entry: u64,
    fill_size: u64,
    fill_price: u64,
) -> Result<u64, ProgramError> {
    let total_size = old_size
        .checked_add(fill_size)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
    if total_size == 0 {
        return Ok(0);
    }
    let old_notional = (old_size as u128) * (old_entry as u128);
    let fill_notional = (fill_size as u128) * (fill_price as u128);
    let total_notional = old_notional
        .checked_add(fill_notional)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
    let result = total_notional / (total_size as u128);
    Ok(result as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mul_price() {
        // 1.5 * 2.0 = 3.0
        assert_eq!(mul_price(1_500_000, 2_000_000).unwrap(), 3_000_000);
        // 100.0 * 0.5 = 50.0
        assert_eq!(mul_price(100_000_000, 500_000).unwrap(), 50_000_000);
        // 0.0 * anything = 0
        assert_eq!(mul_price(0, 1_000_000).unwrap(), 0);
    }

    #[test]
    fn test_div_price() {
        // 3.0 / 1.5 = 2.0
        assert_eq!(div_price(3_000_000, 1_500_000).unwrap(), 2_000_000);
        // 100 / 3 = 33.333333
        assert_eq!(div_price(100_000_000, 3_000_000).unwrap(), 33_333_333);
    }

    #[test]
    fn test_div_by_zero() {
        assert!(div_price(1_000_000, 0).is_err());
    }

    #[test]
    fn test_compute_notional() {
        // 10 SOL at $150.00 = $1500.00 (6-dp quote = 1_500_000_000)
        // size=10_000_000_000 (10 SOL, 9-dp), price=150_000_000 (6-dp)
        let notional = compute_notional(10_000_000_000, 150_000_000).unwrap();
        assert_eq!(notional, 1_500_000_000);
    }

    #[test]
    fn test_initial_margin() {
        // $1500 notional at 20x leverage = $75 margin
        let margin = compute_initial_margin(1_500_000_000, 20).unwrap();
        assert_eq!(margin, 75_000_000);
    }

    #[test]
    fn test_apply_bps() {
        // 6 bps of $1000 = $0.60
        let fee = apply_bps(1_000_000_000, 6).unwrap();
        assert_eq!(fee, 600_000);
    }

    /// Unlike every sibling in this file, apply_bps had no post-division
    /// overflow check: an amount/bps pair whose result exceeds u64::MAX used
    /// to truncate silently via `as u64` instead of erroring.
    #[test]
    fn test_apply_bps_rejects_overflow_instead_of_truncating() {
        let result = apply_bps(u64::MAX, 20_000); // 200% of u64::MAX
        assert!(
            matches!(result, Err(ProgramError::Custom(c)) if c == SlipstreamError::MathOverflow as u32),
            "expected MathOverflow, got {:?}",
            result
        );
    }

    #[test]
    fn test_unrealized_pnl_long_profit() {
        // Long 1 SOL, entry $100, mark $110 -> PnL = +$10 (6-dp = 10_000_000)
        let pnl = compute_unrealized_pnl(
            1_000_000_000, // 1 SOL (9-dp)
            100_000_000,   // $100
            110_000_000,   // $110
        )
        .unwrap();
        assert_eq!(pnl, 10_000_000); // $10.00 in 6-dp USDC
    }

    #[test]
    fn test_unrealized_pnl_short_profit() {
        // Short 1 SOL, entry $100, mark $90 -> PnL = +$10
        let pnl = compute_unrealized_pnl(
            -1_000_000_000, // -1 SOL (short)
            100_000_000,    // $100
            90_000_000,     // $90
        )
        .unwrap();
        assert_eq!(pnl, 10_000_000);
    }

    #[test]
    fn test_unrealized_pnl_long_loss() {
        let pnl = compute_unrealized_pnl(1_000_000_000, 100_000_000, 90_000_000).unwrap();
        assert_eq!(pnl, -10_000_000);
    }

    #[test]
    fn test_health_factor() {
        // collateral=$100, unrealized PnL=-$30, funding=$0, maint margin=$25
        // net_margin = 70, health = 70/25 = 2.8
        let hf = compute_health_factor(
            100_000_000,  // $100
            -30_000_000,  // -$30
            0,            // $0 funding
            25_000_000,   // $25 maint margin
        )
        .unwrap();
        assert_eq!(hf, 2_800_000); // 2.8 in 6-decimal
    }

    #[test]
    fn test_health_factor_underwater() {
        // collateral=$10, unrealized PnL=-$20 => net_margin=-$10 => health=0
        let hf = compute_health_factor(10_000_000, -20_000_000, 0, 5_000_000).unwrap();
        assert_eq!(hf, 0);
    }

    #[test]
    fn test_vwap_entry() {
        // 10 units at $100, adding 5 units at $120
        // VWAP = (10*100 + 5*120) / 15 = 1600/15 = 106.666...
        let vwap =
            compute_vwap_entry(10_000_000, 100_000_000, 5_000_000, 120_000_000).unwrap();
        assert_eq!(vwap, 106_666_666);
    }
}
