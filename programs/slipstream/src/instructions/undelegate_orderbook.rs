use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

/// See `undelegate_trading_credit`: MagicBlock `ScheduleCommitAndUndelegate`
/// = variant 2 (u32 LE), per the SDK's `createCommitAndUndelegateInstruction`.
const SCHEDULE_COMMIT_AND_UNDELEGATE_DATA: [u8; 4] = [2, 0, 0, 0];

use crate::error::SlipstreamError;
use crate::state::{GlobalState, SEED_ORDERBOOK};

const IX_DATA_LEN: usize = 2;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [
        payer,
        order_book_acc,
        global_state_acc,
        authority,
        magic_context,
        magic_program,
        delegation_program,
        system_program,
        _remaining @ ..
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let global = GlobalState::from_account_info(global_state_acc)?;
    if global.authority != *authority.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index = u16::from_le_bytes([data[0], data[1]]);

    let market_index_bytes = market_index.to_le_bytes();
    let (expected_pda, _bump) = pinocchio::pubkey::find_program_address(
        &[SEED_ORDERBOOK, &market_index_bytes],
        program_id,
    );
    if order_book_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    // ONE CPI: ScheduleCommitAndUndelegate. `magic_context` must be WRITABLE.
    let metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable(magic_context.key()),
        AccountMeta::writable(order_book_acc.key()),
    ];
    let ix = Instruction {
        program_id: magic_program.key(),
        accounts: &metas,
        data: &SCHEDULE_COMMIT_AND_UNDELEGATE_DATA,
    };
    invoke(&ix, &[payer, magic_context, order_book_acc])?;

    let _ = (delegation_program, system_program);
    Ok(())
}
