use crate::error::SlipstreamError;
use crate::math::fixed_point::FUNDING_SCALE;
use pinocchio::program_error::ProgramError;

/// Interest rate per funding interval: 0.01% = 1 bps = 0.0001
/// In 18-decimal fixed point: 0.0001 * 10^18 = 10^14
pub const INTEREST_RATE_PER_INTERVAL: i128 = 100_000_000_000_000; // 10^14

/// Compute the funding rate for one interval.
///
/// formula: funding_rate = premium_rate + interest_rate
/// premium_rate = (mark_price - index_price) / index_price
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

    Ok(funding_rate)
}

/// Compute the funding payment for a position.
///
/// payment = position_size * (current_funding_index - position_funding_snapshot) / FUNDING_SCALE
///
/// Positive payment means the position PAYS funding (longs pay when rate is positive).
/// Negative payment means the position RECEIVES funding.
///
/// Returns signed i64 in quote token atoms (6 decimal).
pub fn compute_funding_payment(
    position_size: i64,
    current_funding_index: i128,
    snapshot_funding_index: i128,
) -> Result<i64, ProgramError> {
    if position_size == 0 {
        return Ok(0);
    }

    let index_delta = current_funding_index
        .checked_sub(snapshot_funding_index)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;

    // payment = size * delta / FUNDING_SCALE
    // For longs (positive size): positive delta means they pay
    // For shorts (negative size): positive delta means they receive
    let payment = (position_size as i128)
        .checked_mul(index_delta)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?
        / (FUNDING_SCALE as i128);

    Ok(payment as i64)
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
        // mark = $101, index = $100: premium = 1% = 0.01
        let rate = compute_funding_rate(101_000_000, 100_000_000).unwrap();
        // premium = 10^16 (1% in 18-decimal), interest = 10^14
        // total = 10^16 + 10^14 = 10_100_000_000_000_000
        assert_eq!(rate, 10_100_000_000_000_000);
    }

    #[test]
    fn test_funding_rate_discount() {
        // mark = $99, index = $100: premium = -1%
        let rate = compute_funding_rate(99_000_000, 100_000_000).unwrap();
        // premium = -10^16, interest = 10^14
        // total = -10^16 + 10^14 = -9_900_000_000_000_000
        assert_eq!(rate, -9_900_000_000_000_000);
    }

    #[test]
    fn test_funding_payment_long_pays() {
        // Long 1 SOL, funding index moved from 0 to 0.001 (0.1%)
        let payment = compute_funding_payment(
            1_000_000_000,                   // 1 SOL
            1_000_000_000_000_000,           // 0.001 in 18-decimal
            0,                               // snapshot at 0
        )
        .unwrap();
        // payment = 1_000_000_000 * 1_000_000_000_000_000 / 10^18 = 1_000_000
        assert_eq!(payment, 1_000_000); // $1.00 in USDC atoms
    }

    #[test]
    fn test_funding_payment_short_receives() {
        // Short 1 SOL, funding index moved from 0 to 0.001
        let payment = compute_funding_payment(
            -1_000_000_000,                  // -1 SOL (short)
            1_000_000_000_000_000,           // 0.001
            0,
        )
        .unwrap();
        assert_eq!(payment, -1_000_000); // Receives $1.00
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
