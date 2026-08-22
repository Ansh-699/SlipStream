//! R3 — lossless fill ring (`S2-01`, `S2-X01`, `S4-03`, `S4-X01`).
//!
//! Two tests sit at the `OrderBookView` interface (where the defect lives) and
//! one drives `mirror_fills` through Mollusk, because the third defect only
//! shows up in the instruction: the drain must happen even when the call
//! appends nothing, or the live ring can never clear and matching stays halted
//! forever.
#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::state::*;

const IX_MIRROR_FILLS: u8 = 0x1F;

/// A deliberately tiny book: 2 order slots, 2 price levels/side, 4 fill events.
const SLOTS: u16 = 2;
const LEVELS: u16 = 2;
const FILLS: u16 = 4;

fn mollusk(program_id: &Pubkey) -> Mollusk {
    std::env::set_var(
        "SBF_OUT_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy"),
    );
    Mollusk::new(program_id, "slipstream")
}

fn fill(sequence: u64) -> FillEvent {
    let mut f = FillEvent::zeroed();
    f.sequence = sequence;
    f.price = 100_000_000;
    f.quantity = 100_000_000;
    f
}

/// Build a book whose ring already holds `stored` fills numbered 1..=stored.
fn book_bytes(market_index: u16, stored: u16) -> Vec<u8> {
    let size = OrderBookHeader::compute_account_size(SLOTS, LEVELS, FILLS);
    let mut data = vec![0u8; size];
    {
        let header: &mut OrderBookHeader =
            bytemuck::from_bytes_mut(&mut data[..OrderBookHeader::LEN]);
        header.discriminator = DISC_ORDER_BOOK;
        header.bump = 255;
        header.market_index = market_index;
        header.max_order_slots = SLOTS;
        header.max_price_levels_per_side = LEVELS;
        header.max_fill_events = FILLS;
    }
    {
        let mut view = OrderBookView::from_account_data(&mut data).unwrap();
        view.init_free_list();
        for s in 1..=stored as u64 {
            view.header.next_fill_sequence = s + 1;
            view.push_fill_event(fill(s)).unwrap();
        }
    }
    data
}

fn read_fill(data: &[u8], idx: usize) -> FillEvent {
    let base = OrderBookHeader::LEN
        + SLOTS as usize * OrderSlot::LEN
        + LEVELS as usize * PriceLevel::LEN * 2;
    let off = base + idx * FillEvent::LEN;
    *bytemuck::from_bytes(&data[off..off + FillEvent::LEN])
}

/// THE PRODUCER DEFECT. A ring that is full of unmirrored fills must refuse the
/// next push instead of silently destroying the oldest entry.
#[test]
fn test_place_order_refuses_to_overwrite_unmirrored_fill() {
    let mut data = book_bytes(0, FILLS); // ring is exactly full: sequences 1..=4
    let head_before = {
        let view = OrderBookView::from_account_data(&mut data).unwrap();
        assert_eq!(view.header.fill_event_count, FILLS);
        view.header.fill_event_head as usize
    };
    let oldest_before = read_fill(&data, head_before).sequence;
    assert_eq!(oldest_before, 1);

    let (is_err, head_after, count_after) = {
        let mut view = OrderBookView::from_account_data(&mut data).unwrap();
        let res = view.push_fill_event(fill(5));
        (
            res.is_err(),
            view.header.fill_event_head as usize,
            view.header.fill_event_count,
        )
    };

    assert!(
        is_err,
        "push_fill_event returned Ok on a full ring — the oldest unmirrored fill was destroyed"
    );
    assert_eq!(head_after, head_before, "head must not advance on a refused push");
    assert_eq!(count_after, FILLS, "count must not change on a refused push");
    assert_eq!(
        read_fill(&data, head_before).sequence,
        oldest_before,
        "the oldest surviving fill was overwritten"
    );
}

