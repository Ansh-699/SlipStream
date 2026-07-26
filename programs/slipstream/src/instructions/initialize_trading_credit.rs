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
use crate::state::{TradingCredit, DISC_TRADING_CREDIT, SEED_CREDIT};

/// Instruction data: market_index: u16
const IX_DATA_LEN: usize = 2;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [trading_credit_acc, owner, system_program, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system_program.key() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index = u16::from_le_bytes([data[0], data[1]]);
    let market_idx_bytes = market_index.to_le_bytes();

    let (expected_pda, bump) = pinocchio::pubkey::find_program_address(
        &[SEED_CREDIT, owner.key().as_ref(), &market_idx_bytes],
        program_id,
    );
    if trading_credit_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    if !trading_credit_acc.data_is_empty() {
        return Err(SlipstreamError::AccountAlreadyInitialized.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(TradingCredit::LEN);
    let bump_bytes = [bump];
    let signer_seeds = seeds![SEED_CREDIT, owner.key().as_ref(), &market_idx_bytes, &bump_bytes];

    CreateAccount {
        from: owner,
        to: trading_credit_acc,
        lamports,
        space: TradingCredit::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&signer_seeds)])?;

    let credit = TradingCredit::from_account_info_mut_or_init(trading_credit_acc)?;
    credit.discriminator = DISC_TRADING_CREDIT;
    credit.bump = bump;
    credit.market_index = market_index;
    credit.active_orders = 0;
    credit._padding = [0u8; 2];
    credit.owner = *owner.key();
    credit.credit = 0;
    credit.committed = 0;
    credit.session_authority = [0u8; 32];
    credit.session_expiry = 0;

    Ok(())
}
