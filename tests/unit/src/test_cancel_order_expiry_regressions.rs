//! Mollusk regression tests for cancel_order's permissionless-expiry-cancel fix.
//!
//! Before this fix, cancel_order required `credit.is_authorized_signer` (the
//! owner or a non-expired session key) unconditionally — a keeper with no
//! owner signature and no session key could never cancel anyone's expired
//! order, so expiry_ts was entirely unenforced on-chain (the expiry keeper was
//! a documented no-op stub for exactly this reason). This adds a bypass: ANY
//! signer may cancel a specific order once its own `expiry_ts` has passed,
//! with the freed margin still returning to the real owner's credit, never to
//! the canceller.
#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::state::*;

const NOW: i64 = 1_700_000_000;

fn mollusk(program_id: &Pubkey) -> Mollusk {
    std::env::set_var(
        "SBF_OUT_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy"),
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
    header.free_slot_count = max_slots;
    header.next_order_id = 2;
    header.next_fill_sequence = 1;
    data
}

/// A single resting BID owned by `owner`, order_id=1, with the given expiry_ts.
fn order_book_with_resting_bid(owner: &Pubkey, price: u64, size: u64, margin: u64, expiry_ts: i64) -> Vec<u8> {
    let mut data = order_book_data(0, 4, 2, 4);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();
    let slot_idx = ob.alloc_slot().unwrap();
    ob.order_slots[slot_idx as usize].init(1, owner.to_bytes(), SIDE_BID, ORDER_TYPE_LIMIT, price, size, expiry_ts, margin);
    ob.insert_bid_level(price, slot_idx).unwrap();
    data
}

fn credit_account(program_id: &Pubkey, owner: &Pubkey, credit: u64, committed: u64) -> Account {
    let mut c = TradingCredit::zeroed();
    c.discriminator = DISC_TRADING_CREDIT;
    c.owner = owner.to_bytes();
    c.market_index = 0;
    c.credit = credit;
    c.committed = committed;
    c.active_orders = 1;
    program_account(program_id, bytemuck::bytes_of(&c))
}

fn cancel_order_ix(
    program_id: &Pubkey,
    order_book: Pubkey,
    trading_credit: Pubkey,
    signer: Pubkey,
    order_id: u64,
) -> Instruction {
    let mut data = vec![0x11u8];
    data.extend_from_slice(&order_id.to_le_bytes());
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(order_book, false),
            AccountMeta::new(trading_credit, false),
            AccountMeta::new_readonly(signer, true),
        ],
        data,
    }
}

/// A random signer with no owner/session relationship to the order can cancel
/// it once expiry_ts has passed, and the freed margin lands back on the real
/// owner's credit — not the canceller's.
#[test]
fn test_cancel_order_permissionless_after_expiry() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();
    let random_keeper = Pubkey::new_unique(); // no signer relationship to `owner`

    let (order_book, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let trading_credit_pk = Pubkey::new_unique();

    let margin = 500_000u64;
    let ob_data = order_book_with_resting_bid(&owner, 150_000_000, 100_000_000, margin, NOW - 100);
    let credit_acc = credit_account(&program_id, &owner, 1_000_000, margin);

    let accounts = vec![
        (order_book, program_account(&program_id, &ob_data)),
        (trading_credit_pk, credit_acc),
        (random_keeper, Account::default()),
    ];

    let ix = cancel_order_ix(&program_id, order_book, trading_credit_pk, random_keeper, 1);
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "a random signer must be able to cancel an EXPIRED order: {:?}",
        res.program_result
    );

    let credit: &TradingCredit =
        bytemuck::from_bytes(&res.resulting_accounts[1].1.data[..TradingCredit::LEN]);
    assert_eq!(credit.committed, 0, "margin must be released back to the owner's credit");
    assert_eq!(credit.active_orders, 0);
    assert_eq!(credit.owner, owner.to_bytes(), "credit must still belong to the real owner");
}

/// The same random signer must NOT be able to cancel an order that has not
/// yet expired — the permissionless path is strictly gated on expiry_ts.
#[test]
fn test_cancel_order_rejects_random_signer_before_expiry() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();
    let random_keeper = Pubkey::new_unique();

    let (order_book, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let trading_credit_pk = Pubkey::new_unique();

    let margin = 500_000u64;
    let ob_data = order_book_with_resting_bid(&owner, 150_000_000, 100_000_000, margin, NOW + 100);
    let credit_acc = credit_account(&program_id, &owner, 1_000_000, margin);

    let accounts = vec![
        (order_book, program_account(&program_id, &ob_data)),
        (trading_credit_pk, credit_acc),
        (random_keeper, Account::default()),
    ];

    let ix = cancel_order_ix(&program_id, order_book, trading_credit_pk, random_keeper, 1);
    let res = m.process_instruction(&ix, &accounts);
    let expected = solana_program_error::ProgramError::Custom(
        slipstream::error::SlipstreamError::InvalidAuthority as u32,
    );
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(expected),
        "a random signer must NOT cancel a not-yet-expired order: {:?}",
        res.program_result
    );
}

/// An order with expiry_ts == 0 (never expires) must never be cancellable by a
/// random signer, no matter how far the clock advances.
#[test]
fn test_cancel_order_rejects_random_signer_when_never_expires() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();
    let random_keeper = Pubkey::new_unique();

    let (order_book, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let trading_credit_pk = Pubkey::new_unique();

    let margin = 500_000u64;
    let ob_data = order_book_with_resting_bid(&owner, 150_000_000, 100_000_000, margin, 0);
    let credit_acc = credit_account(&program_id, &owner, 1_000_000, margin);

    let accounts = vec![
        (order_book, program_account(&program_id, &ob_data)),
        (trading_credit_pk, credit_acc),
        (random_keeper, Account::default()),
    ];

    let ix = cancel_order_ix(&program_id, order_book, trading_credit_pk, random_keeper, 1);
    let res = m.process_instruction(&ix, &accounts);
    let expected = solana_program_error::ProgramError::Custom(
        slipstream::error::SlipstreamError::InvalidAuthority as u32,
    );
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(expected),
        "expiry_ts == 0 must mean 'never expires', not 'always cancellable': {:?}",
        res.program_result
    );
}

/// The owner can still cancel their own order at any time, expired or not —
/// the new bypass must not have narrowed the existing owner path.
#[test]
fn test_cancel_order_owner_still_works_regardless_of_expiry() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();

    let (order_book, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let trading_credit_pk = Pubkey::new_unique();

    let margin = 500_000u64;
    // Not expired (expiry_ts in the future) — owner must still be able to cancel.
    let ob_data = order_book_with_resting_bid(&owner, 150_000_000, 100_000_000, margin, NOW + 100);
    let credit_acc = credit_account(&program_id, &owner, 1_000_000, margin);

    let accounts = vec![
        (order_book, program_account(&program_id, &ob_data)),
        (trading_credit_pk, credit_acc),
        (owner, Account::default()),
    ];

    let ix = cancel_order_ix(&program_id, order_book, trading_credit_pk, owner, 1);
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "the owner must still be able to cancel their own order: {:?}",
        res.program_result
    );
}
