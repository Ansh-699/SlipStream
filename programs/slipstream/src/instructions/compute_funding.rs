use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::math::funding::{compute_funding_rate, MAX_CATCHUP_INTERVALS};
use crate::oracle::{apply_dual_oracle, DualOracleOutcome};
use crate::state::Market;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [market_acc, pyth_feed_acc, switchboard_feed_acc, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if market_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Check funding interval, and how many WHOLE intervals have actually elapsed
    // — a caller (this instruction is permissionless) or a keeper outage can let
    // more than one interval pass between calls, and crediting exactly one
    // interval's rate regardless permanently under-accrues the rest.
    let (intervals, next_funding_ts) = {
        let market = Market::from_account_info(market_acc)?;
        let interval_secs = market.funding_interval_secs as i64;
        let elapsed = now - market.last_funding_ts;
        if elapsed < interval_secs {
            return Err(SlipstreamError::InvalidExpiryTimestamp.into());
        }
        // Truncating integer division, toward zero (S3-C1): the discarded
        // remainder is sub-interval and is not lost — see `next_funding_ts`.
        let raw_intervals = elapsed / interval_secs;
        // Cap the catch-up. This is half of the S3-01 bound; the other half is
        // the per-interval clamp inside compute_funding_rate. Together they
        // bound ONE call of this permissionless instruction to
        // MAX_FUNDING_RATE_PER_INTERVAL * MAX_CATCHUP_INTERVALS of notional,
        // which is what lets it stay permissionless as designed.
        let intervals = raw_intervals.min(MAX_CATCHUP_INTERVALS);

        let next_funding_ts = if raw_intervals > MAX_CATCHUP_INTERVALS {
            // Open decision 8 — FORGIVE the excess. Deferring it would hand the
            // cap straight back: the backlog would still be paid in full, just
            // spread over ceil(raw_intervals / cap) further permissionless
            // calls, so the aggregate would be unbounded again. A multi-day gap
            // is an operator outage, not a market signal.
            now
        } else {
            // Within the cap the original shape stands: advance by whole
            // intervals only (not to `now`), so a partial remainder stays owed
            // and counts toward the NEXT call's elapsed time instead of being
            // silently discarded every time this is called mid-interval.
            // Checked, not saturating: a saturated timestamp would silently
            // freeze funding accrual forever, whereas an overflow here can only
            // come from a corrupt `funding_interval_secs` and must abort.
            intervals
                .checked_mul(interval_secs)
                .and_then(|span| market.last_funding_ts.checked_add(span))
                .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?
        };
        (intervals, next_funding_ts)
    };

    // Mark price = local TWAP from book midprice samples
    let mark_price = {
        let market = Market::from_account_info(market_acc)?;
        market.get_twap().ok_or(SlipstreamError::OracleStale)?
    };

    // Index price = dual-oracle median (also flips restricted_mode if oracles disagree)
    let index_price = {
        let market = Market::from_account_info_mut(market_acc)?;
        match apply_dual_oracle(market, pyth_feed_acc, switchboard_feed_acc, now)? {
            DualOracleOutcome::Price(p) => p,
            // Returning Err here would roll back the restricted_mode/
            // agreement_streak update apply_dual_oracle just made. Skip
            // accruing funding this call instead — the flag change commits,
            // and the keeper simply retries next interval.
            DualOracleOutcome::Restricted => return Ok(()),
        }
    };
    if index_price == 0 {
        return Err(SlipstreamError::InvalidOracle.into());
    }

    let funding_rate_per_interval = compute_funding_rate(mark_price, index_price)?;
    let funding_rate = funding_rate_per_interval
        .checked_mul(intervals as i128)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;

    let market_mut = Market::from_account_info_mut(market_acc)?;
    let current_index = market_mut.get_cumulative_funding_index();
    let new_index = current_index
        .checked_add(funding_rate)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
    market_mut.set_cumulative_funding_index(new_index);
    market_mut.last_funding_ts = next_funding_ts;

    Ok(())
}
