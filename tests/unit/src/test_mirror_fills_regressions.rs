//! Mollusk regression tests for the FillLog overrun fix.
//!
//! Before this fix, `FillLogView::push` silently overwrote the oldest ring
//! entry once `count == capacity` (fill_log.rs), and `mirror_fills` advanced
//! `last_mirrored_sequence` past whatever it pushed regardless. Because
//! nothing ever drains the ring (`settle_from_log` reads it read-only and
//! tracks progress on `Market.last_settled_sequence` instead), any fill mirror
//! that arrived while the ring was already full permanently destroyed an
//! older, possibly still-unsettled fill with zero on-chain signal.
#![cfg(test)]

use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::state::*;

fn mollusk(program_id: &Pubkey) -> Mollusk {
    std::env::set_var(
        "SBF_OUT_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy"),
    );
    Mollusk::new(program_id, "slipstream")
}

fn program_account(program_id: &Pubkey, data: &[u8]) -> Account {
    Account {
        lamports: 10_000_000,
        data: data.to_vec(),
        owner: *program_id,
        executable: false,
        rent_epoch: 0,
    }
}

/// An OrderBook whose committed fill ring holds exactly `fills.len()` fills,
/// one order slot / price level (unused by mirror_fills, kept minimal).
fn order_book_with_fills(fills: &[FillEvent]) -> Vec<u8> {
    let max_slots = 1u16;
    let max_levels = 1u16;
    let max_fill_events = fills.len() as u16;
    let size = OrderBookHeader::compute_account_size(max_slots, max_levels, max_fill_events);
    let mut data = vec![0u8; size];
    {
        let header: &mut OrderBookHeader = bytemuck::from_bytes_mut(&mut data[..OrderBookHeader::LEN]);
        header.discriminator = DISC_ORDER_BOOK;
        header.bump = 1;
        header.market_index = 0;
        header.max_order_slots = max_slots;
        header.max_price_levels_per_side = max_levels;
        header.max_fill_events = max_fill_events;
        header.free_slot_count = max_slots;
        header.next_order_id = 1;
        header.next_fill_sequence = fills.len() as u64 + 1;
        header.fill_event_head = 0;
        header.fill_event_tail = max_fill_events;
        header.fill_event_count = max_fill_events;
    }
    let fills_base =
        OrderBookHeader::LEN + (max_slots as usize) * OrderSlot::LEN + (max_levels as usize) * PriceLevel::LEN * 2;
    for (i, fill) in fills.iter().enumerate() {
        let off = fills_base + i * FillEvent::LEN;
        data[off..off + FillEvent::LEN].copy_from_slice(bytemuck::bytes_of(fill));
    }
    data
}

fn fill_event(sequence: u64, maker: &Pubkey) -> FillEvent {
    FillEvent {
        sequence,
        maker: maker.to_bytes(),
        taker: Pubkey::new_unique().to_bytes(),
        price: 150_000_000,
        quantity: 100_000_000,
        filled_margin: 500_000,
        taker_fee_bps_snapshot: 10,
        maker_rebate_bps_snapshot: 5,
        maker_side: SIDE_ASK,
        _pad: [0u8; 3],
    }
}

/// A FillLog account with the given capacity/count/head/last_mirrored preset —
/// `entries` fills the ring's live slots (indices 0..entries.len()).
fn fill_log_account(
    program_id: &Pubkey,
    capacity: u16,
    entries: &[FillEvent],
    last_mirrored_sequence: u64,
) -> Account {
    let size = fill_log_account_size(capacity);
    let mut data = vec![0u8; size];
    {
        let header: &mut FillLogHeader = bytemuck::from_bytes_mut(&mut data[..FillLogHeader::LEN]);
        header.discriminator = DISC_FILL_LOG;
        header.bump = 1;
        header.market_index = 0;
        header.epoch = 0;
        header.capacity = capacity;
        header.count = entries.len() as u16;
        header.head = 0;
        header.last_mirrored_sequence = last_mirrored_sequence;
    }
    for (i, fill) in entries.iter().enumerate() {
        let off = FillLogHeader::LEN + i * FillEvent::LEN;
        data[off..off + FillEvent::LEN].copy_from_slice(bytemuck::bytes_of(fill));
    }
    program_account(program_id, &data)
}

