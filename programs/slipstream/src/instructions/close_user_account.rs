use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::UserAccount;

/// close_user_account
///
/// Closes the caller's `UserAccount` PDA and refunds the rent to the owner. Only
/// permitted when the user has zero state across the protocol:
///   - `free_collateral == 0`
///   - `reserved_margin == 0`
///   - `pending_fills == 0`
///
/// Any TradingCredit accounts owned by this user must be closed independently
/// (via `withdraw_trading_credit` to drain credit, then their rent stays in the
/// PDA — closing them is a separate instruction we don't ship in MVP because
/// re-creating costs the same rent and the trade-off isn't worth a new instruction).
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [user_account_acc, owner, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if user_account_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

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
