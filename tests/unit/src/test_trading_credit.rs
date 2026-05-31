use slipstream::state::*;
use bytemuck::Zeroable;

fn make_book(max_slots: u16, max_levels: u16, max_fills: u16) -> Vec<u8> {
    let size = OrderBookHeader::compute_account_size(max_slots, max_levels, max_fills);
    let mut data = vec![0u8; size];
    let header: &mut OrderBookHeader = bytemuck::from_bytes_mut(&mut data[..OrderBookHeader::LEN]);
    header.discriminator = DISC_ORDER_BOOK;
    header.bump = 1;
    header.market_index = 0;
    header.orders_per_user = DEFAULT_ORDERS_PER_USER;
    header.max_order_slots = max_slots;
    header.max_price_levels_per_side = max_levels;
    header.max_fill_events = max_fills;
    header.active_order_count = 0;
    header.bid_level_count = 0;
    header.ask_level_count = 0;
    header.fill_event_head = 0;
    header.fill_event_tail = 0;
    header.fill_event_count = 0;
    header.free_list_head = 0;
    header.free_slot_count = max_slots;
    header.next_order_id = 1;
    header.next_fill_sequence = 1;
    data
}

fn make_credit(owner: [u8; 32], credit: u64) -> TradingCredit {
    let mut tc = TradingCredit::zeroed();
    tc.discriminator = DISC_TRADING_CREDIT;
    tc.bump = 0;
    tc.market_index = 0;
    tc.active_orders = 0;
    tc.owner = owner;
    tc.credit = credit;
    tc.committed = 0;
    tc
}

#[test]
fn test_reconcile_no_change_when_committed_matches_slots() {
    let mut data = make_book(4, 2, 4);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();
    ob.init_free_list();

    let owner = [7u8; 32];
    // Place one slot for this owner with margin 500
    let slot_idx = ob.alloc_slot().unwrap();
    ob.order_slots[slot_idx as usize].init(1, owner, SIDE_BID, ORDER_TYPE_LIMIT, 100, 10, 0, 500);

    let mut credit = make_credit(owner, 1000);
    credit.committed = 500;
    credit.active_orders = 1;

    let drained = slipstream::state::reconcile_credit(&ob, &mut credit);
    assert_eq!(drained, 0);
    assert_eq!(credit.credit, 1000);
    assert_eq!(credit.committed, 500);
    assert_eq!(credit.active_orders, 1);
}

#[test]
fn test_reconcile_drains_credit_after_partial_fill() {
    let mut data = make_book(4, 2, 4);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();
    ob.init_free_list();

    let owner = [7u8; 32];
    // Slot originally had margin 500; a fill drained it to 300
    let slot_idx = ob.alloc_slot().unwrap();
    ob.order_slots[slot_idx as usize].init(1, owner, SIDE_BID, ORDER_TYPE_LIMIT, 100, 10, 0, 300);

    // credit still thinks committed = 500 (pre-fill)
    let mut credit = make_credit(owner, 1000);
    credit.committed = 500;
    credit.active_orders = 1;

    let drained = slipstream::state::reconcile_credit(&ob, &mut credit);
    // 200 should have been drained (500 - 300)
    assert_eq!(drained, 200);
    assert_eq!(credit.credit, 800); // 1000 - 200 flowed to settlement
    assert_eq!(credit.committed, 300);
    assert_eq!(credit.active_orders, 1);
}

#[test]
fn test_reconcile_fully_drained_when_slot_freed() {
    let mut data = make_book(4, 2, 4);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();
    ob.init_free_list();

    let owner = [7u8; 32];
    // No active slots for this owner (was fully filled and freed)
    let mut credit = make_credit(owner, 1000);
    credit.committed = 500; // stale
    credit.active_orders = 1; // stale

    let drained = slipstream::state::reconcile_credit(&ob, &mut credit);
    assert_eq!(drained, 500);
    assert_eq!(credit.credit, 500);
    assert_eq!(credit.committed, 0);
    assert_eq!(credit.active_orders, 0);
    assert!(credit.is_idle());
}

#[test]
fn test_reconcile_ignores_other_users_slots() {
    let mut data = make_book(4, 2, 4);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();
    ob.init_free_list();

    let me = [7u8; 32];
    let other = [8u8; 32];
    // My slot, margin 200
    let my_slot = ob.alloc_slot().unwrap();
    ob.order_slots[my_slot as usize].init(1, me, SIDE_BID, ORDER_TYPE_LIMIT, 100, 10, 0, 200);
    // Their slot, margin 999
    let their_slot = ob.alloc_slot().unwrap();
    ob.order_slots[their_slot as usize].init(2, other, SIDE_ASK, ORDER_TYPE_LIMIT, 100, 10, 0, 999);

    let mut credit = make_credit(me, 1000);
    credit.committed = 200;
    credit.active_orders = 1;

    let drained = slipstream::state::reconcile_credit(&ob, &mut credit);
    assert_eq!(drained, 0);
    assert_eq!(credit.committed, 200);
    assert_eq!(credit.active_orders, 1);
}

#[test]
fn test_drain_margin_for_fill_is_proportional() {
    // Independent of reconcile, verify the slot's drain helper computes fair shares.
    let mut slot = OrderSlot::zeroed();
    slot.init(1, [0u8; 32], SIDE_BID, ORDER_TYPE_LIMIT, 100_000_000, 10_000, 0, 10_000_000);
    // Fill 25% of the size → drain 25% of margin
    let drained = slot.drain_margin_for_fill(2_500);
    assert_eq!(drained, 2_500_000);
    assert_eq!(slot.margin_reserved, 7_500_000);
    // Fill remaining → drain remaining margin
    let drained2 = slot.drain_margin_for_fill(7_500);
    assert_eq!(drained2, 7_500_000);
    assert_eq!(slot.margin_reserved, 0);
}

#[test]
fn test_trading_credit_available_and_idle() {
    let mut tc = make_credit([1u8; 32], 1_000);
    assert_eq!(tc.available(), 1_000);
    assert!(tc.is_idle());

    tc.committed = 300;
    tc.active_orders = 1;
    assert_eq!(tc.available(), 700);
    assert!(!tc.is_idle());

    tc.committed = 0;
    tc.active_orders = 0;
    assert!(tc.is_idle());

    // Over-committed shouldn't underflow
    tc.committed = 2_000;
    assert_eq!(tc.available(), 0);
}
