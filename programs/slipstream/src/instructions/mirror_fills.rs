use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::{
    FillEvent, FillLogView, OrderBookHeader, OrderSlot, PriceLevel,
    DISC_ORDER_BOOK, SEED_FILL_LOG, SEED_ORDERBOOK,
};

/// mirror_fills (disc 0x1F): copy newly-produced OrderBook fills into the small
/// FillLog. Runs ON THE ER, where BOTH the OrderBook and the FillLog are
/// delegated — so the OrderBook is read READ-ONLY and the FillLog is appended to.
///
/// This is what lets settlement avoid ever committing the 612 KB OrderBook: the
/// keeper periodically mirrors fills into the tiny FillLog, commits ONLY the
/// FillLog to L1, and `settle_trades` reads the committed FillLog. `place_order`
/// is never touched (no hot-path risk).
///
/// Permissionless: the only effect is copying fills the matching engine already
/// produced into a program-owned log keyed by sequence; a caller cannot fabricate
/// fills (it can only mirror what the OrderBook already contains).
///
/// Accounts:
///   [0] order_book (R, delegated)  — source fill ring
///   [1] fill_log   (W, delegated)  — destination ring
///
/// Instruction data:
///   market_index: u16
///   epoch:        u32
///   max_fills:    u16   (cap on fills appended this call; 0 => no cap)
const IX_DATA_LEN: usize = 2 + 4 + 2;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [order_book_acc, fill_log_acc, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index = u16::from_le_bytes([data[0], data[1]]);
    let epoch = u32::from_le_bytes([data[2], data[3], data[4], data[5]]);
    let max_fills = u16::from_le_bytes([data[6], data[7]]);
    let market_index_bytes = market_index.to_le_bytes();
    let epoch_bytes = epoch.to_le_bytes();

    // Validate both PDAs belong to this protocol.
    let (ob_pda, _ob_bump) =
        pinocchio::pubkey::find_program_address(&[SEED_ORDERBOOK, &market_index_bytes], program_id);
    if order_book_acc.key() != &ob_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    let (fl_pda, _fl_bump) = pinocchio::pubkey::find_program_address(
        &[SEED_FILL_LOG, &market_index_bytes, &epoch_bytes],
        program_id,
    );
    if fill_log_acc.key() != &fl_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    // --- Read the OrderBook fill ring READ-ONLY ---
    let ob_data = unsafe { order_book_acc.borrow_data_unchecked() };
    if ob_data.len() < OrderBookHeader::LEN || ob_data[0] != DISC_ORDER_BOOK {
        return Err(ProgramError::InvalidAccountData);
    }
    let (head, count, max_ring, fills_base) = {
        let header: &OrderBookHeader = bytemuck::from_bytes(&ob_data[..OrderBookHeader::LEN]);
        let max_slots = header.max_order_slots as usize;
        let max_levels = header.max_price_levels_per_side as usize;
        let fills_base = OrderBookHeader::LEN
            + max_slots * OrderSlot::LEN
            + max_levels * PriceLevel::LEN * 2;
        (
            header.fill_event_head as usize,
            header.fill_event_count as usize,
            header.max_fill_events as usize,
            fills_base,
        )
    };
    if max_ring == 0 {
        return Err(ProgramError::InvalidAccountData);
    }
    if fills_base + max_ring * FillEvent::LEN > ob_data.len() {
        return Err(ProgramError::InvalidAccountData);
    }

    // The FillLog and OrderBook are DISTINCT accounts, so borrowing the book
    // read-only and the log mutably at the same time is sound. Stream new fills
    // (sequence > last_mirrored) directly into the log ONE AT A TIME — no large
    // stack buffer (a [FillEvent; 80] array overflows the 4 KB BPF stack frame).
    let fl_data = unsafe { fill_log_acc.borrow_mut_data_unchecked() };
    let mut log = FillLogView::from_account_data(fl_data)?;
    let last_mirrored = log.header.last_mirrored_sequence;

    let cap_this_call: usize = if max_fills == 0 {
        usize::MAX
    } else {
        max_fills as usize
    };

    let mut appended = 0usize;
    let mut new_max_seq = last_mirrored;
    let mut i = 0usize;
    while i < count && appended < cap_this_call {
        let idx = (head + i) % max_ring;
        i += 1;
        let off = fills_base + idx * FillEvent::LEN;
        let fill: FillEvent = *bytemuck::from_bytes(&ob_data[off..off + FillEvent::LEN]);
        if fill.sequence <= last_mirrored {
            continue;
        }
        log.push(fill);
        appended += 1;
        if fill.sequence > new_max_seq {
            new_max_seq = fill.sequence;
        }
    }

    // Nothing new to mirror — idempotent no-op signal.
    if appended == 0 {
        return Err(SlipstreamError::FillQueueEmpty.into());
    }

    log.header.last_mirrored_sequence = new_max_seq;

    Ok(())
}
