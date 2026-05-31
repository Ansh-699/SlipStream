use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::Pubkey,
    seeds,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};
use pinocchio_token::instructions::Transfer;

use crate::error::SlipstreamError;
use crate::state::{Position, UserAccount, DISC_POSITION, SEED_VAULT_AUTHORITY};

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // Required accounts:
    //   user_account, owner (signer), quote_vault, user_token_acc, vault_authority, token_program
    // Optional extra account (trailing): any Position account belonging to `owner`.
    // If passed, we enforce `position.open_slot != current_slot` so a user who opened
    // a position in this same slot cannot also withdraw here (flash-attack guard, §15).
    let [
        user_account_acc,
        owner,
        quote_vault_acc,
        user_token_acc,
        vault_authority_acc,
        _token_program,
        remaining @ ..
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

    // Gate 1: no unsettled fills
    if user.pending_fills > 0 {
        return Err(SlipstreamError::PendingFillsExist.into());
    }
    // Gate 2: no resting orders
    if user.reserved_margin > 0 {
        return Err(SlipstreamError::ReservedMarginExists.into());
    }
    // Gate 3: sufficient free
    if user.free_collateral < amount {
        return Err(SlipstreamError::InsufficientCollateral.into());
    }

    // Gate 4 (§15): same-slot guard. If any trailing account is a Position owned by
    // this user, it must have been opened in a previous slot.
    let clock = Clock::get()?;
    let now_slot = clock.slot;
    for acc in remaining.iter() {
        if acc.owner() != program_id {
            continue;
        }
        let data = unsafe { acc.borrow_data_unchecked() };
        if data.len() < Position::LEN || data[0] != DISC_POSITION {
            continue;
        }
        let pos: &Position = bytemuck::from_bytes(&data[..Position::LEN]);
        if pos.owner == *owner.key() && pos.open_slot == now_slot {
            return Err(SlipstreamError::SameSlotWithdrawal.into());
        }
    }

    let (vault_auth_pda, vault_auth_bump) = pinocchio::pubkey::find_program_address(
        &[SEED_VAULT_AUTHORITY],
        program_id,
    );
    if vault_authority_acc.key() != &vault_auth_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let vault_auth_bump_bytes = [vault_auth_bump];
    let signer_seeds = seeds![SEED_VAULT_AUTHORITY, &vault_auth_bump_bytes];
    Transfer {
        from: quote_vault_acc,
        to: user_token_acc,
        authority: vault_authority_acc,
        amount,
    }
    .invoke_signed(&[Signer::from(&signer_seeds)])?;

    let user_mut = UserAccount::from_account_info_mut(user_account_acc)?;
    user_mut.free_collateral = user_mut
        .free_collateral
        .checked_sub(amount)
        .ok_or(ProgramError::from(SlipstreamError::MathUnderflow))?;

    Ok(())
}
