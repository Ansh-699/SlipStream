use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::Market;

/// crank_twap: reads Pyth price, pushes to Market TWAP ring buffer.
/// Also checks circuit breaker: if price moved >10% from 5-min TWAP, pauses market.
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [
        market_acc,
        pyth_feed_acc,
        _remaining @ ..
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if market_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    // This instruction is permissionless and writes `last_mark_price`, which
    // close_position / execute_trigger settle against — so the feed account MUST be
    // the one recorded at initialize_market. parse_pyth validates neither owner nor
    // identity, so without this any caller could pick the settlement price.
    {
        let market = Market::from_account_info(market_acc)?;
        crate::oracle::verify_feeds(market, pyth_feed_acc, None)?;
    }

    // Parse Pyth price (shared dual-layout parser: legacy V2 + PriceUpdateV2).
    let reading = crate::oracle::parse_pyth(pyth_feed_acc)?;
    // Gate on the ORACLE's own publish time, not just on the crank running: a dead
    // Pyth publisher must not keep stamping a frozen price as fresh.
    let now_ts = Clock::get()?.unix_timestamp;
    if !reading.is_fresh(now_ts) {
        return Err(SlipstreamError::OracleStale.into());
    }
    let price = reading.price;
    if price == 0 {
        return Err(SlipstreamError::InvalidOracle.into());
    }

    let market = Market::from_account_info_mut(market_acc)?;

    // Check circuit breaker before updating TWAP
    // 10% move from current TWAP triggers pause
    if let Some(current_twap) = market.get_twap() {
        if current_twap > 0 {
            let diff = price.abs_diff(current_twap);
            // 10% threshold. Expressed as a division so a large diff cannot
            // overflow the multiply (overflow-checks is on => that would abort).
            if diff > current_twap / 10 {
                market.circuit_breaker_active = 1;
            } else if market.circuit_breaker_active != 0 {
                // Reset circuit breaker if price is back within range
                market.circuit_breaker_active = 0;
            }
        }
    }

    market.push_twap_price(price);
    market.last_mark_price = price;
    // Stamp the refresh time so `mark_price_for_close` can reject a stale mark
    // if this crank (and settlement) stops running.
    let now_min = ((now_ts / 60) as u64 % 65536) as u16;
    market.set_mark_price_minute(now_min);

    Ok(())
}
