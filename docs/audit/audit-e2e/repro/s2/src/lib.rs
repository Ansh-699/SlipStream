//! Scratch audit reproductions for run `audit-e2e`, slice S2 (matching engine
//! and order book). This crate is NOT part of the product workspace and is
//! never run by `cargo test --workspace`.
//!
//! Run with:
//!   CARGO_TARGET_DIR=/tmp/s2-repro cargo test --manifest-path \
//!     docs/audit/audit-e2e/repro/s2/Cargo.toml -- --nocapture

#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::state::*;

const NOW: i64 = 1_700_000_000;
const PRICE_SCALE: u64 = 1_000_000;
const IX_PLACE_ORDER: u8 = 0x10;

fn mollusk(program_id: &Pubkey) -> Mollusk {
    std::env::set_var(
        "SBF_OUT_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../../target/deploy"),
    );
    let mut m = Mollusk::new(program_id, "slipstream");
    m.sysvars.clock.unix_timestamp = NOW;
    m
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

fn market_account(program_id: &Pubkey, market_index: u16) -> (Pubkey, Account) {
    let (pk, bump) =
        Pubkey::find_program_address(&[SEED_MARKET, &market_index.to_le_bytes()], program_id);
    let mut m = Market::zeroed();
    m.discriminator = DISC_MARKET;
    m.bump = bump;
    m.market_index = market_index;
    m.max_leverage = 20;
    m.taker_fee_bps = 6;
    m.maker_rebate_bps = 1;
    m.tick_size = 1_000;
    m.lot_size = 100_000_000; // 0.1 SOL, as deployed
    m.last_mark_price = 150 * PRICE_SCALE;
    (pk, program_account(program_id, bytemuck::bytes_of(&m)))
}

fn global_state_account(program_id: &Pubkey) -> (Pubkey, Account) {
    let (pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    let mut g = GlobalState::zeroed();
    g.discriminator = DISC_GLOBAL_STATE;
    (pk, program_account(program_id, bytemuck::bytes_of(&g)))
}

fn credit_account(program_id: &Pubkey, owner: &Pubkey, credit: u64, committed: u64, active: u16) -> Account {
    let mut c = TradingCredit::zeroed();
    c.discriminator = DISC_TRADING_CREDIT;
    c.owner = owner.to_bytes();
    c.market_index = 0;
    c.credit = credit;
    c.committed = committed;
    c.active_orders = active;
    program_account(program_id, bytemuck::bytes_of(&c))
}

fn order_book_data(market_index: u16, max_slots: u16, max_levels: u16, max_fills: u16) -> Vec<u8> {
    let size = OrderBookHeader::compute_account_size(max_slots, max_levels, max_fills);
    let mut data = vec![0u8; size];
    let header: &mut OrderBookHeader = bytemuck::from_bytes_mut(&mut data[..OrderBookHeader::LEN]);
    header.discriminator = DISC_ORDER_BOOK;
    header.bump = 1;
    header.market_index = market_index;
    header.orders_per_user = DEFAULT_ORDERS_PER_USER;
    header.max_order_slots = max_slots;
    header.max_price_levels_per_side = max_levels;
    header.max_fill_events = max_fills;
    header.next_order_id = 2;
    header.next_fill_sequence = 1;
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();
    ob.init_free_list();
    data
}

#[allow(clippy::too_many_arguments)]
fn place_order_ix(
    program_id: &Pubkey,
    market: Pubkey,
    order_book: Pubkey,
    credit: Pubkey,
    signer: Pubkey,
    global_state: Pubkey,
    side: u8,
    order_type: u8,
    price: u64,
    size: u64,
    expiry_ts: i64,
) -> Instruction {
    let mut data = vec![IX_PLACE_ORDER];
    data.push(side);
    data.push(order_type);
    data.extend_from_slice(&price.to_le_bytes());
    data.extend_from_slice(&size.to_le_bytes());
    data.extend_from_slice(&expiry_ts.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes()); // max_slippage_bps
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(market, false),
            AccountMeta::new(order_book, false),
            AccountMeta::new(credit, false),
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new_readonly(global_state, false),
        ],
        data,
    }
}

