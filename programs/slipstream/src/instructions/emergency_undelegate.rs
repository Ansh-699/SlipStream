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

/// Hardcoded well-known MagicBlock addresses (mirrors commit_orderbook.rs).
const MAGIC_PROGRAM_ID: Pubkey = [
    0x05, 0x45, 0xb4, 0x24, 0xb0, 0xda, 0x70, 0x95, 0xec, 0xb9, 0xd6, 0xde, 0xc3, 0x77, 0xd7, 0x28,
    0x91, 0xb6, 0xe7, 0x8e, 0x92, 0xea, 0x12, 0xd6, 0xdf, 0xbb, 0x3a, 0x40, 0x00, 0x00, 0x00, 0x00,
];
const MAGIC_CONTEXT_ID: Pubkey = [
    0x05, 0x45, 0xb4, 0x24, 0xc4, 0xa5, 0x28, 0xbf, 0x5f, 0xb4, 0x03, 0x2f, 0x44, 0x52, 0x82, 0x8e,
    0xbb, 0x38, 0xab, 0xc1, 0xd2, 0xdc, 0x97, 0xf7, 0x3f, 0x8b, 0x94, 0x54, 0x80, 0x00, 0x00, 0x00,
];

// KNOWN LIMITATION (audit-confirmed): this instruction's two effects require
// mutually exclusive execution layers. `ScheduleCommitAndUndelegate` is a
// magic-program CPI that only exists inside the ER (see commit_orderbook.rs's
// identical CPI, documented as ER-only); `GlobalState` is never delegated, so it
// cannot be written from inside the ER and the ER never commits a non-delegated
// account back to L1. In practice: call this on L1 and the magic CPI reverts
// (the program doesn't exist there); call it on the ER and the `paused` write
// cannot land. Splitting into an L1-only pause/unpause plus an L1-only forced
// delegation-program `undelegate` is the real fix and is intentionally NOT done
// here — it changes this instruction's account list and is a design decision
// for whoever owns the incident-response runbook, not a drive-by patch. The
// identity pins below at least make a decoy-program bypass loud instead of silent.

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
    if magic_program.key() != &MAGIC_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if magic_context.key() != &MAGIC_CONTEXT_ID {
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
