use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::Transfer;

use crate::error::SlipstreamError;
use crate::state::{GlobalState, SEED_GLOBAL};

/// propose_authority (disc 0x26): step 1 of a two-step authority transfer.
///
/// `GlobalState.authority` previously had NO rotation path at all — the only
/// admin key was permanent, with no recovery if it were ever lost and no way to
/// move to a new key (e.g. a multisig) without redeploying. A single-step
/// transfer (just overwrite `authority`) is also a classic footgun: a typoed
/// pubkey permanently bricks governance with no way back. This is the standard
/// propose-then-accept pattern instead: the NEW authority must sign a separate
/// instruction to accept before anything changes.
///
/// `GlobalState` was created at exactly 104 bytes with no spare padding large
/// enough for a 32-byte pubkey, so `pending_authority` is NOT added to the core
/// `GlobalState` struct (which would change `GlobalState::LEN` and break every
/// one of the ~10 existing call sites that load a live, still-104-byte account).
/// Instead this lazily extends the account by 32 bytes on first use — mirroring
/// how Market's mark-price timestamp and settlement cursor already live in
/// smuggled padding rather than growing the core struct — and reads/writes that
/// region directly by offset (see `PENDING_AUTHORITY_OFFSET` below).
///
/// Accounts:
///   [0] global_state (W)
///   [1] authority    (signer, payer for the one-time rent top-up)
///   [2] system_program
///
/// Instruction data: new_authority: [u8; 32]
const IX_DATA_LEN: usize = 32;

/// GlobalState::LEN (104) is the start of the smuggled extension.
const PENDING_AUTHORITY_OFFSET: usize = 104;
const EXTENDED_LEN: usize = PENDING_AUTHORITY_OFFSET + 32;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [global_state_acc, authority, system_program, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system_program.key() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    if global_state_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (global_pda, _) = pinocchio::pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    if global_state_acc.key() != &global_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    {
        let global = GlobalState::from_account_info(global_state_acc)?;
        if global.authority != *authority.key() {
            return Err(SlipstreamError::InvalidAuthority.into());
        }
    }

    // Lazily extend the account the first time this is ever called. Resizing
    // only changes data length, not lamports, so top up rent-exemption for the
    // new size before growing (Solana zero-inits the newly-allocated bytes).
    if global_state_acc.data_len() < EXTENDED_LEN {
        let rent = Rent::get()?;
        let target_lamports = rent.minimum_balance(EXTENDED_LEN);
        let current_lamports = unsafe { *global_state_acc.borrow_lamports_unchecked() };
        if target_lamports > current_lamports {
            Transfer {
                from: authority,
                to: global_state_acc,
                lamports: target_lamports - current_lamports,
            }
            .invoke()?;
        }
        global_state_acc.resize(EXTENDED_LEN)?;
    }

    let acc_data = unsafe { global_state_acc.borrow_mut_data_unchecked() };
    acc_data[PENDING_AUTHORITY_OFFSET..EXTENDED_LEN].copy_from_slice(&data[..32]);

    Ok(())
}