// ---------------------------------------------------------------------------
// S2-01 · the fill-event ring silently overwrites entries nothing has mirrored
// ---------------------------------------------------------------------------
//
// `OrderBookView::push_fill_event` (programs/slipstream/src/state/order_book.rs:206)
// overwrites the oldest entry when the ring is at capacity and returns `Ok(())`.
// Nothing in the header records that an entry was destroyed: `fill_event_count`
// is pinned at `max_fill_events` and `next_fill_sequence` keeps climbing, so a
// consumer that resumes from a mirrored-sequence cursor cannot tell a dropped
// fill from one it has already seen.
#[test]
fn s2_01_fill_ring_overwrites_without_signalling() {
    let mut data = order_book_data(0, 4, 2, 4); // capacity 4
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    let mk = |seq: u64| FillEvent {
        sequence: seq,
        maker: [1u8; 32],
        taker: [2u8; 32],
        price: 150 * PRICE_SCALE,
        quantity: 100_000_000,
        filled_margin: 750_000,
        taker_fee_bps_snapshot: 6,
        maker_rebate_bps_snapshot: 1,
        maker_side: SIDE_BID,
        _pad: [0u8; 3],
    };

    for seq in 1..=4u64 {
        assert!(ob.push_fill_event(mk(seq)).is_ok());
    }
    assert_eq!(ob.header.fill_event_count, 4);
    let ring_before: Vec<u64> = ob.fill_events.iter().map(|f| f.sequence).collect();
    println!("ring at capacity      : {ring_before:?} count={} head={} tail={}",
        ob.header.fill_event_count, ob.header.fill_event_head, ob.header.fill_event_tail);

    // Two more fills arrive before anything mirrored sequences 1 and 2.
    for seq in 5..=6u64 {
        let r = ob.push_fill_event(mk(seq));
        assert!(r.is_ok(), "push returns Ok even though it destroyed a fill: {r:?}");
    }

    let ring_after: Vec<u64> = ob.fill_events.iter().map(|f| f.sequence).collect();
    println!("after two more pushes : {ring_after:?} count={} head={} tail={}",
        ob.header.fill_event_count, ob.header.fill_event_head, ob.header.fill_event_tail);

    // Sequences 1 and 2 are gone from the account. Nothing errored, and the
    // header carries no drop counter and no "oldest surviving sequence".
    assert!(!ring_after.contains(&1), "sequence 1 survived unexpectedly");
    assert!(!ring_after.contains(&2), "sequence 2 survived unexpectedly");
    assert_eq!(ob.header.fill_event_count, 4, "count is pinned; it does not reveal the loss");
    assert_eq!(ob.header.fill_event_head, ob.header.fill_event_tail);
    println!(
        "LOST: sequences 1,2 are unrecoverable; header exposes only count={} head={} tail={}",
        ob.header.fill_event_count, ob.header.fill_event_head, ob.header.fill_event_tail
    );
}

// ---------------------------------------------------------------------------
// S2-02 · an order past its own expiry_ts is still matched
// ---------------------------------------------------------------------------
//
// The matching loop in place_order.rs never reads `OrderSlot::expiry_ts`; the
// only on-chain enforcement is the permissionless cancel path in
// cancel_order.rs:88, which requires someone to send a transaction.
#[test]
fn s2_02_expired_resting_order_is_still_matched() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);

    let maker = Pubkey::new_unique();
    let taker = Pubkey::new_unique();
    let (market_pk, market_acc) = market_account(&program_id, 0);
    let (global_pk, global_acc) = global_state_account(&program_id);
    let (order_book_pk, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let taker_credit_pk = Pubkey::new_unique();

    let price = 150 * PRICE_SCALE;
    let size = 100_000_000u64; // one lot
    let margin = 750_000u64; // notional 15_000_000 / leverage 20

    // A resting ASK whose expiry_ts passed an hour ago.
    let expired_at = NOW - 3600;
    let mut ob_data = order_book_data(0, 8, 4, 8);
    {
        let mut ob = OrderBookView::from_account_data(&mut ob_data).unwrap();
        let slot = ob.alloc_slot().unwrap();
        ob.order_slots[slot as usize].init(
            1, maker.to_bytes(), SIDE_ASK, ORDER_TYPE_LIMIT, price, size, expired_at, margin,
        );
        ob.insert_ask_level(price, slot).unwrap();
        assert_eq!(ob.header.active_order_count, 1);
    }

    let accounts = vec![
        (market_pk, market_acc),
        (order_book_pk, program_account(&program_id, &ob_data)),
        (taker_credit_pk, credit_account(&program_id, &taker, 10_000_000, 0, 0)),
        (taker, Account::default()),
        (global_pk, global_acc),
    ];

    // Taker crosses the expired ask with a plain LIMIT buy at the same price.
    let ix = place_order_ix(
        &program_id, market_pk, order_book_pk, taker_credit_pk, taker, global_pk,
        SIDE_BID, ORDER_TYPE_LIMIT, price, size, 0,
    );
    let res = m.process_instruction(&ix, &accounts);
    println!("place_order against an order expired at {expired_at} (clock {NOW}): {:?}", res.program_result);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "expected the engine to match the expired order: {:?}",
        res.program_result
    );

    let mut after = res
        .resulting_accounts
        .iter()
        .find(|(k, _)| *k == order_book_pk)
        .unwrap()
        .1
        .data
        .clone();
    let ob = OrderBookView::from_account_data(&mut after).unwrap();
    println!(
        "after: fill_event_count={} ask_level_count={} active_order_count={} fill.qty={} fill.price={}",
        ob.header.fill_event_count,
        ob.header.ask_level_count,
        ob.header.active_order_count,
        ob.fill_events[0].quantity,
        ob.fill_events[0].price,
    );
    assert_eq!(ob.header.fill_event_count, 1, "the expired order produced a real fill");
    assert_eq!(ob.fill_events[0].quantity, size);
    assert_eq!(ob.fill_events[0].maker, maker.to_bytes());
    assert_eq!(ob.header.ask_level_count, 0, "the expired ask was fully consumed");
}

