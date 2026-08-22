//! R6 — funding-rate clamp (`S3-01`).
//!
//! The live devnet replay: an 18.93 % per-interval premium multiplied by 48
//! uncapped catch-up intervals is −908.15 % of notional applied by one
//! permissionless call. The clamp is asserted at the `math::funding` seam,
//! which is where both bounds must live, because `compute_funding` is
//! permissionless and has no caller to gate.
#![cfg(test)]

use slipstream::math::funding::{
    compute_funding_rate, MAX_CATCHUP_INTERVALS, MAX_FUNDING_RATE_PER_INTERVAL,
};

/// 18-decimal fixed point, matching `math::fixed_point::FUNDING_SCALE`.
const SCALE: i128 = 1_000_000_000_000_000_000;

#[test]
fn test_compute_funding_clamps_premium_and_intervals() {
    // The live devnet inputs, read 2026-08-21T19:13:46Z:
    //   mark  = market.get_twap()            = 74_114_120  (stale local TWAP)
    //   index = dual-oracle median (Pyth)    = 91_317_865
    const MARK: u64 = 74_114_120;
    const INDEX: u64 = 91_317_865;

    let rate = compute_funding_rate(MARK, INDEX).expect("rate");

    // 1. The per-interval rate must be clamped in BOTH directions.
    assert!(
        rate.abs() <= MAX_FUNDING_RATE_PER_INTERVAL,
        "unclamped per-interval funding rate {} exceeds the bound {} \
         (live devnet replay: -18.929788 % in one interval)",
        rate,
        MAX_FUNDING_RATE_PER_INTERVAL
    );

    // 2. The catch-up cap must be small enough that one permissionless call
    //    cannot move the index by more than a few percent of notional.
    assert!(
        MAX_CATCHUP_INTERVALS > 0 && MAX_CATCHUP_INTERVALS <= 8,
        "MAX_CATCHUP_INTERVALS = {} is not a meaningful catch-up cap",
        MAX_CATCHUP_INTERVALS
    );

    // 3. The composed bound is the safety property: worst case for ONE call.
    let worst_case = MAX_FUNDING_RATE_PER_INTERVAL
        .checked_mul(MAX_CATCHUP_INTERVALS as i128)
        .expect("no overflow in the bound itself");
    assert!(
        worst_case.abs() <= SCALE / 10,
        "one permissionless compute_funding call can still move the index by {} \
         (>10 % of notional); the live replay moved it -9.120170 (-912 %)",
        worst_case
    );

    // 4. The clamp must not swallow ordinary funding. The documented normal
    //    scale is 1 bps per interval (INTEREST_RATE_PER_INTERVAL = 10^14).
    let normal = compute_funding_rate(100_000_000, 100_000_000).expect("rate");
    assert_eq!(
        normal, 100_000_000_000_000,
        "the clamp must leave a 0-premium interval at exactly the interest rate"
    );
    assert!(
        normal.abs() < MAX_FUNDING_RATE_PER_INTERVAL,
        "normal funding is at or above the clamp — the clamp is set too tight"
    );
}
