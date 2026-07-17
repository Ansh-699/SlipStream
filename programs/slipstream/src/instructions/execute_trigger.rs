use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::instructions::close_position::do_close;
use crate::instructions::cancel_trigger::close_trigger_account;
use crate::state::{Market, Position, TriggerOrder, SEED_TRIGGER};

/// execute_trigger (disc 0x24): permissionless SL/TP execution. When the mark
/// price satisfies the trigger condition, closes the owner's FULL position via
/// the same settlement path as close_position; the trigger account's rent goes
/// to the executor as the crank incentive. If the position is already empty
/// (closed or liquidated since the trigger was placed), the stale trigger is
/// garbage-collected and its rent returns to the owner.
///
/// Accounts:
///   [0] market       (W)
///   [1] position     (W)
///   [2] user_account (W)
///   [3] trigger      (W)
///   [4] owner        (W, NOT a signer — validated against trigger.owner; receives
///                     rent on stale-trigger cleanup)
///   [5] executor     (signer, W — receives rent on execution)
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [market_acc, position_acc, user_account_acc, trigger_acc, owner, executor, _remaining @ ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !executor.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let trigger = *TriggerOrder::from_account_info(trigger_acc)?;
    if trigger.owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    // Bind the trigger account to its PDA so a crafted program-owned account
    // with the right discriminator can't be substituted.
    let market_index_bytes = trigger.market_index.to_le_bytes();
    let kind_bytes = [trigger.kind];
    let (expected_pda, _bump) = pinocchio::pubkey::find_program_address(
        &[SEED_TRIGGER, owner.key().as_ref(), &market_index_bytes, &kind_bytes],
        program_id,
    );
    if trigger_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    // Stale trigger (position closed/liquidated since placement): GC it, rent
    // back to the owner.
    let pos = Position::from_account_info(position_acc)?;
    if pos.owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }
    if pos.market_index != trigger.market_index {
        return Err(SlipstreamError::InvalidMarketIndex.into());
    }
    if pos.is_empty() {
        return close_trigger_account(trigger_acc, owner);
    }

    let market = Market::from_account_info(market_acc)?;
    if market.market_index != trigger.market_index {
        return Err(SlipstreamError::InvalidMarketIndex.into());
    }
    // A stale mark must not fire triggers either — settling an SL/TP off a dead
    // feed is exactly the scenario the freshness gate exists to prevent.
    let now_ts = Clock::get()?.unix_timestamp;
    let mark = market
        .mark_price_for_close(now_ts)
        .ok_or(SlipstreamError::OracleStale)?;
    if !trigger.is_met(mark) {
        return Err(SlipstreamError::TriggerConditionNotMet.into());
    }

    // Full close at mark, no extra bound (the trigger price IS the user's bound;
    // execution happens at the first crank where the condition holds).
    do_close(market_acc, position_acc, user_account_acc, owner.key(), 0, 0)?;

    // Rent to the executor — the incentive that keeps triggers permissionless.
    close_trigger_account(trigger_acc, executor)
}
