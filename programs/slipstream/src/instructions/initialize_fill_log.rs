use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::Pubkey,
    seeds,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::error::SlipstreamError;
use crate::state::{
    fill_log_account_size, FillLogHeader, GlobalState, DISC_FILL_LOG, FILL_LOG_CAPACITY,
    SEED_FILL_LOG,
};

/// initialize_fill_log (disc 0x1D): create a small, append-only FillLog PDA for a
/// market+epoch. This is the account that the settlement pipeline commits to L1
/// instead of the 612 KB OrderBook — small enough to create in one CPI and to
/// (re)delegate, so its sponsored-commit budget can be refreshed by rotating the
/// epoch.
///
/// Accounts:
///   [0] global_state  (read)            — authority gate
///   [1] fill_log       (W, PDA)
///   [2] authority      (signer, payer, W)
///   [3] system_program
///
/// Instruction data: market_index: u16, epoch: u32  (6 bytes)
const IX_DATA_LEN: usize = 2 + 4;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [global_state_acc, fill_log_acc, authority, system_program, _remaining @ ..] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system_program.key() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let global = GlobalState::from_account_info(global_state_acc)?;
    if global.authority != *authority.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index = u16::from_le_bytes([data[0], data[1]]);
    let epoch = u32::from_le_bytes([data[2], data[3], data[4], data[5]]);
    let market_index_bytes = market_index.to_le_bytes();
    let epoch_bytes = epoch.to_le_bytes();

    let (expected_pda, bump) = pinocchio::pubkey::find_program_address(
        &[SEED_FILL_LOG, &market_index_bytes, &epoch_bytes],
        program_id,
    );
    if fill_log_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    if !fill_log_acc.data_is_empty() {
        return Err(SlipstreamError::AccountAlreadyInitialized.into());
    }

    let size = fill_log_account_size(FILL_LOG_CAPACITY);
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(size);
    let bump_bytes = [bump];
    let signer_seeds = seeds![SEED_FILL_LOG, &market_index_bytes, &epoch_bytes, &bump_bytes];

    CreateAccount {
        from: authority,
        to: fill_log_acc,
        lamports,
        space: size as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&signer_seeds)])?;

    let fl_data = unsafe { fill_log_acc.borrow_mut_data_unchecked() };
    let header: &mut FillLogHeader = bytemuck::from_bytes_mut(&mut fl_data[..FillLogHeader::LEN]);
    header.discriminator = DISC_FILL_LOG;
    header.bump = bump;
    header.market_index = market_index;
    header.epoch = epoch;
    header.capacity = FILL_LOG_CAPACITY;
    header.count = 0;
    header.head = 0;
    header._pad = [0u8; 2];
    header.last_mirrored_sequence = 0;

    Ok(())
}
