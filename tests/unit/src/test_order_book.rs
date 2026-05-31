use slipstream::state::*;

fn create_test_order_book(max_slots: u16, max_levels: u16, max_fills: u16) -> Vec<u8> {
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

#[test]
fn test_order_book_view_creation() {
    let mut data = create_test_order_book(16, 8, 32);
    let ob = OrderBookView::from_account_data(&mut data).unwrap();

    assert_eq!(ob.header.max_order_slots, 16);
    assert_eq!(ob.header.max_price_levels_per_side, 8);
    assert_eq!(ob.header.max_fill_events, 32);
    assert_eq!(ob.order_slots.len(), 16);
    assert_eq!(ob.bid_levels.len(), 8);
    assert_eq!(ob.ask_levels.len(), 8);
    assert_eq!(ob.fill_events.len(), 32);
    assert_eq!(ob.free_list.len(), 16);
}

#[test]
fn test_free_list_init() {
    let mut data = create_test_order_book(10, 5, 10);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    ob.init_free_list();

    // Check chain: 0 -> 1 -> 2 -> ... -> 9 -> SENTINEL
    assert_eq!(ob.header.free_list_head, 0);
    assert_eq!(ob.free_list[0], 1);
    assert_eq!(ob.free_list[1], 2);
    assert_eq!(ob.free_list[8], 9);
    assert_eq!(ob.free_list[9], SENTINEL);
}

#[test]
fn test_alloc_free_slot() {
    let mut data = create_test_order_book(4, 2, 4);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();
    ob.init_free_list();

    let slot0 = ob.alloc_slot().unwrap();
    assert_eq!(slot0, 0);
    assert_eq!(ob.header.free_slot_count, 3);
    assert_eq!(ob.header.active_order_count, 1);
    assert_eq!(ob.header.free_list_head, 1);

    let slot1 = ob.alloc_slot().unwrap();
    assert_eq!(slot1, 1);
    assert_eq!(ob.header.free_slot_count, 2);
    assert_eq!(ob.header.free_list_head, 2); // Next free is slot 2

    // Free slot0
    ob.free_slot(slot0);
    assert_eq!(ob.header.free_slot_count, 3);
    assert_eq!(ob.header.active_order_count, 1); // slot1 still active
    assert_eq!(ob.header.free_list_head, 0);
    assert_eq!(ob.free_list[0], 2); // Points to old head (was 2)
}

#[test]
fn test_alloc_until_full() {
    let mut data = create_test_order_book(3, 2, 4);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();
    ob.init_free_list();

    ob.alloc_slot().unwrap();
    ob.alloc_slot().unwrap();
    ob.alloc_slot().unwrap();

    // Should be full now
    assert!(ob.alloc_slot().is_err());
}

#[test]
fn test_bid_level_insertion_sorted() {
    let mut data = create_test_order_book(10, 5, 10);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    // Insert bids in random order - should be sorted descending
    ob.insert_bid_level(150_000_000, 0).unwrap(); // $150
    ob.insert_bid_level(160_000_000, 1).unwrap(); // $160
    ob.insert_bid_level(140_000_000, 2).unwrap(); // $140

    assert_eq!(ob.header.bid_level_count, 3);

    // Check order: 160, 150, 140 (descending)
    assert_eq!(ob.bid_levels[0].price, 160_000_000);
    assert_eq!(ob.bid_levels[1].price, 150_000_000);
    assert_eq!(ob.bid_levels[2].price, 140_000_000);
}

#[test]
fn test_ask_level_insertion_sorted() {
    let mut data = create_test_order_book(10, 5, 10);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    // Insert asks - should be sorted ascending
    ob.insert_ask_level(150_000_000, 0).unwrap();
    ob.insert_ask_level(140_000_000, 1).unwrap();
    ob.insert_ask_level(160_000_000, 2).unwrap();

    assert_eq!(ob.header.ask_level_count, 3);

    // Check order: 140, 150, 160 (ascending)
    assert_eq!(ob.ask_levels[0].price, 140_000_000);
    assert_eq!(ob.ask_levels[1].price, 150_000_000);
    assert_eq!(ob.ask_levels[2].price, 160_000_000);
}

#[test]
fn test_find_bid_level() {
    let mut data = create_test_order_book(10, 5, 10);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    ob.insert_bid_level(150_000_000, 0).unwrap();
    ob.insert_bid_level(160_000_000, 1).unwrap();

    let idx = ob.find_bid_level(150_000_000);
    assert_eq!(idx, Some(1)); // Second position (after 160)

    let missing = ob.find_bid_level(999_000_000);
    assert_eq!(missing, None);
}

#[test]
fn test_find_ask_level() {
    let mut data = create_test_order_book(10, 5, 10);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    ob.insert_ask_level(150_000_000, 0).unwrap();
    ob.insert_ask_level(140_000_000, 1).unwrap();

    let idx = ob.find_ask_level(140_000_000);
    assert_eq!(idx, Some(0)); // First position

    let idx2 = ob.find_ask_level(150_000_000);
    assert_eq!(idx2, Some(1));
}

#[test]
fn test_remove_bid_level() {
    let mut data = create_test_order_book(10, 5, 10);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    ob.insert_bid_level(150_000_000, 0).unwrap();
    ob.insert_bid_level(160_000_000, 1).unwrap();
    ob.insert_bid_level(140_000_000, 2).unwrap();

    // Remove middle level (150)
    ob.remove_bid_level(1);

    assert_eq!(ob.header.bid_level_count, 2);
    assert_eq!(ob.bid_levels[0].price, 160_000_000);
    assert_eq!(ob.bid_levels[1].price, 140_000_000);
}

#[test]
fn test_remove_ask_level() {
    let mut data = create_test_order_book(10, 5, 10);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    ob.insert_ask_level(140_000_000, 0).unwrap();
    ob.insert_ask_level(150_000_000, 1).unwrap();
    ob.insert_ask_level(160_000_000, 2).unwrap();

    // Remove first level (140)
    ob.remove_ask_level(0);

    assert_eq!(ob.header.ask_level_count, 2);
    assert_eq!(ob.ask_levels[0].price, 150_000_000);
    assert_eq!(ob.ask_levels[1].price, 160_000_000);
}

#[test]
fn test_best_bid_ask() {
    let mut data = create_test_order_book(10, 5, 10);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    assert!(ob.best_bid_level().is_none());
    assert!(ob.best_ask_level().is_none());

    ob.insert_bid_level(150_000_000, 0).unwrap();
    ob.insert_bid_level(160_000_000, 1).unwrap();

    let best_bid = ob.best_bid_level().unwrap();
    assert_eq!(best_bid.price, 160_000_000); // Highest bid

    ob.insert_ask_level(170_000_000, 0).unwrap();
    ob.insert_ask_level(180_000_000, 1).unwrap();

    let best_ask = ob.best_ask_level().unwrap();
    assert_eq!(best_ask.price, 170_000_000); // Lowest ask
}

#[test]
fn test_fill_event_queue() {
    let mut data = create_test_order_book(10, 5, 4);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    let fill = FillEvent {
            sequence: 1,
            maker: [1u8; 32],
            taker: [2u8; 32],
            price: 150_000_000,
            quantity: 1_000_000_000,
            filled_margin: 0,
            taker_fee_bps_snapshot: 6,
            maker_rebate_bps_snapshot: 0,
            maker_side: SIDE_BID,
            _pad: [0; 3],
        };

    ob.push_fill_event(fill).unwrap();
    assert_eq!(ob.header.fill_event_count, 1);
    assert_eq!(ob.header.fill_event_tail, 1);

    let popped = ob.pop_fill_event().unwrap();
    assert_eq!(popped.sequence, 1);
    assert_eq!(ob.header.fill_event_count, 0);
    assert_eq!(ob.header.fill_event_head, 1);
}

#[test]
fn test_fill_event_queue_wraparound() {
    let mut data = create_test_order_book(10, 5, 3);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    let fill = FillEvent {
            sequence: 0,
            maker: [0u8; 32],
            taker: [0u8; 32],
            price: 100_000_000,
            quantity: 1_000_000_000,
            filled_margin: 0,
            taker_fee_bps_snapshot: 6,
            maker_rebate_bps_snapshot: 0,
            maker_side: SIDE_BID,
            _pad: [0; 3],
        };

    // Fill the queue (capacity = 3)
    ob.push_fill_event(fill).unwrap();
    ob.push_fill_event(fill).unwrap();
    ob.push_fill_event(fill).unwrap();
    assert_eq!(ob.header.fill_event_count, 3);

    // Full: the next push now OVERWRITES the oldest entry instead of erroring
    // (true ring; the OrderBook is delegated to the ER and L1 never drains it,
    // so erroring here would brick trading — see push_fill_event docs).
    ob.push_fill_event(fill).unwrap();
    assert_eq!(ob.header.fill_event_count, 3); // pinned at max
    assert_eq!(ob.header.fill_event_head, 1); // oldest dropped, head advanced
    assert_eq!(ob.header.fill_event_tail, 1); // wrapped

    // Pop one still works (count drops, head advances).
    ob.pop_fill_event().unwrap();
    assert_eq!(ob.header.fill_event_count, 2);
    assert_eq!(ob.header.fill_event_head, 2);

    // And we can push again into the freed space.
    ob.push_fill_event(fill).unwrap();
    assert_eq!(ob.header.fill_event_count, 3);
    assert_eq!(ob.header.fill_event_tail, 2); // wrapped again
}

#[test]
fn test_next_order_id() {
    let mut data = create_test_order_book(10, 5, 10);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    assert_eq!(ob.next_order_id(), 1);
    assert_eq!(ob.next_order_id(), 2);
    assert_eq!(ob.next_order_id(), 3);
}

#[test]
fn test_next_fill_sequence() {
    let mut data = create_test_order_book(10, 5, 10);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    assert_eq!(ob.next_fill_sequence(), 1);
    assert_eq!(ob.next_fill_sequence(), 2);
    assert_eq!(ob.next_fill_sequence(), 3);
}

#[test]
fn test_peek_fill_event() {
    let mut data = create_test_order_book(10, 5, 4);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    assert!(ob.peek_fill_event().is_none());

    let fill = FillEvent {
            sequence: 42,
            maker: [1u8; 32],
            taker: [2u8; 32],
            price: 150_000_000,
            quantity: 1_000_000_000,
            filled_margin: 0,
            taker_fee_bps_snapshot: 6,
            maker_rebate_bps_snapshot: 0,
            maker_side: SIDE_BID,
            _pad: [0; 3],
        };

    ob.push_fill_event(fill).unwrap();

    let peeked = ob.peek_fill_event().unwrap();
    assert_eq!(peeked.sequence, 42);

    // Count should not change
    assert_eq!(ob.header.fill_event_count, 1);
}

#[test]
fn test_price_levels_at_capacity() {
    let mut data = create_test_order_book(10, 3, 10);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();

    ob.insert_bid_level(150_000_000, 0).unwrap();
    ob.insert_bid_level(160_000_000, 1).unwrap();
    ob.insert_bid_level(140_000_000, 2).unwrap();

    // Should be at capacity (max_price_levels_per_side = 3)
    assert!(ob.insert_bid_level(170_000_000, 3).is_err());
}
