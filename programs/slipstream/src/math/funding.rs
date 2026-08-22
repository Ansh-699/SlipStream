use crate::error::SlipstreamError;
use crate::math::fixed_point::{compute_notional, FUNDING_SCALE};
use pinocchio::program_error::ProgramError;

/// Interest rate per funding interval: 0.01% = 1 bps = 0.0001
/// In 18-decimal fixed point: 0.0001 * 10^18 = 10^14
pub const INTEREST_RATE_PER_INTERVAL: i128 = 100_000_000_000_000; // 10^14

/// Maximum |funding rate| applied in a single interval, 18-dp fixed point.
/// 0.5% = 5 * 10^15.
///
/// ECONOMIC POLICY, not a safety constant. The *shape* — a clamped premium
/// times a capped catch-up (`MAX_CATCHUP_INTERVALS`) — is the safety property
/// that makes a permissionless `compute_funding` harmless; it does not depend
/// on these numbers. Changing them is a constant edit, not a redesign.
/// 50x the ordinary per-interval rate (`INTEREST_RATE_PER_INTERVAL`), so
/// ordinary funding never touches the clamp.
pub const MAX_FUNDING_RATE_PER_INTERVAL: i128 = 5_000_000_000_000_000;

/// Maximum catch-up intervals one permissionless `compute_funding` call may
/// accrue. With the rate clamp above this bounds one call to +/-1.5% of
/// notional. Also economic policy; see `MAX_FUNDING_RATE_PER_INTERVAL`.
pub const MAX_CATCHUP_INTERVALS: i64 = 3;

/// Compute the funding rate for one interval.
///
/// formula: funding_rate = clamp(premium_rate + interest_rate)
/// premium_rate = (mark_price - index_price) / index_price
///
/// The clamp is here, at the source, and not at the caller: this feeds a
/// permissionless instruction, so there is no caller to gate. Unclamped, the
/// live devnet state (mark 74_114_120 vs index 91_317_865 — a stale local TWAP
/// against a moved oracle) yields -18.9% in a *single* interval.
///
/// Returns funding rate in 18-decimal fixed point (FUNDING_SCALE).
pub fn compute_funding_rate(mark_price: u64, index_price: u64) -> Result<i128, ProgramError> {
    if index_price == 0 {
        return Err(SlipstreamError::DivisionByZero.into());
    }

    // premium = (mark - index) / index, scaled to 18 decimals
    let mark_128 = mark_price as i128;
    let index_128 = index_price as i128;
    let premium_rate = (mark_128 - index_128)
        .checked_mul(FUNDING_SCALE as i128)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?
        / index_128;

    // funding_rate = premium_rate + interest_rate
    let funding_rate = premium_rate
        .checked_add(INTEREST_RATE_PER_INTERVAL)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;

    Ok(funding_rate.clamp(-MAX_FUNDING_RATE_PER_INTERVAL, MAX_FUNDING_RATE_PER_INTERVAL))
}

/// Compute the funding payment for a position.
///
/// payment = notional(|position_size|, mark_price) * sign(position_size)
///           * (current_funding_index - position_funding_snapshot) / FUNDING_SCALE
///
/// Positive payment means the position PAYS funding (longs pay when rate is positive).
/// Negative payment means the position RECEIVES funding.
///
/// Returns signed i64 in quote token atoms (6 decimal).
pub fn compute_funding_payment(
    position_size: i64,
    current_funding_index: i128,
    snapshot_funding_index: i128,
    mark_price: u64,
) -> Result<i64, ProgramError> {
    if position_size == 0 {
        return Ok(0);
    }

    let index_delta = current_funding_index
        .checked_sub(snapshot_funding_index)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;

    // The rate (index_delta / FUNDING_SCALE) is dimensionless; it must be applied
    // to the position's QUOTE-denominated notional, not to its raw base-atom size.
    // `position_size` carries BASE_SCALE (1e9) decimals, not PRICE_SCALE (1e6), so
    // multiplying it directly by the rate priced the base asset at a fixed $1000 —
    // the same class of bug fixed_point.rs documents having already fixed for
    // initial margin (compute_notional), never applied here.
    let abs_notional = compute_notional(position_size.unsigned_abs(), mark_price)? as i128;
    let signed_notional: i128 = if position_size > 0 {
        abs_notional
    } else {
        -abs_notional
    };

    // For longs (positive notional): positive delta means they pay
    // For shorts (negative notional): positive delta means they receive
    let payment = signed_notional
        .checked_mul(index_delta)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?
        / (FUNDING_SCALE as i128);

    i64::try_from(payment).map_err(|_| ProgramError::from(SlipstreamError::MathOverflow))
}