// ---------------------------------------------------------------------------
// S2-03 · `taker_margin == filled_margin` is asserted, never enforced
// ---------------------------------------------------------------------------
//
// place_order.rs:423-428 debits the taker `compute_initial_margin(compute_notional(
// fill_qty, level_price), leverage)` while stamping the maker-derived
// `filled_margin` on the FillEvent; settle_trades.rs:223 then credits the
// TAKER's Position.collateral with that same `filled_margin`
// ("same-leverage MVP: taker_margin == maker_filled_margin"). The two are
// computed by different formulas and are equal only when every division
// involved happens to be exact.
#[test]
fn s2_03_taker_debit_can_differ_from_credited_filled_margin() {
    const BASE_SCALE: u128 = 1_000_000_000;
    let notional = |size: u64, price: u64| -> u64 {
        ((size as u128 * price as u128) / BASE_SCALE) as u64
    };
    let initial_margin = |notional: u64, lev: u8| -> u64 { notional / lev as u64 };
    // OrderSlot::drain_margin_for_fill, order_slot.rs:94-105
    let drain = |margin_reserved: u64, remaining: u64, qty: u64| -> u64 {
        if margin_reserved == 0 { return 0; }
        (((margin_reserved as u128) * (qty as u128)) / (remaining as u128)) as u64
    };

    // A market whose leverage does not divide the per-lot notional exactly.
    // (The DEPLOYED market uses max_leverage = 20, and with tick_size = 1_000 /
    // lot_size = 1e8 every notional is a multiple of 100, so 100/20 = 5 is exact
    // and the two formulas coincide. initialize_market accepts any max_leverage
    // in 1..=255 — see initialize_market.rs:85 — so this parameter set is one
    // instruction away.)
    let lev: u8 = 3;
    let price: u64 = 149_000_000; // $149.00, tick-aligned
    let lot: u64 = 100_000_000;

    // Maker rests 3 lots.
    let rest_size = 3 * lot;
    let mut margin_reserved = initial_margin(notional(rest_size, price), lev);
    let mut remaining = rest_size;
    let total_maker_margin = margin_reserved;

    // Two takers each sweep one lot, a third sweeps the last.
    let mut taker_debits: u64 = 0;
    let mut credited_to_takers: u64 = 0;
    for _ in 0..3 {
        let qty = lot;
        let filled_margin = drain(margin_reserved, remaining, qty);
        margin_reserved -= filled_margin;
        remaining -= qty;
        // ER side: what place_order actually subtracts from TradingCredit.credit.
        let taker_debit = initial_margin(notional(qty, price), lev);
        taker_debits += taker_debit;
        // L1 side: what settle_trades credits to the taker's Position.collateral.
        credited_to_takers += filled_margin;
        println!("fill qty={qty}: taker debited {taker_debit}, taker credited {filled_margin}");
    }

    println!(
        "maker margin drained  : {total_maker_margin} (credited to maker positions: {})",
        total_maker_margin - margin_reserved
    );
    println!("taker debited (ER)    : {taker_debits}");
    println!("taker credited (L1)   : {credited_to_takers}");
    println!("delta minted from air : {}", credited_to_takers as i128 - taker_debits as i128);
    assert_ne!(
        taker_debits, credited_to_takers,
        "with leverage {lev} the two formulas disagree"
    );
}

// ---------------------------------------------------------------------------
// Negative results: structural invariants of the book under a scripted
// place/cancel/fill sequence driven through the REAL compiled program.
// ---------------------------------------------------------------------------

