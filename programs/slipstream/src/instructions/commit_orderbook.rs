use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::SEED_ORDERBOOK;

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

/// MagicBlock `ScheduleCommit` instruction data.
///
/// The magic program's instruction enum is bincode-serialized; `ScheduleCommit`
/// is variant index 1, so the wire encoding is the u32 LE discriminant `1`
/// (`[1, 0, 0, 0]`). This matches the installed SDK's `createCommitInstruction`
/// (`data.writeUInt32LE(1, 0)`).
const SCHEDULE_COMMIT_DATA: [u8; 4] = [1, 0, 0, 0];

/// commit_orderbook instruction data: market_index: u16
const IX_DATA_LEN: usize = 2;

/// Schedule a commit of the (still-delegated) OrderBook's ER state back to the
/// base layer, WITHOUT undelegating it.
///
/// ## Why this exists
///
/// MagicBlock's `ScheduleCommit` resolves the committed PDAs' owner program from
/// the CPI call stack — it must be invoked **via CPI from the owner program**
/// (this program). A top-level `ScheduleCommit` (e.g. the SDK's
/// `createCommitInstruction` sent directly) fails inside the ER with
/// "ScheduleCommit: parent program id: None / failed to find parent program id".
/// The protocol therefore needs its own commit-only entry point so off-chain
/// callers can flush ER OrderBook mutations (fills, header counters) to L1 for
/// L1 settlement, while keeping the book delegated for continued ER matching.
///
/// `undelegate_orderbook` already does commit+undelegate; this is the commit-only
/// half (keep the delegation), mirroring the MagicBlock reference program's
/// `process_schedulecommit_for_orderbook` (`ScheduleCommitType::Commit`).
///
/// Runs ON THE ER (the delegated account lives there).
///
/// Accounts:
///   [0] payer         (signer, writable) — schedules + pays for the commit
///   [1] order_book    (writable)         — the delegated OrderBook PDA to commit
///   [2] magic_context (writable)         — MagicContext111… (records scheduled commits)
///   [3] magic_program (read)             — Magic111… (the commit is CPI'd into it)
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [payer, order_book_acc, magic_context, magic_program, _remaining @ ..] = accounts else {
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
    let market_index_bytes = market_index.to_le_bytes();

    // Only ever commit THIS protocol's canonical OrderBook PDA.
    let (expected_pda, _bump) =
        pinocchio::pubkey::find_program_address(&[SEED_ORDERBOOK, &market_index_bytes], program_id);
    if order_book_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    // CPI the magic program's ScheduleCommit. Metas: [payer(ws), magic_context(w),
    // order_book(w)]. The magic program identifies the owner program (this program)
    // from the CPI caller, so no PDA signature is required (mirrors the reference
    // `invoke_schedule_commit`, which uses plain `invoke`).
    let account_metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable(magic_context.key()),
        AccountMeta::writable(order_book_acc.key()),
    ];
    let instruction = Instruction {
        program_id: &MAGIC_PROGRAM_ID,
        accounts: &account_metas,
        data: &SCHEDULE_COMMIT_DATA,
    };
    invoke(&instruction, &[payer, magic_context, order_book_acc])?;

    Ok(())
}
