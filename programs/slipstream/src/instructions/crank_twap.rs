use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
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

    // Parse Pyth price (shared dual-layout parser: legacy V2 + PriceUpdateV2).
    // crank_twap intentionally has no freshness gate — it only samples the mark
    // price into the TWAP ring; freshness matters for funding/liquidation, which
    // use `dual_oracle_read`/`apply_dual_oracle`.
    let price = crate::oracle::parse_pyth(pyth_feed_acc)?.price;
    if price == 0 {
        return Err(SlipstreamError::InvalidOracle.into());
    }

    let market = Market::from_account_info_mut(market_acc)?;

    // Check circuit breaker before updating TWAP
    // 10% move from current TWAP triggers pause
    if let Some(current_twap) = market.get_twap() {
        if current_twap > 0 {
            let diff = price.abs_diff(current_twap);
            // 10% threshold: diff * 10 > current_twap
            if diff * 10 > current_twap {
                market.circuit_breaker_active = 1;
            } else if market.circuit_breaker_active != 0 {
                // Reset circuit breaker if price is back within range
                market.circuit_breaker_active = 0;
            }
        }
    }

    market.push_twap_price(price);
    market.last_mark_price = price;

    Ok(())
}