/// Every structural invariant S2 owns, checked against a raw account buffer.
fn assert_book_invariants(data: &mut [u8], label: &str) {
    let ob = OrderBookView::from_account_data(data).unwrap();
    let max = ob.header.max_order_slots as usize;

    // free list: walk it, no cycle, no out-of-range, length == free_slot_count
    let mut seen = std::collections::HashSet::new();
    let mut cur = ob.header.free_list_head;
    let mut n: usize = 0;
    while cur != SENTINEL {
        assert!((cur as usize) < max, "{label}: free-list index {cur} out of range");
        assert!(seen.insert(cur), "{label}: free-list cycle at {cur}");
        n += 1;
        cur = ob.free_list[cur as usize];
        assert!(n <= max, "{label}: free list longer than the pool");
    }
    assert_eq!(n, ob.header.free_slot_count as usize, "{label}: free_slot_count != walk length");

    // active slots
    let active: Vec<u16> = (0..max)
        .filter(|i| ob.order_slots[*i].is_active())
        .map(|i| i as u16)
        .collect();
    assert_eq!(active.len(), ob.header.active_order_count as usize, "{label}: active_order_count wrong");
    for a in &active {
        assert!(!seen.contains(a), "{label}: slot {a} is both active and on the free list");
    }
    assert_eq!(active.len() + n, max, "{label}: slots leaked (active {} + free {n} != {max})", active.len());

    // levels: sortedness, and the FIFO under each level matches order_count
    let check_side = |levels: &[PriceLevel], count: usize, desc: bool, side_name: &str| {
        let mut counted = 0usize;
        for i in 0..count {
            let l = &levels[i];
            assert!(l.price != 0 && l.order_count > 0, "{label}: {side_name} level {i} inactive inside count");
            if i + 1 < count {
                let nxt = levels[i + 1].price;
                if desc {
                    assert!(l.price > nxt, "{label}: {side_name} not strictly descending at {i}");
                } else {
                    assert!(l.price < nxt, "{label}: {side_name} not strictly ascending at {i}");
                }
            }
            // walk the intrusive FIFO
            let mut walk = 0u16;
            let mut cur = l.head_slot;
            let mut prev = SENTINEL;
            while cur != SENTINEL {
                assert!((cur as usize) < max, "{label}: {side_name} level {i} slot {cur} out of range");
                let s = &ob.order_slots[cur as usize];
                assert!(s.is_active(), "{label}: {side_name} level {i} links freed slot {cur}");
                assert_eq!(s.price, l.price, "{label}: {side_name} level {i} holds a slot at the wrong price");
                assert_eq!(s.prev_at_level, prev, "{label}: {side_name} level {i} prev pointer broken at {cur}");
                prev = cur;
                cur = s.next_at_level;
                walk += 1;
                assert!(walk <= l.order_count + 1, "{label}: {side_name} level {i} FIFO longer than order_count");
            }
            assert_eq!(walk, l.order_count, "{label}: {side_name} level {i} order_count != FIFO length");
            assert_eq!(prev, l.tail_slot, "{label}: {side_name} level {i} tail_slot wrong");
            counted += walk as usize;
        }
        counted
    };
    let bids = check_side(ob.bid_levels, ob.header.bid_level_count as usize, true, "bid");
    let asks = check_side(ob.ask_levels, ob.header.ask_level_count as usize, false, "ask");
    assert_eq!(bids + asks, active.len(), "{label}: active slots not all reachable from a level");
}

