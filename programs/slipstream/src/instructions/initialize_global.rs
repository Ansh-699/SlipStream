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
use crate::state::{GlobalState, DISC_GLOBAL_STATE, SEED_GLOBAL};

/// initialize_global instruction data:
///   treasury:        [u8; 32]
///   insurance_vault: [u8; 32]
const IX_DATA_LEN: usize = 64;

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

    let (expected_pda, bump) = pinocchio::pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    if global_state_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    if !global_state_acc.data_is_empty() {
        return Err(SlipstreamError::AccountAlreadyInitialized.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(GlobalState::LEN);

    let bump_bytes = [bump];
    let signer_seeds = seeds![SEED_GLOBAL, &bump_bytes];

    CreateAccount {
        from: authority,
        to: global_state_acc,
        lamports,
        space: GlobalState::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&signer_seeds)])?;

    let mut treasury = [0u8; 32];
    treasury.copy_from_slice(&data[0..32]);
    let mut insurance_vault = [0u8; 32];
    insurance_vault.copy_from_slice(&data[32..64]);

    let state = GlobalState::from_account_info_mut_or_init(global_state_acc)?;
    state.discriminator = DISC_GLOBAL_STATE;
    state.bump = bump;
    state.market_count = 0;
    state.paused = 0;
    state._padding1 = [0u8; 3];
    state.authority = *authority.key();
    state.treasury = treasury;
    state.insurance_vault = insurance_vault;

    Ok(())
}
