use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::math::fixed_point::compute_unrealized_pnl;
use crate::math::funding::compute_funding_payment;
use crate::state::{Market, Position, UserAccount};

/// close_position (disc 0x08): close a settled L1 position at the mark price.
///
/// Accounts:
///   [0] market       (W)
///   [1] position     (W)
///   [2] user_account (W)
///   [3] owner        (signer)
///
/// Instruction data (both fields OPTIONAL — empty data preserves the original
/// wire format: full close, no price bound):
///   close_size:  u64  — base atoms to close; 0 or >= |size| means full close
///   limit_price: u64  — slippage bound on the mark price used to settle; 0 = no
///                       bound. Closing a long sells, so mark must be >= limit;
///                       closing a short buys back, so mark must be <= limit.
pub fn process(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
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

    let (close_size, limit_price) = if data.len() >= 16 {
        (
            u64::from_le_bytes(data[0..8].try_into().unwrap()),
            u64::from_le_bytes(data[8..16].try_into().unwrap()),
        )
    } else {
        (0, 0)
    };

    do_close(
        market_acc,
        position_acc,
        user_account_acc,
        owner.key(),
        close_size,
        limit_price,
    )
}

/// Close `close_size` of the position (0 = all) at `mark_price_for_close()`,
/// enforcing `limit_price` when non-zero. Shared by close_position (owner-signed)
/// and execute_trigger (keeper-fired SL/TP), which authenticate the owner
/// differently but settle identically.
pub(crate) fn do_close(
    market_acc: &AccountInfo,
    position_acc: &AccountInfo,
    user_account_acc: &AccountInfo,
    owner_key: &Pubkey,
    close_size: u64,
    limit_price: u64,
) -> ProgramResult {
    let market = Market::from_account_info(market_acc)?;
    let pos = Position::from_account_info(position_acc)?;

    if pos.owner != *owner_key {
        return Err(SlipstreamError::InvalidAuthority.into());
    }
    if pos.is_empty() {
        return Err(SlipstreamError::PositionNotFound.into());
    }

    // Use mark price for close-at-market (see Market::mark_price_for_close).
    // OracleStale here also covers a mark whose refresh stamp aged out — a dead
    // crank must not silently settle closes at a stale price.
    let now_ts = Clock::get()?.unix_timestamp;
    let mark_price = market
        .mark_price_for_close(now_ts)
        .ok_or(SlipstreamError::OracleStale)?;

    // Slippage bound: closing a long sells (mark must not be below the limit);
    // closing a short buys back (mark must not be above it).
    if limit_price > 0 {
        let violated = if pos.is_long() {
            mark_price < limit_price
        } else {
            mark_price > limit_price
        };
        if violated {
            return Err(SlipstreamError::SlippageExceeded.into());
        }
    }

    let abs_size = pos.abs_size();
    let closing = if close_size == 0 || close_size >= abs_size {
        abs_size
    } else {
        close_size
    };
    let full_close = closing == abs_size;
    let signed_closing: i64 = if pos.is_long() {
        closing as i64
    } else {
        -(closing as i64)
    };

    // Unrealized PnL on the closed portion only.
    let unrealized_pnl = compute_unrealized_pnl(signed_closing, pos.entry_price, mark_price)?;

    // Funding settles on the FULL size (it accrued on the whole position since
    // the snapshot); the snapshot is then advanced so the remainder starts fresh.
    let funding_payment = compute_funding_payment(
        pos.size,
        market.get_cumulative_funding_index(),
        pos.get_funding_index_snapshot(),
    )?;

    // Collateral released proportionally to the closed fraction.
    let collateral_released = if full_close {
        pos.collateral
    } else {
        ((pos.collateral as u128) * (closing as u128) / (abs_size as u128)) as u64
    };

    // Update market OI
    let market_mut = Market::from_account_info_mut(market_acc)?;
    if pos.is_long() {
        market_mut.open_interest_long = market_mut.open_interest_long.saturating_sub(closing);
    } else {
        market_mut.open_interest_short = market_mut.open_interest_short.saturating_sub(closing);
    }

    // Net settlement = released collateral + closed-portion PnL + full funding
    let settlement = (collateral_released as i128)
        + (unrealized_pnl as i128)
        + (funding_payment as i128);

    let pos_mut = Position::from_account_info_mut(position_acc)?;
    pos_mut.realized_pnl += unrealized_pnl + funding_payment;
    if full_close {
        pos_mut.size = 0;
        pos_mut.entry_price = 0;
        pos_mut.collateral = 0;
    } else {
        pos_mut.size -= signed_closing;
        pos_mut.collateral -= collateral_released;
        // entry price unchanged on a reduce
    }
    pos_mut.set_funding_index_snapshot(market_mut.get_cumulative_funding_index());

    // Credit user
    let user_mut = UserAccount::from_account_info_mut(user_account_acc)?;
    if user_mut.owner != *owner_key {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    if settlement > 0 {
        user_mut.free_collateral = user_mut
            .free_collateral
            .checked_add(settlement as u64)
            .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
    } else {
        // Loss exceeds released collateral - absorbed by the insurance fund.
        // Log it: this is a socialized loss, and a silent one is unauditable.
        // sol_log_64 args: [deficit, fund_before, fund_after, bankrupt?, 0].
        let deficit = (-settlement) as u64;
        let fund_before = market_mut.insurance_fund_balance;
        let bankrupt = fund_before < deficit;
        if !bankrupt {
            market_mut.insurance_fund_balance -= deficit;
        } else {
            market_mut.insurance_fund_balance = 0;
        }
        pinocchio::log::sol_log("slipstream: close deficit absorbed by insurance fund");
        pinocchio::log::sol_log_64(
            deficit,
            fund_before,
            market_mut.insurance_fund_balance,
            bankrupt as u64,
            0,
        );
    }

    Ok(())
}