#[test]
fn s2_negative_book_invariants_hold_under_place_cancel_fill() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);

    let alice = Pubkey::new_unique();
    let bob = Pubkey::new_unique();
    let (market_pk, market_acc) = market_account(&program_id, 0);
    let (global_pk, global_acc) = global_state_account(&program_id);
    let (order_book_pk, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let alice_credit_pk = Pubkey::new_unique();
    let bob_credit_pk = Pubkey::new_unique();

    let mut ob_data = order_book_data(0, 16, 8, 16);
    let mut alice_credit = credit_account(&program_id, &alice, 500_000_000, 0, 0);
    let mut bob_credit = credit_account(&program_id, &bob, 500_000_000, 0, 0);

    let lot = 100_000_000u64;
    let px = |d: u64| d * 1_000; // tick-aligned

    // Alice posts three bid levels, two orders deep on the middle one.
    let script: Vec<(u8, u64, u64)> = vec![
        (SIDE_BID, px(150_000), lot),
        (SIDE_BID, px(149_000), lot),
        (SIDE_BID, px(149_000), 2 * lot),
        (SIDE_BID, px(148_000), lot),
        (SIDE_ASK, px(152_000), lot),
        (SIDE_ASK, px(151_000), 3 * lot),
    ];
    for (i, (side, price, size)) in script.iter().enumerate() {
        let ix = place_order_ix(
            &program_id, market_pk, order_book_pk, alice_credit_pk, alice, global_pk,
            *side, ORDER_TYPE_LIMIT, *price, *size, 0,
        );
        let accounts = vec![
            (market_pk, market_acc.clone()),
            (order_book_pk, program_account(&program_id, &ob_data)),
            (alice_credit_pk, alice_credit.clone()),
            (alice, Account::default()),
            (global_pk, global_acc.clone()),
        ];
        let res = m.process_instruction(&ix, &accounts);
        assert!(matches!(res.program_result, MolluskResult::Success), "post {i}: {:?}", res.program_result);
        ob_data = res.resulting_accounts.iter().find(|(k, _)| *k == order_book_pk).unwrap().1.data.clone();
        alice_credit = res.resulting_accounts.iter().find(|(k, _)| *k == alice_credit_pk).unwrap().1.clone();
        assert_book_invariants(&mut ob_data, &format!("after post {i}"));
    }
    {
        let mut d = ob_data.clone();
        let ob = OrderBookView::from_account_data(&mut d).unwrap();
        println!(
            "posted: active={} bids={} asks={} best_bid={:?} best_ask={:?}",
            ob.header.active_order_count, ob.header.bid_level_count, ob.header.ask_level_count,
            ob.best_bid_level().map(|l| l.price), ob.best_ask_level().map(|l| l.price)
        );
    }

    // Bob sweeps both ask levels with a marketable limit buy (4 lots).
    let ix = place_order_ix(
        &program_id, market_pk, order_book_pk, bob_credit_pk, bob, global_pk,
        SIDE_BID, ORDER_TYPE_LIMIT, px(152_000), 4 * lot, 0,
    );
    let accounts = vec![
        (market_pk, market_acc.clone()),
        (order_book_pk, program_account(&program_id, &ob_data)),
        (bob_credit_pk, bob_credit.clone()),
        (bob, Account::default()),
        (global_pk, global_acc.clone()),
    ];
    let res = m.process_instruction(&ix, &accounts);
    assert!(matches!(res.program_result, MolluskResult::Success), "sweep: {:?}", res.program_result);
    ob_data = res.resulting_accounts.iter().find(|(k, _)| *k == order_book_pk).unwrap().1.data.clone();
    bob_credit = res.resulting_accounts.iter().find(|(k, _)| *k == bob_credit_pk).unwrap().1.clone();
    let _ = &bob_credit;
    assert_book_invariants(&mut ob_data, "after sweep");
    {
        let mut d = ob_data.clone();
        let ob = OrderBookView::from_account_data(&mut d).unwrap();
        // price priority: the cheaper ask (151_000) must have filled first.
        println!(
            "sweep fills: [0] px={} qty={} · [1] px={} qty={} (count={})",
            ob.fill_events[0].price, ob.fill_events[0].quantity,
            ob.fill_events[1].price, ob.fill_events[1].quantity,
            ob.header.fill_event_count
        );
        assert_eq!(ob.header.fill_event_count, 2);
        assert_eq!(ob.fill_events[0].price, px(151_000), "best (lowest) ask must fill first");
        assert_eq!(ob.fill_events[1].price, px(152_000));
    }

    // Cancel the middle-level HEAD, then what is left of that level.
    for order_id in [2u64, 3u64] {
        let mut data = vec![0x11u8];
        data.extend_from_slice(&order_id.to_le_bytes());
        let ix = Instruction {
            program_id,
            accounts: vec![
                AccountMeta::new(order_book_pk, false),
                AccountMeta::new(alice_credit_pk, false),
                AccountMeta::new_readonly(alice, true),
            ],
            data,
        };
        let accounts = vec![
            (order_book_pk, program_account(&program_id, &ob_data)),
            (alice_credit_pk, alice_credit.clone()),
            (alice, Account::default()),
        ];
        let res = m.process_instruction(&ix, &accounts);
        assert!(matches!(res.program_result, MolluskResult::Success), "cancel {order_id}: {:?}", res.program_result);
        ob_data = res.resulting_accounts.iter().find(|(k, _)| *k == order_book_pk).unwrap().1.data.clone();
        alice_credit = res.resulting_accounts.iter().find(|(k, _)| *k == alice_credit_pk).unwrap().1.clone();
        assert_book_invariants(&mut ob_data, &format!("after cancel {order_id}"));
    }

    let mut d = ob_data.clone();
    let ob = OrderBookView::from_account_data(&mut d).unwrap();
    println!(
        "final: active={} free={} bids={} asks={} — all invariants held at every step",
        ob.header.active_order_count, ob.header.free_slot_count,
        ob.header.bid_level_count, ob.header.ask_level_count
    );
}

