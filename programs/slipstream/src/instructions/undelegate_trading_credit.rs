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

/// Hardcoded well-known MagicBlock addresses (mirrors commit_orderbook.rs /
/// commit_fill_log.rs, which pin these on their own magic-program CPI).
const MAGIC_PROGRAM_ID: Pubkey = [
    0x05, 0x45, 0xb4, 0x24, 0xb0, 0xda, 0x70, 0x95, 0xec, 0xb9, 0xd6, 0xde, 0xc3, 0x77, 0xd7, 0x28,
    0x91, 0xb6, 0xe7, 0x8e, 0x92, 0xea, 0x12, 0xd6, 0xdf, 0xbb, 0x3a, 0x40, 0x00, 0x00, 0x00, 0x00,
];
const MAGIC_CONTEXT_ID: Pubkey = [
    0x05, 0x45, 0xb4, 0x24, 0xc4, 0xa5, 0x28, 0xbf, 0x5f, 0xb4, 0x03, 0x2f, 0x44, 0x52, 0x82, 0x8e,
    0xbb, 0x38, 0xab, 0xc1, 0xd2, 0xdc, 0x97, 0xf7, 0x3f, 0x8b, 0x94, 0x54, 0x80, 0x00, 0x00, 0x00,
];

use crate::error::SlipstreamError;
use crate::state::{reconcile_credit, OrderBookView, TradingCredit, SEED_CREDIT, SEED_ORDERBOOK};

/// Instruction data: market_index: u16
///
/// A SINGLE `ScheduleCommitAndUndelegate` CPI to the magic program commits the ER
/// state and schedules the undelegation; the base-layer `undelegate` on the
/// delegation program is then performed by the validator, not by this instruction.
///
/// After this instruction, the TradingCredit is owned by the program again and the
/// user can `withdraw_trading_credit`. `committed`/`active_orders` are reconciled
/// against the (also ER-delegated) order book before the commit below: a maker
/// whose resting order was filled by someone else never gets an ER-side
/// reconcile of their own (that only happens as a side effect of the OWNER's
/// own place_order/cancel_order calls), so without this the committed L1 copy
/// could show a stale nonzero committed/active_orders forever — permanently
/// failing withdraw_trading_credit's `is_idle()` gate for an order that has
/// nothing left reserved.
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
        order_book_acc,
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
    let (ob_pda, _) = pinocchio::pubkey::find_program_address(
        &[SEED_ORDERBOOK, &market_index_bytes],
        program_id,
    );
    if order_book_acc.key() != &ob_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    {
        let ob_data = unsafe { order_book_acc.borrow_mut_data_unchecked() };
        let ob = OrderBookView::from_account_data(ob_data)?;
        let credit = TradingCredit::from_account_info_mut(trading_credit_acc)?;
        reconcile_credit(&ob, credit);
    }
    // Pin the CPI target and context so a caller cannot substitute a decoy program
    // that "succeeds" without actually undelegating anything.
    if magic_program.key() != &MAGIC_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if magic_context.key() != &MAGIC_CONTEXT_ID {
        return Err(SlipstreamError::InvalidPda.into());
    }

    // `magic_context` must be WRITABLE for ScheduleCommitAndUndelegate.
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
