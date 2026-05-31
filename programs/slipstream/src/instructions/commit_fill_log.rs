use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::SEED_FILL_LOG;

/// MagicBlock magic program: Magic11111111111111111111111111111111111111
const MAGIC_PROGRAM_ID: Pubkey = [
    0x05, 0x45, 0xb4, 0x24, 0xb0, 0xda, 0x70, 0x95,
    0xec, 0xb9, 0xd6, 0xde, 0xc3, 0x77, 0xd7, 0x28,
    0x91, 0xb6, 0xe7, 0x8e, 0x92, 0xea, 0x12, 0xd6,
    0xdf, 0xbb, 0x3a, 0x40, 0x00, 0x00, 0x00, 0x00,
];

/// MagicBlock `MagicContext1111111111111111111111111111111`.
const MAGIC_CONTEXT_ID: Pubkey = [
    0x05, 0x45, 0xb4, 0x24, 0xc4, 0xa5, 0x28, 0xbf,
    0x5f, 0xb4, 0x03, 0x2f, 0x44, 0x52, 0x82, 0x8e,
    0xbb, 0x38, 0xab, 0xc1, 0xd2, 0xdc, 0x97, 0xf7,
    0x3f, 0x8b, 0x94, 0x54, 0x80, 0x00, 0x00, 0x00,
];

/// MagicBlock `ScheduleCommit` = variant 1 (u32 LE), per the installed SDK's
/// `createCommitInstruction` (`data.writeUInt32LE(1, 0)`).
const SCHEDULE_COMMIT_DATA: [u8; 4] = [1, 0, 0, 0];

/// commit_fill_log (disc 0x20): schedule a commit of the (still-delegated)
/// FillLog's ER state back to L1, WITHOUT undelegating it — the commit-only half
/// of the flow, exactly like `commit_orderbook` but for the small FillLog.
///
/// This is the account settlement actually commits: it's small (~8 KB), so each
/// commit is cheap, and because it's a separate delegated account from the
/// 612 KB OrderBook it carries its OWN sponsored-commit budget. When that budget
/// nears the cap the keeper rotates to a fresh epoch FillLog.
///
/// Runs ON THE ER. Accounts:
///   [0] payer         (signer, writable)
///   [1] fill_log      (writable)  — the delegated FillLog PDA to commit
///   [2] magic_context (writable)
///   [3] magic_program (read)
///
/// Instruction data: market_index: u16, epoch: u32 (6 bytes)
const IX_DATA_LEN: usize = 2 + 4;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [payer, fill_log_acc, magic_context, magic_program, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if magic_program.key() != &MAGIC_PROGRAM_ID {
        return Err(SlipstreamError::InvalidProgramId.into());
    }
    if magic_context.key() != &MAGIC_CONTEXT_ID {
        return Err(SlipstreamError::InvalidPda.into());
    }
    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index = u16::from_le_bytes([data[0], data[1]]);
    let epoch = u32::from_le_bytes([data[2], data[3], data[4], data[5]]);
    let market_index_bytes = market_index.to_le_bytes();
    let epoch_bytes = epoch.to_le_bytes();

    let (expected_pda, _bump) = pinocchio::pubkey::find_program_address(
        &[SEED_FILL_LOG, &market_index_bytes, &epoch_bytes],
        program_id,
    );
    if fill_log_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let account_metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable(magic_context.key()),
        AccountMeta::writable(fill_log_acc.key()),
    ];
    let instruction = Instruction {
        program_id: &MAGIC_PROGRAM_ID,
        accounts: &account_metas,
        data: &SCHEDULE_COMMIT_DATA,
    };
    invoke(&instruction, &[payer, magic_context, fill_log_acc])?;

    Ok(())
}