// ---------------------------------------------------------------------------
// Negative result: POST_ONLY that would cross is rejected, and self-trade is
// rejected, on the real program.
// ---------------------------------------------------------------------------
#[test]
fn s2_negative_post_only_and_self_trade_are_rejected() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);

    let maker = Pubkey::new_unique();
    let (market_pk, market_acc) = market_account(&program_id, 0);
    let (global_pk, global_acc) = global_state_account(&program_id);
    let (order_book_pk, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let maker_credit_pk = Pubkey::new_unique();

    let price = 150 * PRICE_SCALE;
    let size = 100_000_000u64;
    let mut ob_data = order_book_data(0, 8, 4, 8);
    {
        let mut ob = OrderBookView::from_account_data(&mut ob_data).unwrap();
        let slot = ob.alloc_slot().unwrap();
        ob.order_slots[slot as usize].init(
            1, maker.to_bytes(), SIDE_ASK, ORDER_TYPE_LIMIT, price, size, 0, 750_000,
        );
        ob.insert_ask_level(price, slot).unwrap();
    }
    let accounts = vec![
        (market_pk, market_acc),
        (order_book_pk, program_account(&program_id, &ob_data)),
        (maker_credit_pk, credit_account(&program_id, &maker, 10_000_000, 750_000, 1)),
        (maker, Account::default()),
        (global_pk, global_acc),
    ];

    // POST_ONLY buy at the ask must be rejected outright.
    let ix = place_order_ix(
        &program_id, market_pk, order_book_pk, maker_credit_pk, maker, global_pk,
        SIDE_BID, ORDER_TYPE_POST_ONLY, price, size, 0,
    );
    let res = m.process_instruction(&ix, &accounts);
    println!("POST_ONLY crossing  -> {:?}", res.program_result);
    assert!(!matches!(res.program_result, MolluskResult::Success), "POST_ONLY crossed the book");

    // A LIMIT buy from the SAME owner as the resting ask must be rejected.
    let ix = place_order_ix(
        &program_id, market_pk, order_book_pk, maker_credit_pk, maker, global_pk,
        SIDE_BID, ORDER_TYPE_LIMIT, price, size, 0,
    );
    let res = m.process_instruction(&ix, &accounts);
    println!("self-trade          -> {:?}", res.program_result);
    assert!(!matches!(res.program_result, MolluskResult::Success), "self-trade was allowed");
}

// ---------------------------------------------------------------------------
// Negative result: a partially-grown OrderBook account cannot be parsed.
// ---------------------------------------------------------------------------
#[test]
fn s2_negative_partially_grown_book_is_rejected() {
    let full = OrderBookHeader::compute_account_size(2048, 512, 4096);
    let mut data = order_book_data(0, 2048, 512, 4096);
    assert_eq!(data.len(), full);
    for len in [
        OrderBookHeader::LEN - 1,
        OrderBookHeader::LEN,
        10_240,           // one grow_orderbook chunk
        full - 1,
    ] {
        let mut short = data[..len].to_vec();
        let r = OrderBookView::from_account_data(&mut short);
        println!("len {len:>7} -> {}", if r.is_ok() { "ACCEPTED" } else { "rejected" });
        assert!(r.is_err(), "a {len}-byte book was accepted");
    }
    assert!(OrderBookView::from_account_data(&mut data).is_ok());
    println!("len {full:>7} -> ACCEPTED (full size only)");
}

// ---------------------------------------------------------------------------
// S2-04 · `(credit.active_orders as u8) >= orders_per_user` truncates
// ---------------------------------------------------------------------------
//
// place_order.rs:211 narrows a u16 counter to u8 before comparing it against
// `orders_per_user`. `reconcile_credit` (trading_credit.rs:142) sets that
// counter to the *scanned* number of the caller's active slots, which is
// bounded only by `max_order_slots` (2048), not by `orders_per_user` (20).
// At 511 owned slots the gate still fires (511 as u8 == 255); at 512 it is
// silently bypassed (512 as u8 == 0).
fn seeded_book_with_n_asks(owner: &Pubkey, n: u16) -> Vec<u8> {
    let mut data = order_book_data(0, 2048, 512, 4096);
    {
        let mut ob = OrderBookView::from_account_data(&mut data).unwrap();
        for i in 0..n as u64 {
            let slot = ob.alloc_slot().unwrap();
            let price = 200_000_000 + i * 1_000;
            ob.order_slots[slot as usize].init(
                100 + i, owner.to_bytes(), SIDE_ASK, ORDER_TYPE_LIMIT, price, 100_000_000, 0, 1_000,
            );
            ob.insert_ask_level(price, slot).unwrap();
        }
    }
    data
}

