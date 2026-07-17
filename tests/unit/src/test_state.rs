use bytemuck::{Pod, Zeroable};
use slipstream::state::*;

#[test]
fn test_global_state_size() {
    assert_eq!(GlobalState::LEN, 104);
    assert_eq!(std::mem::size_of::<GlobalState>(), 104);
}

#[test]
fn test_global_state_serialization() {
    let mut state = GlobalState::zeroed();
    state.discriminator = DISC_GLOBAL_STATE;
    state.bump = 255;
    state.market_count = 5;
    state.paused = 1;
    state.authority = [42u8; 32];
    state.treasury = [99u8; 32];
    state.insurance_vault = [77u8; 32];

    let bytes = bytemuck::bytes_of(&state);
    let deserialized: &GlobalState = bytemuck::from_bytes(bytes);

    assert_eq!(deserialized.discriminator, DISC_GLOBAL_STATE);
    assert_eq!(deserialized.bump, 255);
    assert_eq!(deserialized.market_count, 5);
    assert_eq!(deserialized.paused, 1);
    assert_eq!(deserialized.authority, [42u8; 32]);
}

#[test]
fn test_market_size() {
    // Market with 225-element TWAP buffer + Round 3 oracle additions
    // Base: 224 + 225*8 = 2024
    // Round 3: + 32 (switchboard_feed) + 1 (restricted_mode) + 1 (agreement_streak) + 6 (padding) = +40
    assert_eq!(Market::LEN, 224 + 225 * 8 + 40);
    assert_eq!(Market::LEN, 2064);
}

#[test]
fn test_market_cumulative_funding_index() {
    let mut market = Market::zeroed();

    // Set to large value
    let val: i128 = 123_456_789_012_345_678_901_234_567_890;
    market.set_cumulative_funding_index(val);
    assert_eq!(market.get_cumulative_funding_index(), val);

    // Set to negative
    let neg: i128 = -987_654_321_098_765_432_109_876_543_210;
    market.set_cumulative_funding_index(neg);
    assert_eq!(market.get_cumulative_funding_index(), neg);

    // Set to zero
    market.set_cumulative_funding_index(0);
    assert_eq!(market.get_cumulative_funding_index(), 0);
}

#[test]
fn test_market_twap() {
    let mut market = Market::zeroed();

    // Push 5 prices
    market.push_twap_price(100_000_000);
    assert_eq!(market.twap_count, 1);
    assert_eq!(market.twap_write_index, 1);

    market.push_twap_price(102_000_000);
    market.push_twap_price(104_000_000);
    market.push_twap_price(103_000_000);
    market.push_twap_price(101_000_000);

    assert_eq!(market.twap_count, 5);

    let twap = market.get_twap().unwrap();
    // Average of [100, 102, 104, 103, 101] = 510/5 = 102
    assert_eq!(twap, 102_000_000);
}

#[test]
fn test_market_twap_wraparound() {
    let mut market = Market::zeroed();

    // Fill entire buffer
    for i in 0..225 {
        market.push_twap_price(100_000_000 + i as u64 * 1_000_000);
    }
    assert_eq!(market.twap_count, 225);
    assert_eq!(market.twap_write_index, 0); // Wrapped around

    // Push one more - should overwrite index 0
    market.push_twap_price(999_000_000);
    assert_eq!(market.twap_count, 225); // Still 225
    assert_eq!(market.twap_write_index, 1);
    assert_eq!(market.twap_prices[0], 999_000_000);
}

// A fixed "now": minute 1000 * 60 = 60_000s. Stamps are (ts/60) mod 2^16.
const NOW_TS: i64 = 60_000;
const NOW_MIN: u16 = 1000;

#[test]
fn test_mark_price_for_close_prefers_last_mark_price() {
    let mut market = Market::zeroed();
    market.push_twap_price(100_000_000);
    market.push_twap_price(102_000_000);
    market.last_mark_price = 150_000_000;
    market.set_mark_price_minute(NOW_MIN); // freshly stamped

    // A cranked market uses the live last_mark_price, not the lagging TWAP.
    assert_eq!(market.mark_price_for_close(NOW_TS), Some(150_000_000));
}

#[test]
fn test_mark_price_for_close_falls_back_to_twap() {
    let mut market = Market::zeroed();
    market.push_twap_price(100_000_000);
    market.push_twap_price(102_000_000);
    market.last_mark_price = 0; // never cranked

    assert_eq!(market.mark_price_for_close(NOW_TS), Some(101_000_000));
}

#[test]
fn test_mark_price_for_close_none_when_uncranked_and_no_twap() {
    let market = Market::zeroed();
    assert_eq!(market.mark_price_for_close(NOW_TS), None);
}

