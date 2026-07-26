use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

/// MagicBlock magic program `ScheduleCommitAndUndelegate` = variant 2 (u32 LE),
/// matching the SDK's `createCommitAndUndelegateInstruction`
/// (`Buffer.alloc(4); data.writeUInt32LE(2, 0)`), and consistent with the
/// `ScheduleCommit` = 1 encoding that `commit_fill_log` uses in production.
///
/// This replaces an 8-byte Anchor-style discriminator that the magic program
/// rejected outright ("invalid instruction data"), which left the protocol with NO
/// working undelegation path — including `emergency_undelegate`.
const SCHEDULE_COMMIT_AND_UNDELEGATE_DATA: [u8; 4] = [2, 0, 0, 0];

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

    let (expected_pda, _bump) = pinocchio::pubkey::find_program_address(
        &[SEED_CREDIT, owner.key().as_ref(), &market_index_bytes],
        program_id,
    );
    if trading_credit_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    // ONE CPI, not two: `ScheduleCommitAndUndelegate` commits the ER state and
    // schedules the undelegation. The base-layer `undelegate` on the delegation
    // program is performed by the validator afterwards — calling it here from the
    // ER was never correct. `magic_context` must be WRITABLE.
    let metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable(magic_context.key()),
        AccountMeta::writable(trading_credit_acc.key()),
    ];
    let ix = Instruction {
        program_id: magic_program.key(),
        accounts: &metas,
        data: &SCHEDULE_COMMIT_AND_UNDELEGATE_DATA,
    };
    invoke(&ix, &[payer, magic_context, trading_credit_acc])?;

    let _ = (delegation_program, system_program);
    Ok(())
}
