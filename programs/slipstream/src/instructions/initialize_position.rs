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
use crate::state::{Position, DISC_POSITION, SEED_POSITION};

/// Instruction data: market_index: u16
const IX_DATA_LEN: usize = 2;

/// initialize_position (disc 0x19): create an empty `Position` PDA for `owner`
/// in the given market.
///
/// Nothing else in the program creates a `Position` — `settle_trades` only
/// matches an *existing* `DISC_POSITION` account, and `update_position`'s
/// opening branch only fires when the position is already allocated and zeroed
/// (`size == 0 && open_slot == 0`). This instruction allocates that account and
/// stamps the identity fields, leaving every numeric field zero so the first
/// settled fill opens the position.
///
/// Accounts:
///   [0] position        (W, PDA)
///   [1] owner           (signer, payer, W)
///   [2] system_program
///
/// Seeds: [SEED_POSITION, owner, u16le(market_index)].
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [position_acc, owner, system_program, _remaining @ ..] = accounts else {
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
        &[SEED_POSITION, owner.key().as_ref(), &market_idx_bytes],
        program_id,
    );
    if position_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    if !position_acc.data_is_empty() {
        return Err(SlipstreamError::AccountAlreadyInitialized.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(Position::LEN);
    let bump_bytes = [bump];
    let signer_seeds = seeds![SEED_POSITION, owner.key().as_ref(), &market_idx_bytes, &bump_bytes];

    CreateAccount {
        from: owner,
        to: position_acc,
        lamports,
        space: Position::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&signer_seeds)])?;

    let position = Position::from_account_info_mut(position_acc)?;
    position.discriminator = DISC_POSITION;
    position.bump = bump;
    position.market_index = market_index;
    position._padding1 = [0u8; 4];
    position.owner = *owner.key();
    // Numeric fields left zero so update_position's opening branch
    // (size == 0 && open_slot == 0) fires on the first settled fill.
    position.size = 0;
    position.entry_price = 0;
    position.collateral = 0;
    position.realized_pnl = 0;
    position.open_slot = 0;
    position.funding_index_snapshot_lo = 0;
    position.funding_index_snapshot_hi = 0;

    Ok(())
}
