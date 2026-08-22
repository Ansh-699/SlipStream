use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::{FillLogView, OrderBookView, FILL_LOG_CAPACITY, SEED_FILL_LOG, SEED_ORDERBOOK};

/// mirror_fills (disc 0x1F): copy newly-produced OrderBook fills into the small
/// FillLog. Runs ON THE ER, where BOTH the OrderBook and the FillLog are
/// delegated — so the OrderBook is WRITABLE here and the FillLog is appended to.
///
/// It has three jobs, and the third is what keeps the market alive now that
/// `push_fill_event` refuses instead of overwriting:
///   1. append ring entries with `sequence > last_mirrored_sequence` to the log;
///   2. refuse when the ring's oldest surviving sequence is beyond
///      `last_mirrored + 1`, i.e. fills were destroyed before this fix landed;
///   3. DRAIN the ring of every entry the log has already mirrored, so
///      `place_order` can push again.
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
///   [0] order_book (W, delegated)  — source fill ring, drained of mirrored
///                                    entries. Passed read-only, the drain is
///                                    skipped and the ring never clears.
///   [1] fill_log   (W, delegated)  — destination ring
///
/// Instruction data:
///   market_index: u16
///   epoch:        u32
///   max_fills:    u16   (cap on fills appended this call; 0 => fill remaining
///                        ring space. Never exceeds the ring's free capacity
///                        regardless of what is requested.)
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

    // --- The OrderBook fill ring, MUTABLE: the drain below advances its head ---
    // A caller may still pass the book read-only (the pre-fix client did); the
    // drain is skipped in that case rather than modifying an account the
    // runtime would reject the write on.
    let ob_writable = order_book_acc.is_writable();
    let ob_data = unsafe { order_book_acc.borrow_mut_data_unchecked() };
    let mut ob = OrderBookView::from_account_data(ob_data)?;
    let head = ob.header.fill_event_head as usize;
    let count = ob.header.fill_event_count as usize;
    let max_ring = ob.header.max_fill_events as usize;
    if max_ring == 0 {
        return Err(ProgramError::InvalidAccountData);
    }

    // The FillLog and OrderBook are DISTINCT accounts, so borrowing both
    // mutably at the same time is sound. Stream new fills
    // (sequence > last_mirrored) directly into the log ONE AT A TIME — no large
    // stack buffer (a [FillEvent; 80] array overflows the 4 KB BPF stack frame).
    let fl_data = unsafe { fill_log_acc.borrow_mut_data_unchecked() };
    let mut log = FillLogView::from_account_data(fl_data)?;
    let last_mirrored = log.header.last_mirrored_sequence;

    // A gap means fills were destroyed (the pre-fix ring overwrote them) and
    // settlement would silently skip them. Refuse instead of inheriting a
    // silently-advanced cursor.
    //
    // EXCEPT on a virgin log: `last_mirrored_sequence` is per-FillLog and the
    // keeper rotates epochs routinely, so a fresh log re-mirrors the ring from
    // sequence 0 by design (keepers/src/fill-log-keeper.ts). An unconditional
    // check would error on every rotation, forever.
    //
    // `saturating_add`: `last_mirrored == u64::MAX` needs 2^64 fills, and
    // saturating there leaves the check inert rather than firing spuriously.
    let virgin = log.header.count == 0 && last_mirrored == 0;
    if !virgin && ob.oldest_surviving_sequence() > last_mirrored.saturating_add(1) {
        return Err(SlipstreamError::InvalidFillSequence.into());
    }

    // Never request more than the ring could ever hold: scanning the
    // OrderBook's (up to 4096-slot) ring past what could ever be stored just
    // burns compute, and a caller-supplied 0 must not be read as "unbounded".
    // `log.push` below is the authoritative fullness check either way.
    let cap_this_call: usize = if max_fills == 0 {
        FILL_LOG_CAPACITY as usize
    } else {
        (max_fills as usize).min(FILL_LOG_CAPACITY as usize)
    };

    let mut appended = 0usize;
    let mut new_max_seq = last_mirrored;
    let mut ring_full = false;
    let mut i = 0usize;
    while i < count && appended < cap_this_call {
        let idx = (head + i) % max_ring;
        i += 1;
        let fill = ob.fill_events[idx];
        if fill.sequence <= last_mirrored {
            continue;
        }
        // The ring is lossless: it refuses once full instead of overwriting an
        // unsettled entry. Stop here WITHOUT advancing the cursor past this
        // fill, so it is retried (not silently destroyed) once the keeper
        // settles this epoch's log and rotates to a fresh one.
        if !log.push(fill) {
            ring_full = true;
            break;
        }
        appended += 1;
        if fill.sequence > new_max_seq {
            new_max_seq = fill.sequence;
        }
    }

    // Drain BEFORE the "nothing appended" early return, and over every entry
    // the log has already mirrored rather than over this call's appends. The
    // live ring is full of fills that are ALREADY mirrored, so the call that
    // must clear it is precisely a call that appends nothing — draining only
    // what was appended would leave the ring full and matching halted forever.
    let drained = if ob_writable {
        ob.drain_through_sequence(new_max_seq)
    } else {
        0
    };

    // Nothing appended and nothing drained: either there is nothing new to
    // mirror, or the log is already full and cannot accept anything —
    // distinguish the two so the keeper knows to settle+rotate rather than
    // treating this as a no-op.
    if appended == 0 && drained == 0 {
        return Err(if ring_full {
            SlipstreamError::FillQueueFull.into()
        } else {
            SlipstreamError::FillQueueEmpty.into()
        });
    }

    log.header.last_mirrored_sequence = new_max_seq;

    Ok(())
}
