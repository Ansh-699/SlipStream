use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::math::fixed_point::compute_unrealized_pnl;
use crate::math::funding::compute_funding_payment;
use crate::state::{Market, Position, UserAccount};

pub fn process(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [
        market_acc,
        position_acc,
        user_account_acc,
        owner,
        _remaining @ ..
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let market = Market::from_account_info(market_acc)?;
    let pos = Position::from_account_info(position_acc)?;

    if pos.owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }
    if pos.is_empty() {
        return Err(SlipstreamError::PositionNotFound.into());
    }

    // Use mark price for close-at-market. Prefer `last_mark_price` (refreshed
    // every crank_twap, same cadence as the circuit breaker) over the 30-min
    // TWAP: the TWAP lags fast moves, letting a losing trader close against a
    // stale average for a better price than the live market (liquidations
    // already price off the live oracle — see liquidate_position.rs). Falls
    // back to TWAP only if the market hasn't been cranked yet.
    let mark_price = if market.last_mark_price > 0 {
        market.last_mark_price
    } else {
        market.get_twap().ok_or(SlipstreamError::OracleStale)?
    };

    // Compute unrealized PnL
    let unrealized_pnl = compute_unrealized_pnl(pos.size, pos.entry_price, mark_price)?;

    // Compute accrued funding
    let funding_payment = compute_funding_payment(
        pos.size,
        market.get_cumulative_funding_index(),
        pos.get_funding_index_snapshot(),
    )?;

    let abs_size = pos.abs_size();

    // Update market OI
    let market_mut = Market::from_account_info_mut(market_acc)?;
    if pos.is_long() {
        market_mut.open_interest_long = market_mut.open_interest_long.saturating_sub(abs_size);
    } else {
        market_mut.open_interest_short = market_mut.open_interest_short.saturating_sub(abs_size);
    }

    // Net settlement = collateral + unrealized PnL + funding
    let settlement = (pos.collateral as i128)
        + (unrealized_pnl as i128)
        + (funding_payment as i128);

    // Zero out position
    let pos_mut = Position::from_account_info_mut(position_acc)?;
    pos_mut.realized_pnl += unrealized_pnl + funding_payment;
    pos_mut.size = 0;
    pos_mut.entry_price = 0;
    pos_mut.collateral = 0;
    pos_mut.set_funding_index_snapshot(market_mut.get_cumulative_funding_index());

    // Credit user
    let user_mut = UserAccount::from_account_info_mut(user_account_acc)?;
    if user_mut.owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    if settlement > 0 {
        user_mut.free_collateral = user_mut
            .free_collateral
            .checked_add(settlement as u64)
            .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
    } else {
        // Loss exceeds collateral - already absorbed
        let deficit = (-settlement) as u64;
        if market_mut.insurance_fund_balance >= deficit {
            market_mut.insurance_fund_balance -= deficit;
        } else {
            market_mut.insurance_fund_balance = 0;
        }
    }

    Ok(())
}
