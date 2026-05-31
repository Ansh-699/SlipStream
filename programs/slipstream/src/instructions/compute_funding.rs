use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::math::funding::compute_funding_rate;
use crate::oracle::apply_dual_oracle;
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

    // Check funding interval
    {
        let market = Market::from_account_info(market_acc)?;
        let elapsed = now - market.last_funding_ts;
        if elapsed < market.funding_interval_secs as i64 {
            return Err(SlipstreamError::InvalidExpiryTimestamp.into());
        }
    }

    // Mark price = local TWAP from book midprice samples
    let mark_price = {
        let market = Market::from_account_info(market_acc)?;
        market.get_twap().ok_or(SlipstreamError::OracleStale)?
    };

    // Index price = dual-oracle median (also flips restricted_mode if oracles disagree)
    let index_price = {
        let market = Market::from_account_info_mut(market_acc)?;
        apply_dual_oracle(market, pyth_feed_acc, switchboard_feed_acc, now)?
    };
    if index_price == 0 {
        return Err(SlipstreamError::InvalidOracle.into());
    }

    let funding_rate = compute_funding_rate(mark_price, index_price)?;

    let market_mut = Market::from_account_info_mut(market_acc)?;
    let current_index = market_mut.get_cumulative_funding_index();
    let new_index = current_index
        .checked_add(funding_rate)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
    market_mut.set_cumulative_funding_index(new_index);
    market_mut.last_funding_ts = now;

    Ok(())
}