/// Compute the TWAP from a ring buffer of price snapshots.
/// Returns the average price with 6 decimal places.
pub fn compute_twap(prices: &[u64], count: u16) -> Result<u64, ProgramError> {
    if count == 0 {
        return Err(SlipstreamError::DivisionByZero.into());
    }
    let valid_count = count as usize;
    let sum: u128 = prices[..valid_count].iter().map(|&p| p as u128).sum();
    let avg = sum / (valid_count as u128);
    Ok(avg as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_funding_rate_at_parity() {
        // mark == index: premium = 0, rate = interest only
        let rate = compute_funding_rate(100_000_000, 100_000_000).unwrap();
        assert_eq!(rate, INTEREST_RATE_PER_INTERVAL); // 0.01%
    }

    #[test]
    fn test_funding_rate_premium() {
        // mark = $100.10, index = $100: premium = 0.1% = 0.001, inside the clamp,
        // so this still asserts the raw premium+interest arithmetic exactly.
        let rate = compute_funding_rate(100_100_000, 100_000_000).unwrap();
        // premium = 10^15 (0.1% in 18-decimal), interest = 10^14
        // total = 10^15 + 10^14 = 1_100_000_000_000_000
        assert_eq!(rate, 1_100_000_000_000_000);

        // mark = $101, index = $100: premium = 1%, which is ABOVE the 0.5%
        // per-interval bound and must come back clamped, not raw. Before the
        // S3-01 clamp this returned 10_100_000_000_000_000.
        let clamped = compute_funding_rate(101_000_000, 100_000_000).unwrap();
        assert_eq!(clamped, MAX_FUNDING_RATE_PER_INTERVAL);
    }

    #[test]
    fn test_funding_rate_discount() {
        // mark = $99.90, index = $100: premium = -0.1%, inside the clamp.
        let rate = compute_funding_rate(99_900_000, 100_000_000).unwrap();
        // premium = -10^15, interest = 10^14
        // total = -10^15 + 10^14 = -900_000_000_000_000
        assert_eq!(rate, -900_000_000_000_000);

        // mark = $99, index = $100: premium = -1%, below the bound, so the clamp
        // must bite in the NEGATIVE direction too. Before S3-01 this returned
        // -9_900_000_000_000_000; the live devnet replay was -18.9%.
        let clamped = compute_funding_rate(99_000_000, 100_000_000).unwrap();
        assert_eq!(clamped, -MAX_FUNDING_RATE_PER_INTERVAL);
    }

    #[test]
    fn test_funding_payment_long_pays() {
        // Long 1 SOL @ $150 mark, funding index moved from 0 to 0.001 (0.1%).
        // notional = 1 SOL * $150 = $150 = 150_000_000 (6dp). payment = notional *
        // rate = 150_000_000 * 0.001 = 150_000 ($0.15), not the price-less
        // 1_000_000_000 * 0.001 = 1_000_000 ($1.00) the old (buggy) formula gave.
        let payment = compute_funding_payment(
            1_000_000_000,                   // 1 SOL
            1_000_000_000_000_000,           // 0.001 in 18-decimal
            0,                               // snapshot at 0
            150_000_000,                     // $150 mark
        )
        .unwrap();
        assert_eq!(payment, 150_000); // $0.15 in USDC atoms
    }

    #[test]
    fn test_funding_payment_short_receives() {
        // Short 1 SOL @ $150 mark, funding index moved from 0 to 0.001
        let payment = compute_funding_payment(
            -1_000_000_000,                  // -1 SOL (short)
            1_000_000_000_000_000,           // 0.001
            0,
            150_000_000,
        )
        .unwrap();
        assert_eq!(payment, -150_000); // Receives $0.15
    }

    #[test]
    fn test_funding_payment_matches_price_scaled_notional() {
        // The exact worked example from the audit: 1 SOL, 1 bps rate (a single
        // interval's interest floor), at a $150 mark. The correct payment is 1 bps
        // of the $150 notional ($150 * 0.0001 = $0.015 = 15_000 atoms) — NOT the
        // price-less $1000/unit result (1000 * 0.0001 * 1e9-scaled = 100_000 atoms)
        // the formula returned before this fix.
        let payment = compute_funding_payment(
            1_000_000_000,                   // 1 SOL
            INTEREST_RATE_PER_INTERVAL,       // 1 bps
            0,
            150_000_000,                      // $150 mark
        )
        .unwrap();
        assert_eq!(payment, 15_000);
    }

    #[test]
    fn test_funding_payment_zero_mark_is_safe_not_exploitable() {
        // Before any oracle crank, last_mark_price is 0. Funding must be skipped
        // (not divide-by-zero, not an inflated/deflated payment either side could
        // exploit), since notional(size, 0) = 0.
        let payment = compute_funding_payment(1_000_000_000, INTEREST_RATE_PER_INTERVAL, 0, 0)
            .unwrap();
        assert_eq!(payment, 0);
    }

    #[test]
    fn test_twap_basic() {
        let prices = [100_000_000u64, 102_000_000, 104_000_000, 0, 0];
        let twap = compute_twap(&prices, 3).unwrap();
        assert_eq!(twap, 102_000_000); // $102.00
    }

    #[test]
    fn test_twap_empty() {
        let prices = [0u64; 5];
        assert!(compute_twap(&prices, 0).is_err());
    }
}
