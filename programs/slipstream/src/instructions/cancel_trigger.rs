use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::TriggerOrder;

/// cancel_trigger (disc 0x23): owner removes their SL/TP trigger; the account's
/// rent returns to the owner.
///
/// Accounts:
///   [0] trigger (W)
///   [1] owner   (signer, W — receives rent)
pub fn process(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [trigger_acc, owner, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let trigger = TriggerOrder::from_account_info(trigger_acc)?;
    if trigger.owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    close_trigger_account(trigger_acc, owner)
}

/// Zero a TriggerOrder account and move its lamports to `recipient` (Pinocchio
/// has no close_account; same pattern as close_liquidation_intent).
pub(crate) fn close_trigger_account(
    trigger_acc: &AccountInfo,
    recipient: &AccountInfo,
) -> ProgramResult {
    let data = unsafe { trigger_acc.borrow_mut_data_unchecked() };
    for b in data.iter_mut() {
        *b = 0;
    }
    let lamports = unsafe { *trigger_acc.borrow_lamports_unchecked() };
    unsafe {
        *trigger_acc.borrow_mut_lamports_unchecked() = 0;
        *recipient.borrow_mut_lamports_unchecked() += lamports;
    }
    Ok(())
}