fn mirror_fills_ix(
    program_id: &Pubkey,
    order_book: Pubkey,
    fill_log: Pubkey,
    max_fills: u16,
) -> Instruction {
    let mut data = vec![0x1Fu8];
    data.extend_from_slice(&0u16.to_le_bytes()); // market_index
    data.extend_from_slice(&0u32.to_le_bytes()); // epoch
    data.extend_from_slice(&max_fills.to_le_bytes());
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(order_book, false),
            AccountMeta::new(fill_log, false),
        ],
        data,
    }
}

/// A ring with room for only 2 more entries, offered 3 new fills, must stop
/// after 2 and leave the 3rd's sequence un-mirrored — not overwrite an entry
/// it just wrote to make room.
#[test]
fn test_mirror_fills_stops_at_capacity_without_advancing_past_dropped_fill() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let maker_a = Pubkey::new_unique();
    let maker_b = Pubkey::new_unique();
    let maker_c = Pubkey::new_unique();

    let (order_book, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let (fill_log_pk, _) =
        Pubkey::find_program_address(&[SEED_FILL_LOG, &0u16.to_le_bytes(), &0u32.to_le_bytes()], &program_id);

    let ob_data = order_book_with_fills(&[
        fill_event(1, &maker_a),
        fill_event(2, &maker_b),
        fill_event(3, &maker_c),
    ]);
    let fill_log_acc = fill_log_account(&program_id, 2, &[], 0);

    let accounts = vec![
        (order_book, program_account(&program_id, &ob_data)),
        (fill_log_pk, fill_log_acc),
    ];

    let ix = mirror_fills_ix(&program_id, order_book, fill_log_pk, 0);
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "partial mirror (2 of 3 fit) must still succeed: {:?}",
        res.program_result
    );

    let log_data = &res.resulting_accounts[1].1.data;
    let header: &FillLogHeader = bytemuck::from_bytes(&log_data[..FillLogHeader::LEN]);
    assert_eq!(header.count, 2, "ring must hold exactly the 2 that fit");
    assert_eq!(
        header.last_mirrored_sequence, 2,
        "cursor must NOT advance past fill 3, which was never stored"
    );

    let entry0: &FillEvent = bytemuck::from_bytes(&log_data[FillLogHeader::LEN..FillLogHeader::LEN + FillEvent::LEN]);
    assert_eq!(entry0.sequence, 1, "fill 1 must still be present, not evicted");
}

/// Once the ring is genuinely full and a new fill is waiting, mirror_fills
/// must reject with FillQueueFull instead of silently evicting the oldest
/// entry — proving the previously-stranded fill (sequence 1) is preserved.
#[test]
fn test_mirror_fills_rejects_instead_of_evicting_when_ring_is_full() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let maker_a = Pubkey::new_unique();
    let maker_b = Pubkey::new_unique();
    let maker_c = Pubkey::new_unique();

    let (order_book, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let (fill_log_pk, _) =
        Pubkey::find_program_address(&[SEED_FILL_LOG, &0u16.to_le_bytes(), &0u32.to_le_bytes()], &program_id);

    // OrderBook has ONE new fill (sequence 3) beyond what's already mirrored.
    let ob_data = order_book_with_fills(&[fill_event(3, &maker_c)]);
    // FillLog is already full (capacity 2, count 2) with fills 1 and 2, neither
    // of which settle_from_log has necessarily processed yet.
    let fill_log_acc = fill_log_account(&program_id, 2, &[fill_event(1, &maker_a), fill_event(2, &maker_b)], 2);

    let accounts = vec![
        (order_book, program_account(&program_id, &ob_data)),
        (fill_log_pk, fill_log_acc),
    ];

    let ix = mirror_fills_ix(&program_id, order_book, fill_log_pk, 0);
    let res = m.process_instruction(&ix, &accounts);

    let expected = solana_program_error::ProgramError::Custom(
        slipstream::error::SlipstreamError::FillQueueFull as u32,
    );
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(expected),
        "a full ring with pending work must reject as FillQueueFull, not silently evict: {:?}",
        res.program_result
    );
}