/// THE CONSUMER DEFECT. The ring's oldest surviving sequence is
/// `next_fill_sequence - fill_event_count`. When that is beyond
/// `last_mirrored + 1`, fills have been destroyed and the mirror must say so
/// instead of inheriting a silently-advanced cursor.
#[test]
fn test_mirror_fills_errors_on_sequence_gap() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let market_index: u16 = 0;
    let epoch: u32 = 1;

    // A wrapped ring: sequences 6..=9 survive, so oldest_surviving == 6, but the
    // log's cursor is at 1 — sequences 2..5 are gone.
    let mut data = book_bytes(market_index, FILLS);
    let base_idx = {
        let mut view = OrderBookView::from_account_data(&mut data).unwrap();
        view.header.next_fill_sequence = 10;
        view.header.fill_event_head as usize
    };
    {
        let base = OrderBookHeader::LEN
            + SLOTS as usize * OrderSlot::LEN
            + LEVELS as usize * PriceLevel::LEN * 2;
        for i in 0..FILLS as usize {
            let idx = (base_idx + i) % FILLS as usize;
            let off = base + idx * FillEvent::LEN;
            let f = fill(6 + i as u64);
            data[off..off + FillEvent::LEN].copy_from_slice(bytemuck::bytes_of(&f));
        }
    }

    let (ob_pk, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &market_index.to_le_bytes()], &program_id);
    let (fl_pk, _) = Pubkey::find_program_address(
        &[SEED_FILL_LOG, &market_index.to_le_bytes(), &epoch.to_le_bytes()],
        &program_id,
    );

    let mut log = vec![0u8; fill_log_account_size(FILL_LOG_CAPACITY)];
    {
        let h: &mut FillLogHeader = bytemuck::from_bytes_mut(&mut log[..FillLogHeader::LEN]);
        h.discriminator = DISC_FILL_LOG;
        h.market_index = market_index;
        h.epoch = epoch;
        h.capacity = FILL_LOG_CAPACITY;
        h.count = 0;
        h.head = 0;
        h.last_mirrored_sequence = 1; // non-virgin cursor: a real gap, not a fresh log
    }

    let accounts = vec![
        (
            ob_pk,
            Account { lamports: 10_000_000, data: data.clone(), owner: program_id, executable: false, rent_epoch: 0 },
        ),
        (
            fl_pk,
            Account { lamports: 10_000_000, data: log.clone(), owner: program_id, executable: false, rent_epoch: 0 },
        ),
    ];

    let mut ixd = vec![IX_MIRROR_FILLS];
    ixd.extend_from_slice(&market_index.to_le_bytes());
    ixd.extend_from_slice(&epoch.to_le_bytes());
    ixd.extend_from_slice(&0u16.to_le_bytes());

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(ob_pk, false),
            AccountMeta::new(fl_pk, false),
        ],
        data: ixd,
    };
    let res = m.process_instruction(&ix, &accounts);

    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "mirror_fills stepped over a sequence gap (oldest surviving 6, last_mirrored 1): {:?}",
        res.program_result
    );
    let after: &FillLogHeader =
        bytemuck::from_bytes(&res.resulting_accounts[1].1.data[..FillLogHeader::LEN]);
    assert_eq!(
        after.last_mirrored_sequence, 1,
        "the cursor must not advance across a gap"
    );
}

/// THE WEDGE. This is the case the spec's wording misses: the live ring is full
/// of fills that are ALREADY mirrored, so a mirror call appends nothing. If the
/// drain only covers "what this call appended", `mirror_fills` returns
/// `FillQueueEmpty` before draining, the ring stays full forever, and R3's halt
/// permanently wedges matching with no operator recovery.
///
/// The drain must therefore be defined over every entry with
/// `sequence <= last_mirrored_sequence`, not over this call's appends.
#[test]
fn test_mirror_fills_drains_already_mirrored_prefix_with_zero_appends() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let market_index: u16 = 0;
    let epoch: u32 = 1;

    // Ring is exactly full with sequences 1..=4, all of which are already mirrored.
    let data = book_bytes(market_index, FILLS);

    let (ob_pk, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &market_index.to_le_bytes()], &program_id);
    let (fl_pk, _) = Pubkey::find_program_address(
        &[SEED_FILL_LOG, &market_index.to_le_bytes(), &epoch.to_le_bytes()],
        &program_id,
    );

    let mut log = vec![0u8; fill_log_account_size(FILL_LOG_CAPACITY)];
    {
        let h: &mut FillLogHeader = bytemuck::from_bytes_mut(&mut log[..FillLogHeader::LEN]);
        h.discriminator = DISC_FILL_LOG;
        h.market_index = market_index;
        h.epoch = epoch;
        h.capacity = FILL_LOG_CAPACITY;
        h.last_mirrored_sequence = FILLS as u64; // everything in the ring is mirrored
    }

    let accounts = vec![
        (
            ob_pk,
            Account { lamports: 10_000_000, data, owner: program_id, executable: false, rent_epoch: 0 },
        ),
        (
            fl_pk,
            Account { lamports: 10_000_000, data: log, owner: program_id, executable: false, rent_epoch: 0 },
        ),
    ];

    let mut ixd = vec![IX_MIRROR_FILLS];
    ixd.extend_from_slice(&market_index.to_le_bytes());
    ixd.extend_from_slice(&epoch.to_le_bytes());
    ixd.extend_from_slice(&0u16.to_le_bytes());

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(ob_pk, false),
            AccountMeta::new(fl_pk, false),
        ],
        data: ixd,
    };
    let res = m.process_instruction(&ix, &accounts);

    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "mirror_fills must succeed and drain a fully-mirrored ring, otherwise R3's \
         halt wedges matching permanently: {:?}",
        res.program_result
    );

    let after: &OrderBookHeader =
        bytemuck::from_bytes(&res.resulting_accounts[0].1.data[..OrderBookHeader::LEN]);
    assert_eq!(
        after.fill_event_count, 0,
        "mirror_fills must drain every already-mirrored entry so the ring can accept new fills"
    );
}

