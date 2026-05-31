use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction, Signer},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    seeds,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::SEED_CREDIT;

/// Instruction data: market_index: u16
///
/// Note: Like `undelegate_orderbook`, this is a two-step CPI:
///   1. Magic program `commit_and_undelegate` (commits ER state back to L1)
///   2. Delegation program `undelegate` (returns write authority to this program)
///
/// After this instruction, the TradingCredit is owned by the program again and the
/// user can `withdraw_trading_credit`. We require `active_orders == 0` before
/// allowing undelegation to prevent orphaned slots on the ER; however this check
/// must happen on the ER side pre-commit, not here (we can't read delegated state
/// consistently). The ER session lifetime + periodic commits enforce this.
const IX_DATA_LEN: usize = 2;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [
        payer,
        trading_credit_acc,
        owner,
        magic_context,
        magic_program,
        delegation_program,
        system_program,
        _remaining @ ..
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index = u16::from_le_bytes([data[0], data[1]]);
    let market_index_bytes = market_index.to_le_bytes();

    let (expected_pda, bump) = pinocchio::pubkey::find_program_address(
        &[SEED_CREDIT, owner.key().as_ref(), &market_index_bytes],
        program_id,
    );
    if trading_credit_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let bump_bytes = [bump];
    let signer_seeds = seeds![SEED_CREDIT, owner.key().as_ref(), &market_index_bytes, &bump_bytes];

    // Step 1: commit state via Magic program
    let commit_data: [u8; 8] = [82, 104, 152, 228, 209, 208, 105, 105];
    let commit_metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable(trading_credit_acc.key()),
        AccountMeta::readonly(magic_context.key()),
    ];
    let commit_ix = Instruction {
        program_id: magic_program.key(),
        accounts: &commit_metas,
        data: &commit_data,
    };
    invoke_signed(
        &commit_ix,
        &[payer, trading_credit_acc, magic_context],
        &[Signer::from(&signer_seeds)],
    )?;

    // Step 2: undelegate
    let undelegate_data: [u8; 8] = [131, 148, 82, 248, 89, 223, 190, 255];
    let undelegate_metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable(trading_credit_acc.key()),
        AccountMeta::readonly(program_id),
        AccountMeta::readonly(&pinocchio_system::ID),
    ];
    let undelegate_ix = Instruction {
        program_id: delegation_program.key(),
        accounts: &undelegate_metas,
        data: &undelegate_data,
    };
    invoke_signed(
        &undelegate_ix,
        &[payer, trading_credit_acc, system_program],
        &[Signer::from(&signer_seeds)],
    )?;

    Ok(())
}
