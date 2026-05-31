use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};
use pinocchio_token::instructions::Transfer;

use crate::error::SlipstreamError;
use crate::state::UserAccount;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [
        user_account_acc,
        owner,
        user_token_acc,
        quote_vault_acc,
        _token_program,
        _remaining @ ..
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount = u64::from_le_bytes(data[..8].try_into().unwrap());
    if amount == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    if user_account_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let user = UserAccount::from_account_info(user_account_acc)?;
    if user.owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    Transfer {
        from: user_token_acc,
        to: quote_vault_acc,
        authority: owner,
        amount,
    }
    .invoke()?;

    let user_mut = UserAccount::from_account_info_mut(user_account_acc)?;
    user_mut.free_collateral = user_mut
        .free_collateral
        .checked_add(amount)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;

    Ok(())
}
