// Simplified instruction tests - just verify data structures compile
// Full instruction testing happens in integration tests on real devnet + ER

use slipstream::state::*;

#[test]
fn test_instruction_discriminators() {
    use slipstream::instructions::*;

    assert_eq!(IX_INITIALIZE_MARKET, 0x00);
    assert_eq!(IX_INITIALIZE_USER, 0x01);
    assert_eq!(IX_DEPOSIT_COLLATERAL, 0x02);
    assert_eq!(IX_WITHDRAW_COLLATERAL, 0x03);
    assert_eq!(IX_SETTLE_TRADES, 0x04);
    assert_eq!(IX_LIQUIDATE_POSITION, 0x05);
    assert_eq!(IX_COMPUTE_FUNDING, 0x06);
    assert_eq!(IX_CLAIM_FUNDING, 0x07);
    assert_eq!(IX_CLOSE_POSITION, 0x08);
    assert_eq!(IX_DELEGATE_ORDERBOOK, 0x09);
    assert_eq!(IX_UNDELEGATE_ORDERBOOK, 0x0A);
    assert_eq!(IX_CRANK_TWAP, 0x0B);
    assert_eq!(IX_PLACE_ORDER, 0x10);
    assert_eq!(IX_CANCEL_ORDER, 0x11);
}

#[test]
fn test_order_constants() {
    assert_eq!(SIDE_BID, 0);
    assert_eq!(SIDE_ASK, 1);

    assert_eq!(ORDER_TYPE_LIMIT, 0);
    assert_eq!(ORDER_TYPE_POST_ONLY, 1);
    assert_eq!(ORDER_TYPE_IOC, 2);
    assert_eq!(ORDER_TYPE_FOK, 3);
    assert_eq!(ORDER_TYPE_MARKET, 4);
}

#[test]
fn test_seeds() {
    assert_eq!(SEED_GLOBAL, b"global");
    assert_eq!(SEED_MARKET, b"market");
    assert_eq!(SEED_USER, b"user");
    assert_eq!(SEED_POSITION, b"position");
    assert_eq!(SEED_ORDERBOOK, b"orderbook");
    assert_eq!(SEED_VAULT_AUTHORITY, b"vault_authority");
}

#[test]
fn test_discriminators() {
    assert_eq!(DISC_GLOBAL_STATE, 1);
    assert_eq!(DISC_MARKET, 2);
    assert_eq!(DISC_USER_ACCOUNT, 3);
    assert_eq!(DISC_POSITION, 4);
    assert_eq!(DISC_ORDER_BOOK, 5);
}

#[test]
fn test_default_capacities() {
    assert_eq!(DEFAULT_MAX_ORDER_SLOTS, 2048);
    assert_eq!(DEFAULT_MAX_PRICE_LEVELS, 512);
    assert_eq!(DEFAULT_MAX_FILL_EVENTS, 4096);
    assert_eq!(DEFAULT_ORDERS_PER_USER, 20);
}
