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
/// The previous 8-byte discriminator meant this escape hatch never worked.
const SCHEDULE_COMMIT_AND_UNDELEGATE_DATA: [u8; 4] = [2, 0, 0, 0];

use crate::error::SlipstreamError;
use crate::state::{GlobalState, SEED_ORDERBOOK};

/// emergency_undelegate
///
/// Authority-gated forcible commit + undelegate of a delegated account (typically
/// the OrderBook). Used when:
///   - The ER misbehaves (proven fraud)
///   - The 24h session timeout is too far away for an ongoing incident
///   - Operations need to drop into degraded mode (L1 matching) immediately
///
/// In production this should be gated on a 2-of-3 emergency multisig (§21). For
/// MVP we accept the GlobalState.authority signer; replacing it with a Squads
/// multisig PDA is a single field change in `GlobalState`.
///
/// Instruction data:
///   market_index: u16
///
/// Accounts:
///   [0] payer                  (signer, writable — pays for any rent in CPI)
///   [1] order_book             (writable — the delegated account)
///   [2] global_state           (read)
///   [3] authority              (signer — must equal `global_state.authority`)
///   [4] magic_context          (read)
///   [5] magic_program          (read)
///   [6] delegation_program     (read)
///   [7] system_program         (read)
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
    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let global = GlobalState::from_account_info(global_state_acc)?;
    if global.authority != *authority.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
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

    // Step 1: ONE CPI — ScheduleCommitAndUndelegate. `magic_context` must be WRITABLE.
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

    // Step 2: pause the entire protocol so no new orders land while operators investigate
    let global_mut = GlobalState::from_account_info_mut(global_state_acc)?;
    global_mut.paused = 1;

    Ok(())
}