#[test]
fn test_mark_price_for_close_rejects_stale_mark() {
    let mut market = Market::zeroed();
    market.push_twap_price(100_000_000);
    market.last_mark_price = 150_000_000;
    // Stamped 31 minutes ago — just past the 30-minute window.
    market.set_mark_price_minute(NOW_MIN - 31);

    // Stale mark must NOT silently fall back to TWAP; it errors (None).
    assert!(!market.is_mark_price_fresh(NOW_TS));
    assert_eq!(market.mark_price_for_close(NOW_TS), None);

    // Exactly at the window edge is still fresh.
    market.set_mark_price_minute(NOW_MIN - 30);
    assert_eq!(market.mark_price_for_close(NOW_TS), Some(150_000_000));
}

#[test]
fn test_mark_price_minute_roundtrip_and_unstamped_is_fresh() {
    let mut market = Market::zeroed();
    market.set_mark_price_minute(54_321);
    assert_eq!(market.mark_price_minute(), 54_321);

    // An unstamped (pre-upgrade) market is treated as fresh so closes never
    // break in the window between upgrade and the next crank.
    let mut m2 = Market::zeroed();
    m2.last_mark_price = 150_000_000;
    assert_eq!(m2.mark_price_minute(), 0);
    assert!(m2.is_mark_price_fresh(NOW_TS));
    assert_eq!(m2.mark_price_for_close(NOW_TS), Some(150_000_000));
}

#[test]
fn test_mark_price_fresh_across_u16_wraparound() {
    let mut market = Market::zeroed();
    market.last_mark_price = 150_000_000;
    // Stamp near the top of the u16 range; "now" has wrapped past 0.
    // now_min = 5, stamp = 65534 -> age = 5 - 65534 (wrapping) = 7 minutes.
    let now_ts: i64 = 5 * 60;
    market.set_mark_price_minute(65_534);
    assert!(market.is_mark_price_fresh(now_ts)); // 7 min < 30
    market.set_mark_price_minute(65_500); // age ~41 min > 30
    assert!(!market.is_mark_price_fresh(now_ts));
}

#[test]
fn test_user_account_size() {
    assert_eq!(UserAccount::LEN, 56);
}

#[test]
fn test_position_size() {
    assert_eq!(Position::LEN, 96);
}

#[test]
fn test_position_funding_index() {
    let mut pos = Position::zeroed();

    let idx: i128 = 555_444_333_222_111;
    pos.set_funding_index_snapshot(idx);
    assert_eq!(pos.get_funding_index_snapshot(), idx);
}

#[test]
fn test_position_helpers() {
    let mut pos = Position::zeroed();
    pos.size = 1_000_000_000;

    assert!(pos.is_long());
    assert!(!pos.is_short());
    assert!(!pos.is_empty());
    assert_eq!(pos.abs_size(), 1_000_000_000);

    pos.size = -500_000_000;
    assert!(!pos.is_long());
    assert!(pos.is_short());
    assert_eq!(pos.abs_size(), 500_000_000);

    pos.size = 0;
    assert!(pos.is_empty());
}

#[test]
fn test_order_slot_size() {
    assert_eq!(OrderSlot::LEN, 88);
}

#[test]
fn test_order_slot_init() {
    let mut slot = OrderSlot::zeroed();
    slot.init(
        12345,
        [7u8; 32],
        SIDE_BID,
        ORDER_TYPE_LIMIT,
        150_000_000,
        10_000_000_000,
        0,
        0, // margin_reserved
    );

    assert!(slot.is_active());
    assert!(slot.is_bid());
    assert_eq!(slot.order_id, 12345);
    assert_eq!(slot.price, 150_000_000);
    assert_eq!(slot.size, 10_000_000_000);
    assert_eq!(slot.remaining_size, 10_000_000_000);
    assert_eq!(slot.next_at_level, SENTINEL);
}

#[test]
fn test_order_slot_drain_margin_full() {
    let mut slot = OrderSlot::zeroed();
    slot.init(1, [1u8; 32], SIDE_BID, ORDER_TYPE_LIMIT, 100_000_000, 10_000, 0, 5_000_000);
    // drain for full remaining fills entire margin
    let drained = slot.drain_margin_for_fill(10_000);
    assert_eq!(drained, 5_000_000);
    assert_eq!(slot.margin_reserved, 0);
}

#[test]
fn test_order_slot_drain_margin_partial() {
    let mut slot = OrderSlot::zeroed();
    slot.init(1, [1u8; 32], SIDE_BID, ORDER_TYPE_LIMIT, 100_000_000, 10_000, 0, 5_000_000);
    // Fill 2000 of 10_000 => 20% of margin = 1_000_000
    let drained = slot.drain_margin_for_fill(2_000);
    assert_eq!(drained, 1_000_000);
    assert_eq!(slot.margin_reserved, 4_000_000);
}

#[test]
fn test_price_level_size() {
    assert_eq!(PriceLevel::LEN, 16);
}

#[test]
fn test_price_level_operations() {
    let mut level = PriceLevel::zeroed();
    assert!(level.is_empty());
    assert!(!level.is_active());

    level.init(150_000_000, 5);
    assert!(level.is_active());
    assert_eq!(level.price, 150_000_000);
    assert_eq!(level.head_slot, 5);
    assert_eq!(level.tail_slot, 5);
    assert_eq!(level.order_count, 1);

    level.append(8);
    assert_eq!(level.tail_slot, 8);
    assert_eq!(level.order_count, 2);

    level.remove_head(8);
    assert_eq!(level.head_slot, 8);
    assert_eq!(level.order_count, 1);
}

