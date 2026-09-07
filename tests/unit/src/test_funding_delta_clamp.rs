//! Regression tests for the funding-index DELTA clamp in
//! `compute_funding_payment`.
//!
//! `compute_funding_rate` was already clamped (test_funding_clamp_regressions),
//! but that only bounds what goes INTO `Market.cumulative_funding_index`.
//! Nothing bounded what came back OUT: `claim_funding` / `settle_trades` /
//! `close_position` / `liquidate_position` all multiplied the RAW
//! `current - snapshot` delta by the position's notional.
//!
//! Live on devnet 2026-09-07, market ECUp8pXzVLzxjVs8mtKBJma3mdcHf8zSC4cqPeBy8MPy:
//!   cumulative_funding_index = -10_520_030_801_659_083_370 raw = -10.52
//! A position whose snapshot sat near zero was therefore owed 10.52x its own
//! notional, against an insurance fund holding 0.085 USDC and a vault holding
//! 737,915 USDC.
#![cfg(test)]

use slipstream::math::funding::{
    compute_funding_payment, INTEREST_RATE_PER_INTERVAL, MAX_CATCHUP_INTERVALS,
    MAX_FUNDING_INDEX_DELTA, MAX_FUNDING_RATE_PER_INTERVAL,
};

/// The measured live index, raw 18-dp.
const LIVE_INDEX: i128 = -10_520_030_801_659_083_370;

const ONE_SOL: i64 = 1_000_000_000; // BASE_SCALE
const MARK: u64 = 101_818_731; // live last_mark_price, ~$101.82 at PRICE_SCALE

/// notional of |size| SOL at MARK, in 6-dp quote atoms.
fn notional(size: i64) -> i128 {
    (size.unsigned_abs() as i128) * (MARK as i128) / 1_000_000_000
}

/// The ceiling must stay derived from the two constants the funding module
/// already reasons in, not drift into an independent magic number.
#[test]
fn test_clamp_ceiling_is_one_compute_funding_call() {
    assert_eq!(
        MAX_FUNDING_INDEX_DELTA,
        MAX_FUNDING_RATE_PER_INTERVAL * (MAX_CATCHUP_INTERVALS as i128),
        "the per-settlement ceiling must equal the most one permissionless \
         compute_funding call can add to the index"
    );
    // 1.5% of notional = 150x the 1 bps/interval ordinary rate
    // (INTEREST_RATE_PER_INTERVAL), so honest funding never touches the ceiling.
    assert_eq!(MAX_FUNDING_INDEX_DELTA, 15_000_000_000_000_000);
    assert_eq!(MAX_FUNDING_INDEX_DELTA / INTEREST_RATE_PER_INTERVAL, 150);
}

/// THE defect. A 1 SOL long at the live index with a zero snapshot used to be
/// credited 10.52 x $101.82 = $1,071.13. It must now be capped at 1.5% of
/// notional = $1.53.
#[test]
fn test_live_devnet_index_no_longer_pays_ten_times_notional() {
    let payment = compute_funding_payment(ONE_SOL, LIVE_INDEX, 0, MARK).expect("payment");

    // Negative = the position RECEIVES (math/funding.rs convention).
    assert!(payment < 0, "a long at a negative index receives funding");

    let unclamped = notional(ONE_SOL) * LIVE_INDEX / 1_000_000_000_000_000_000i128;
    assert_eq!(unclamped, -1_071_136_186, "sanity: the old payout, $1,071.14");

    let bound = notional(ONE_SOL) * MAX_FUNDING_INDEX_DELTA / 1_000_000_000_000_000_000i128;
    assert_eq!(payment as i128, -bound);
    assert_eq!(payment, -1_527_280, "$1.53, 1.5% of a $101.82 notional");
}

/// Sign symmetry: an equally absurd POSITIVE index must be clamped just as hard,
/// or the clamp becomes a one-sided subsidy (a long would be billed 10.52x).
#[test]
fn test_clamp_is_symmetric() {
    let receives = compute_funding_payment(ONE_SOL, LIVE_INDEX, 0, MARK).expect("recv");
    let pays = compute_funding_payment(ONE_SOL, -LIVE_INDEX, 0, MARK).expect("pays");
    assert_eq!(pays, -receives);

    // And a SHORT mirrors a long at the same index, still under the bound.
    let short = compute_funding_payment(-ONE_SOL, LIVE_INDEX, 0, MARK).expect("short");
    assert_eq!(short, -receives);
}

/// The clamp is on the DELTA, not on the absolute index: a position whose
/// snapshot has kept up with a huge accrued index is unaffected.
#[test]
fn test_clamp_applies_to_delta_not_absolute_index() {
    // Snapshot one ordinary interval behind an already-enormous index.
    let snapshot = LIVE_INDEX;
    let current = LIVE_INDEX + INTEREST_RATE_PER_INTERVAL;
    let payment = compute_funding_payment(ONE_SOL, current, snapshot, MARK).expect("payment");

    let expected =
        notional(ONE_SOL) * INTEREST_RATE_PER_INTERVAL / 1_000_000_000_000_000_000i128;
    assert_eq!(payment as i128, expected);
    assert_eq!(payment, 10_181, "1 bps of $101.82 = $0.0102, untouched");
}

/// Ordinary funding must pass through byte-identically — the clamp is a ceiling,
/// not a rescale. One full crank's accrual (3 intervals at the max rate) sits
/// exactly ON the boundary and must still be paid in full.
#[test]
fn test_ordinary_and_boundary_accrual_pass_through_unchanged() {
    for delta in [
        INTEREST_RATE_PER_INTERVAL,
        INTEREST_RATE_PER_INTERVAL * 3,
        MAX_FUNDING_RATE_PER_INTERVAL,
        MAX_FUNDING_INDEX_DELTA, // exactly one compute_funding call
    ] {
        let payment = compute_funding_payment(ONE_SOL, delta, 0, MARK).expect("payment");
        let expected = notional(ONE_SOL) * delta / 1_000_000_000_000_000_000i128;
        assert_eq!(
            payment as i128, expected,
            "delta {delta} is at or below the ceiling and must not be clamped"
        );
    }
}

/// The whole live long side (85.8 SOL of open interest) settling at once must
/// stay far inside the vault, which is the property the 0.085 USDC insurance
/// fund cannot otherwise provide.
#[test]
fn test_whole_live_long_open_interest_is_bounded() {
    const OI_LONG: i64 = 85_800_000_000; // 85.8 SOL
    const VAULT_USDC_ATOMS: i128 = 737_915_000_000;

    let payment = compute_funding_payment(OI_LONG, LIVE_INDEX, 0, MARK).expect("payment");
    let owed = (-payment) as i128;

    let unclamped = -(notional(OI_LONG) * LIVE_INDEX / 1_000_000_000_000_000_000i128);
    assert!(
        unclamped > VAULT_USDC_ATOMS / 10,
        "sanity: the unclamped payout ({unclamped} atoms, ~$91.9K) was a material \
         fraction of the {VAULT_USDC_ATOMS}-atom vault"
    );
    assert!(
        owed * 1000 < VAULT_USDC_ATOMS,
        "clamped payout {owed} must be < 0.1% of the vault, was {unclamped} unclamped"
    );
}

/// A zero-size position still short-circuits before any delta arithmetic.
#[test]
fn test_zero_size_still_pays_nothing() {
    assert_eq!(
        compute_funding_payment(0, LIVE_INDEX, 0, MARK).expect("payment"),
        0
    );
}