#[test]
fn s2_04_orders_per_user_gate_truncates_at_256() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let alice = Pubkey::new_unique();
    let (market_pk, market_acc) = market_account(&program_id, 0);
    let (global_pk, global_acc) = global_state_account(&program_id);
    let (order_book_pk, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let credit_pk = Pubkey::new_unique();

    for n in [511u16, 512u16] {
        let ob_data = seeded_book_with_n_asks(&alice, n);
        let accounts = vec![
            (market_pk, market_acc.clone()),
            (order_book_pk, program_account(&program_id, &ob_data)),
            (credit_pk, credit_account(&program_id, &alice, 50_000_000_000, 0, 0)),
            (alice, Account::default()),
            (global_pk, global_acc.clone()),
        ];
        let ix = place_order_ix(
            &program_id, market_pk, order_book_pk, credit_pk, alice, global_pk,
            SIDE_BID, ORDER_TYPE_LIMIT, 100_000_000, 100_000_000, 0,
        );
        let res = m.process_instruction(&ix, &accounts);
        println!(
            "owner already holds {n:>3} active slots (orders_per_user = 20, {n} as u8 = {}): {:?}  CU = {}",
            n as u8, res.program_result, res.compute_units_consumed
        );
        if n == 511 {
            // 511 as u8 == 255 >= 20 -> MaxOrdersPerUser (custom 0x123 == 291)
            assert!(matches!(res.program_result, MolluskResult::Failure(_)), "511 slots should be capped");
        } else {
            // 512 as u8 == 0, and 0 >= 20 is false -> the cap does not fire.
            assert!(
                matches!(res.program_result, MolluskResult::Success),
                "512 slots should have slipped past the truncated gate: {:?}",
                res.program_result
            );
            let mut after = res.resulting_accounts.iter()
                .find(|(k, _)| *k == order_book_pk).unwrap().1.data.clone();
            let ob = OrderBookView::from_account_data(&mut after).unwrap();
            println!(
                "  -> order accepted; owner now holds {} active slots, {}x the declared cap of {}",
                ob.header.active_order_count,
                ob.header.active_order_count / DEFAULT_ORDERS_PER_USER as u16,
                DEFAULT_ORDERS_PER_USER
            );
            assert_eq!(ob.header.active_order_count, 513);
        }
    }
}

// ---------------------------------------------------------------------------
// Negative result: the two O(max_order_slots) scans (reconcile_credit and
// find_order_by_id) fit the compute budget on a FULL-SIZE 2048-slot book.
// ---------------------------------------------------------------------------
#[test]
fn s2_negative_full_size_book_fits_the_compute_budget() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);

    let alice = Pubkey::new_unique();   // places the order
    let seeder = Pubkey::new_unique();  // owns the 511 pre-existing asks
    let (market_pk, market_acc) = market_account(&program_id, 0);
    let (global_pk, global_acc) = global_state_account(&program_id);
    let (order_book_pk, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let credit_pk = Pubkey::new_unique();

    // Real deployed dimensions: 2048 slots / 512 levels per side / 4096 fills,
    // with 511 ask levels already in place so the sorted-array insert shifts most.
    let ob_data = seeded_book_with_n_asks(&seeder, 511);

    let accounts = vec![
        (market_pk, market_acc.clone()),
        (order_book_pk, program_account(&program_id, &ob_data)),
        (credit_pk, credit_account(&program_id, &alice, 5_000_000_000, 0, 0)),
        (alice, Account::default()),
        (global_pk, global_acc.clone()),
    ];
    let ix = place_order_ix(
        &program_id, market_pk, order_book_pk, credit_pk, alice, global_pk,
        SIDE_BID, ORDER_TYPE_LIMIT, 100_000_000, 100_000_000, 0,
    );
    let res = m.process_instruction(&ix, &accounts);
    println!(
        "place_order on a 2048-slot / 511-ask-level book: {:?}  CU = {}",
        res.program_result, res.compute_units_consumed
    );
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);
    assert!(
        res.compute_units_consumed < 200_000,
        "place_order needs {} CU, over the 200k default budget",
        res.compute_units_consumed
    );

    let ob_after = res.resulting_accounts.iter().find(|(k, _)| *k == order_book_pk).unwrap().1.data.clone();
    let credit_after = res.resulting_accounts.iter().find(|(k, _)| *k == credit_pk).unwrap().1.clone();

    // cancel_order: reconcile_credit (2048) + find_order_by_id (2048) back to back.
    let mut data = vec![0x11u8];
    data.extend_from_slice(&2u64.to_le_bytes()); // the order alice just rested
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(order_book_pk, false),
            AccountMeta::new(credit_pk, false),
            AccountMeta::new_readonly(alice, true),
        ],
        data,
    };
    let accounts = vec![
        (order_book_pk, program_account(&program_id, &ob_after)),
        (credit_pk, credit_after),
        (alice, Account::default()),
    ];
    let res = m.process_instruction(&ix, &accounts);
    println!(
        "cancel_order on the same book:                  {:?}  CU = {}",
        res.program_result, res.compute_units_consumed
    );
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);
    assert!(
        res.compute_units_consumed < 200_000,
        "cancel_order needs {} CU, over the 200k default budget",
        res.compute_units_consumed
    );
}