#[test]
fn test_fill_event_size() {
    assert_eq!(FillEvent::LEN, 104);
}

#[test]
fn test_trading_credit_size_and_idle() {
    assert_eq!(TradingCredit::LEN, 96);
    let mut tc = TradingCredit::zeroed();
    assert!(tc.is_idle());
    assert_eq!(tc.available(), 0);
    tc.credit = 1_000_000;
    tc.committed = 400_000;
    assert_eq!(tc.available(), 600_000);
    tc.active_orders = 1;
    assert!(!tc.is_idle());
}

#[test]
fn test_trading_credit_authorized_signer() {
    let owner = [1u8; 32];
    let session = [2u8; 32];
    let stranger = [3u8; 32];

    let mut tc = TradingCredit::zeroed();
    tc.discriminator = DISC_TRADING_CREDIT;
    tc.owner = owner;

    // Owner is always authorized regardless of session/expiry.
    assert!(tc.is_authorized_signer(&owner, 0));
    assert!(tc.is_authorized_signer(&owner, 1_000_000));

    // No session set: only the owner is authorized.
    assert!(!tc.is_authorized_signer(&session, 100));
    assert!(!tc.is_authorized_signer(&stranger, 100));

    // Set a session that expires at t=1000.
    tc.session_authority = session;
    tc.session_expiry = 1000;
    assert!(tc.is_authorized_signer(&session, 999));   // before expiry → ok
    assert!(!tc.is_authorized_signer(&session, 1000));  // at expiry → rejected
    assert!(!tc.is_authorized_signer(&session, 1500));  // after expiry → rejected
    assert!(!tc.is_authorized_signer(&stranger, 999));  // stranger never ok
    // Owner still authorized even with a session present.
    assert!(tc.is_authorized_signer(&owner, 1500));

    // Clearing the session (zero authority) revokes it even before expiry.
    tc.session_authority = [0u8; 32];
    assert!(!tc.is_authorized_signer(&[0u8; 32], 999));
}

#[test]
fn test_trigger_order_size_and_roundtrip() {
    assert_eq!(TriggerOrder::LEN, 56);
    assert_eq!(std::mem::size_of::<TriggerOrder>(), 56);

    let mut t = TriggerOrder::zeroed();
    t.discriminator = DISC_TRIGGER_ORDER;
    t.kind = TRIGGER_KIND_TAKE_PROFIT;
    t.trigger_above = 1;
    t.market_index = 3;
    t.owner = [9u8; 32];
    t.trigger_price = 75_000_000;
    t.created_ts = 1_700_000_000;

    let bytes = bytemuck::bytes_of(&t);
    let back: &TriggerOrder = bytemuck::from_bytes(bytes);
    assert_eq!(back.kind, TRIGGER_KIND_TAKE_PROFIT);
    assert_eq!(back.trigger_price, 75_000_000);
    assert_eq!(back.market_index, 3);
}

#[test]
fn test_trigger_order_condition() {
    let mut t = TriggerOrder::zeroed();
    t.trigger_price = 70_000_000;

    // trigger_above = 0: fire when mark <= price (e.g. long stop-loss)
    t.trigger_above = 0;
    assert!(t.is_met(70_000_000));
    assert!(t.is_met(69_999_999));
    assert!(!t.is_met(70_000_001));

    // trigger_above = 1: fire when mark >= price (e.g. long take-profit)
    t.trigger_above = 1;
    assert!(t.is_met(70_000_000));
    assert!(t.is_met(70_000_001));
    assert!(!t.is_met(69_999_999));
}

#[test]
fn test_liquidation_intent_size() {
    assert_eq!(LiquidationIntent::LEN, 64);
    let mut intent = LiquidationIntent::zeroed();
    intent.deadline_ts = 1000;
    assert!(!intent.is_expired(999));
    assert!(intent.is_expired(1000));
    assert!(intent.is_expired(1100));
}

#[test]
fn test_order_book_header_size() {
    assert_eq!(OrderBookHeader::LEN, 48);
}

#[test]
fn test_order_book_account_size() {
    let size = OrderBookHeader::compute_account_size(2048, 512, 4096);
    // 48 + 2048*88 + 512*16 + 512*16 + 4096*104 + 2048*2
    // = 48 + 180_224 + 8_192 + 8_192 + 425_984 + 4_096
    // = 626_736
    assert_eq!(size, 626_736);
}

#[test]
fn test_order_book_default_size() {
    let size = OrderBookHeader::default_account_size();
    assert_eq!(
        size,
        OrderBookHeader::compute_account_size(
            DEFAULT_MAX_ORDER_SLOTS,
            DEFAULT_MAX_PRICE_LEVELS,
            DEFAULT_MAX_FILL_EVENTS,
        )
    );
}
