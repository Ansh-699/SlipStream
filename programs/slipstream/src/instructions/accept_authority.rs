use pinocchio::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::SEED_GLOBAL;

/// accept_authority (disc 0x27): step 2 of the two-step authority transfer. See
/// propose_authority.rs for why `pending_authority` lives in a smuggled
/// extension rather than the core `GlobalState` struct.
///
/// Accounts:
///   [0] global_state    (W)
///   [1] pending_authority (signer) — must equal the pending_authority set by
///                           a prior propose_authority call
///
/// Instruction data: none
const PENDING_AUTHORITY_OFFSET: usize = 104; // GlobalState::LEN
const EXTENDED_LEN: usize = PENDING_AUTHORITY_OFFSET + 32;
/// GlobalState.authority field offset: discriminator(1)+bump(1)+market_count(2)
/// +paused(1)+_padding1(3) = 8 bytes header, then authority: [u8; 32].
const AUTHORITY_OFFSET: usize = 8;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [global_state_acc, pending_authority, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !pending_authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if global_state_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (global_pda, _) = pinocchio::pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    if global_state_acc.key() != &global_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let acc_data = unsafe { global_state_acc.borrow_mut_data_unchecked() };
    if acc_data.len() < EXTENDED_LEN {
        // No propose_authority call has ever extended this account.
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    let mut pending = [0u8; 32];
    pending.copy_from_slice(&acc_data[PENDING_AUTHORITY_OFFSET..EXTENDED_LEN]);
    if pending == [0u8; 32] || &pending != pending_authority.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    acc_data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(pending_authority.key());
    acc_data[PENDING_AUTHORITY_OFFSET..EXTENDED_LEN].fill(0);

    Ok(())
}