// ---------------------------------------------------------------------------
// S2-05 · the session-key expiry gate is a pure function of the ER's clock
// ---------------------------------------------------------------------------
//
// `TradingCredit::is_authorized_signer` (trading_credit.rs:110-117) compares
// `now < session_expiry`, and `now` is `Clock::get()` taken inside the ephemeral
// rollup (place_order.rs:148). The sequencer supplies that clock. Rewinding it
// makes a dead session key live again; nothing else in either instruction is
// bound to real time. Mollusk stands in for the sequencer here by setting the
// same sysvar the ER controls.
fn session_credit(program_id: &Pubkey, owner: &Pubkey, session: &Pubkey, expiry: i64) -> Account {
    let mut c = TradingCredit::zeroed();
    c.discriminator = DISC_TRADING_CREDIT;
    c.owner = owner.to_bytes();
    c.market_index = 0;
    c.credit = 10_000_000;
    c.session_authority = session.to_bytes();
    c.session_expiry = expiry;
    program_account(program_id, bytemuck::bytes_of(&c))
}

#[test]
fn s2_05_rewinding_the_er_clock_revives_an_expired_session_key() {
    let program_id = Pubkey::new_unique();
    let owner = Pubkey::new_unique();
    let session = Pubkey::new_unique();
    let (market_pk, market_acc) = market_account(&program_id, 0);
    let (global_pk, global_acc) = global_state_account(&program_id);
    let (order_book_pk, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let credit_pk = Pubkey::new_unique();

    // The session key died an hour ago in real time.
    let session_expiry = NOW - 3600;
    let ob_data = order_book_data(0, 8, 4, 8);
    let accounts = vec![
        (market_pk, market_acc),
        (order_book_pk, program_account(&program_id, &ob_data)),
        (credit_pk, session_credit(&program_id, &owner, &session, session_expiry)),
        (session, Account::default()),
        (global_pk, global_acc),
    ];
    let ix = place_order_ix(
        &program_id, market_pk, order_book_pk, credit_pk, session, global_pk,
        SIDE_BID, ORDER_TYPE_LIMIT, 150 * PRICE_SCALE, 100_000_000, 0,
    );

    // Honest clock: rejected (custom 0x101 == 257 InvalidAuthority).
    let honest = mollusk(&program_id); // clock = NOW
    let res = honest.process_instruction(&ix, &accounts);
    println!("clock = {NOW} (honest, expiry {session_expiry}): {:?}", res.program_result);
    assert!(!matches!(res.program_result, MolluskResult::Success));

    // Sequencer rewinds the clock two hours: the same instruction, same accounts,
    // same dead key -> accepted, and the order rests inside the owner's credit.
    let mut hostile = mollusk(&program_id);
    hostile.sysvars.clock.unix_timestamp = NOW - 7200;
    let res = hostile.process_instruction(&ix, &accounts);
    println!("clock = {} (rewound by the sequencer):        {:?}", NOW - 7200, res.program_result);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "expected the rewound clock to revive the key: {:?}", res.program_result
    );
    let mut after = res.resulting_accounts.iter()
        .find(|(k, _)| *k == order_book_pk).unwrap().1.data.clone();
    let ob = OrderBookView::from_account_data(&mut after).unwrap();
    println!(
        "  -> order rested: active_order_count={} owner={}",
        ob.header.active_order_count,
        if ob.order_slots[0].owner == owner.to_bytes() { "the CREDIT OWNER" } else { "?" }
    );
    assert_eq!(ob.header.active_order_count, 1);
    assert_eq!(ob.order_slots[0].owner, owner.to_bytes());
}
