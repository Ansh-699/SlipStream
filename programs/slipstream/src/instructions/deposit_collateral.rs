use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};
use pinocchio_token::instructions::Transfer;

use crate::error::SlipstreamError;
use crate::instructions::ensure_not_globally_paused;
use crate::state::{GlobalState, Market, UserAccount, SEED_GLOBAL};

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
        market_acc,
        global_state_acc,
        _remaining @ ..
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if global_state_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (global_pda, _) = pinocchio::pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    if global_state_acc.key() != &global_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    ensure_not_globally_paused(GlobalState::from_account_info(global_state_acc)?)?;

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

    // Pin the destination to THIS market's vault. Without it the caller chooses
    // where the tokens go: pass a token account of a worthless mint that you own as
    // both source and "vault", and the transfer succeeds while `free_collateral` is
    // credited 1:1 — collateral minted from nothing, withdrawable as real USDC.
    // The mint is pinned transitively: market.quote_vault is a fixed account with a
    // fixed mint, so a transfer into it can only succeed with the matching mint.
    if market_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    {
        let market = Market::from_account_info(market_acc)?;
        if quote_vault_acc.key() != &market.quote_vault {
            return Err(SlipstreamError::InvalidVault.into());
        }
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