/// EPOCH ROTATION. `last_mirrored_sequence` is per-FillLog and the keeper
/// rotates epochs routinely, so a fresh log re-mirrors the ring from sequence 0
/// by design (`keepers/src/fill-log-keeper.ts`). On any live book the ring's
/// oldest surviving sequence is far beyond `last_mirrored + 1 == 1`, so a gap
/// check WITHOUT a virgin-log exemption errors on every rotation, forever.
#[test]
fn test_mirror_fills_succeeds_on_virgin_log_after_rotation() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let market_index: u16 = 0;
    let epoch: u32 = 7; // a rotated-to epoch, hence a brand-new FillLog

    // The same wrapped ring the gap test uses: sequences 6..=9 survive, so
    // oldest_surviving == 6 while the fresh cursor is 0.
    let mut data = book_bytes(market_index, FILLS);
    let base_idx = {
        let mut view = OrderBookView::from_account_data(&mut data).unwrap();
        view.header.next_fill_sequence = 10;
        view.header.fill_event_head as usize
    };
    {
        let base = OrderBookHeader::LEN
            + SLOTS as usize * OrderSlot::LEN
            + LEVELS as usize * PriceLevel::LEN * 2;
        for i in 0..FILLS as usize {
            let idx = (base_idx + i) % FILLS as usize;
            let off = base + idx * FillEvent::LEN;
            let f = fill(6 + i as u64);
            data[off..off + FillEvent::LEN].copy_from_slice(bytemuck::bytes_of(&f));
        }
    }

    let (ob_pk, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &market_index.to_le_bytes()], &program_id);
    let (fl_pk, _) = Pubkey::find_program_address(
        &[SEED_FILL_LOG, &market_index.to_le_bytes(), &epoch.to_le_bytes()],
        &program_id,
    );

    let mut log = vec![0u8; fill_log_account_size(FILL_LOG_CAPACITY)];
    {
        let h: &mut FillLogHeader = bytemuck::from_bytes_mut(&mut log[..FillLogHeader::LEN]);
        h.discriminator = DISC_FILL_LOG;
        h.market_index = market_index;
        h.epoch = epoch;
        h.capacity = FILL_LOG_CAPACITY;
        h.count = 0; // virgin: nothing mirrored yet
        h.head = 0;
        h.last_mirrored_sequence = 0; // virgin cursor, NOT a gap
    }

    let accounts = vec![
        (
            ob_pk,
            Account { lamports: 10_000_000, data, owner: program_id, executable: false, rent_epoch: 0 },
        ),
        (
            fl_pk,
            Account { lamports: 10_000_000, data: log, owner: program_id, executable: false, rent_epoch: 0 },
        ),
    ];

    let mut ixd = vec![IX_MIRROR_FILLS];
    ixd.extend_from_slice(&market_index.to_le_bytes());
    ixd.extend_from_slice(&epoch.to_le_bytes());
    ixd.extend_from_slice(&0u16.to_le_bytes());

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(ob_pk, false),
            AccountMeta::new(fl_pk, false),
        ],
        data: ixd,
    };
    let res = m.process_instruction(&ix, &accounts);

    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "a virgin FillLog re-mirroring a wrapped ring after an epoch rotation must \
         succeed — the gap check needs a virgin-log exemption: {:?}",
        res.program_result
    );

    let after: &FillLogHeader =
        bytemuck::from_bytes(&res.resulting_accounts[1].1.data[..FillLogHeader::LEN]);
    assert_eq!(after.count, FILLS, "every surviving ring entry must be mirrored");
    assert_eq!(
        after.last_mirrored_sequence, 9,
        "the cursor must land on the highest sequence mirrored"
    );

    let ob_after: &OrderBookHeader =
        bytemuck::from_bytes(&res.resulting_accounts[0].1.data[..OrderBookHeader::LEN]);
    assert_eq!(
        ob_after.fill_event_count, 0,
        "the ring must also drain what this call mirrored"
    );
}
