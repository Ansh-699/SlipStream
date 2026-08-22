use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::{GlobalState, Position, UserAccount, SEED_GLOBAL, SEED_POSITION};

/// close_user_account
///
/// Closes the caller's `UserAccount` PDA and refunds the rent to the owner. Only
/// permitted when the user has zero state across the protocol:
///   - `free_collateral == 0`
///   - `reserved_margin == 0` (the credit ledger — nothing parked in a credit)
///   - `pending_fills == 0`
///   - no open Position on any market (see below)
///
/// Any TradingCredit accounts owned by this user must be closed independently
/// (via `withdraw_trading_credit` to drain credit, then their rent stays in the
/// PDA — closing them is a separate instruction we don't ship in MVP because
/// re-creating costs the same rent and the trade-off isn't worth a new instruction).
///
/// Accounts:
///   [0] user_account (W)
///   [1] owner        (signer)
///   [2] global_state (R)       — for market_count, so every market gets checked
///   [3..] exactly `market_count` Position PDAs, one per market index in order
///         (0, 1, 2, ...), each either not yet created (`data_is_empty()`) or
///         fully closed (`Position.size == 0`).
///
/// The three field checks above were the ONLY gate before this fix, and none of
/// them catch an open position: `reserved_margin` is now the credit ledger and
/// tracks only collateral parked in a TradingCredit, not position exposure
/// (it was dead — permanently 0 — when this gate was written),
/// `free_collateral` is naturally 0 once margin has moved into a
/// position via `fund_trading_credit`, and `pending_fills` is 0 as soon as the
/// keeper settles. A user could close their UserAccount while holding an
/// arbitrarily underwater open position: `liquidate_position` requires a live
/// UserAccount whose `owner` matches the position's, so with it purged (and only
/// the owner able to recreate it, since `initialize_user` requires the owner's
/// signature) the position becomes permanently unliquidatable — a free option
/// where a recovery lets the owner reopen the account and bank the gain, and a
/// loss is stranded on the counterparty/insurance fund. The Position accounts
/// are MANDATORY (not scanned from optional trailing accounts) precisely because
/// an optional scan is trivially bypassed by simply not passing the account —
/// the same class of gap `withdraw_collateral`'s same-slot guard has.
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [user_account_acc, owner, global_state_acc, positions @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if user_account_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    if global_state_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (global_pda, _) = pinocchio::pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    if global_state_acc.key() != &global_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    let market_count = GlobalState::from_account_info(global_state_acc)?.market_count;

    let user = UserAccount::from_account_info(user_account_acc)?;
    if user.owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }
    if user.free_collateral != 0 {
        return Err(SlipstreamError::InsufficientCollateral.into());
    }
    if user.reserved_margin != 0 {
        return Err(SlipstreamError::ReservedMarginExists.into());
    }
    if user.pending_fills != 0 {
        return Err(SlipstreamError::PendingFillsExist.into());
    }

    if positions.len() < market_count as usize {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    for (i, pos_acc) in positions.iter().take(market_count as usize).enumerate() {
        let market_index = i as u16;
        let (expected_pda, _) = pinocchio::pubkey::find_program_address(
            &[SEED_POSITION, owner.key().as_ref(), &market_index.to_le_bytes()],
            program_id,
        );
        if pos_acc.key() != &expected_pda {
            return Err(SlipstreamError::InvalidPda.into());
        }
        // Never created on this market — nothing to check.
        if pos_acc.data_is_empty() {
            continue;
        }
        let pos = Position::from_account_info(pos_acc)?;
        if !pos.is_empty() {
            return Err(SlipstreamError::PositionStillOpen.into());
        }
    }

    // Zero data so the discriminator is invalidated; transfer all lamports to owner.
    let data = unsafe { user_account_acc.borrow_mut_data_unchecked() };
    for b in data.iter_mut() {
        *b = 0;
    }
    let lamports = unsafe { *user_account_acc.borrow_lamports_unchecked() };
    unsafe {
        *user_account_acc.borrow_mut_lamports_unchecked() = 0;
        *owner.borrow_mut_lamports_unchecked() += lamports;
    }
    Ok(())
}
