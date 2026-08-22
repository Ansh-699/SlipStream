use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::Transfer;

use crate::error::SlipstreamError;
use crate::state::{GlobalState, KEEPER_EXTENDED_LEN, KEEPER_OFFSET, SEED_GLOBAL};

/// set_keeper (disc 0x2A): install the fill-log keeper role.
///
/// S10-01 (code half): `record_pending_fill`, `initialize_fill_log` and
/// `delegate_fill_log` gated on `GlobalState.authority` — the same key that is
/// the BPF upgrade authority and the USDC mint authority — so the fill-log
/// keeper VM had to hold it hot with a loaded keypair. Those three now also
/// accept this keeper, which can be a low-value key. The other four role
/// concentrations in S10-01 are key-ceremony actions no code change here can
/// perform.
///
/// The keeper lives PAST `GlobalState::LEN` at offset 136, extended length 168,
/// using the same lazy-resize pattern `propose_authority` uses for
/// `pending_authority` at offset 104. `GlobalState::LEN` stays 104, so every
/// live account keeps loading and nothing is bricked before this is called.
/// Writing all-zeros revokes the role and returns the three instructions to
/// `authority`-only.
///
/// Accounts:
///   [0] global_state (W)
///   [1] authority    (signer, W — pays the one-time rent top-up)
///   [2] system_program
///
/// Instruction data: keeper: [u8; 32]
const IX_DATA_LEN: usize = 32;

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
    // Only the admin key installs a keeper. Deliberately NOT widened to the
    // keeper itself: a keeper that can appoint its successor is the same key
    // concentration this instruction exists to break.
    {
        let global = GlobalState::from_account_info(global_state_acc)?;
        if global.authority != *authority.key() {
            return Err(SlipstreamError::InvalidAuthority.into());
        }
    }

    // Lazily extend the account the first time this is ever called. Resizing
    // only changes data length, not lamports, so top up rent-exemption for the
    // new size before growing (Solana zero-inits the newly-allocated bytes).
    if global_state_acc.data_len() < KEEPER_EXTENDED_LEN {
        let rent = Rent::get()?;
        let target_lamports = rent.minimum_balance(KEEPER_EXTENDED_LEN);
        let current_lamports = unsafe { *global_state_acc.borrow_lamports_unchecked() };
        if target_lamports > current_lamports {
            Transfer {
                from: authority,
                to: global_state_acc,
                // saturating, not `-`: the branch already proves it cannot
                // underflow, and `overflow-checks = true` turns any future
                // reordering of that branch into a panic instead of a refusal.
                lamports: target_lamports.saturating_sub(current_lamports),
            }
            .invoke()?;
        }
        global_state_acc.resize(KEEPER_EXTENDED_LEN)?;
    }

    let acc_data = unsafe { global_state_acc.borrow_mut_data_unchecked() };
    acc_data[KEEPER_OFFSET..KEEPER_EXTENDED_LEN].copy_from_slice(&data[..IX_DATA_LEN]);

    Ok(())
}
