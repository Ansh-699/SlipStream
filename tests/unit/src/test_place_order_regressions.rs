//! Mollusk regression tests for the place_order fixes: forged Market account and
//! the reduce_only margin/debit bypass.
#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::state::*;

const PRICE_SCALE: u64 = 1_000_000;

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

fn market_account(program_id: &Pubkey, market_index: u16) -> Account {
    let mut m = Market::zeroed();
    m.discriminator = DISC_MARKET;
    m.market_index = market_index;
    m.max_leverage = 20;
    m.taker_fee_bps = 10;
    m.maker_rebate_bps = 5;
    m.tick_size = 1_000;
    m.lot_size = 100_000_000; // 0.1 SOL
    m.last_mark_price = 150 * PRICE_SCALE;
    program_account(program_id, bytemuck::bytes_of(&m))
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
    header.next_order_id = 1;
    header.next_fill_sequence = 1;
    data
}

/// A resting BID at `price` for `size`, owned by `maker`, with `margin` reserved —
/// the value an attacker's fill would drain.
fn order_book_with_resting_bid(
    market_index: u16,
    maker: &Pubkey,
    price: u64,
    size: u64,
    margin: u64,
) -> Vec<u8> {
    let mut data = order_book_data(market_index, 8, 4, 8);
    let mut ob = OrderBookView::from_account_data(&mut data).unwrap();
    let slot_idx = ob.alloc_slot().unwrap();
    ob.order_slots[slot_idx as usize].init(1, maker.to_bytes(), SIDE_BID, ORDER_TYPE_LIMIT, price, size, 0, margin);
    ob.insert_bid_level(price, slot_idx).unwrap();
    data
}

fn credit_account(program_id: &Pubkey, owner: &Pubkey, market_index: u16, credit: u64) -> Account {
    let mut c = TradingCredit::zeroed();
    c.discriminator = DISC_TRADING_CREDIT;
    c.owner = owner.to_bytes();
    c.market_index = market_index;
    c.credit = credit;
    program_account(program_id, bytemuck::bytes_of(&c))
}

fn global_state_account(program_id: &Pubkey) -> (Pubkey, Account) {
    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    let mut g = GlobalState::zeroed();
    g.discriminator = DISC_GLOBAL_STATE;
    (global_pk, program_account(program_id, bytemuck::bytes_of(&g)))
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
    reduce_only: bool,
) -> Instruction {
    let mut data = vec![0x10u8];
    data.push(side);
    data.push(order_type);
    data.extend_from_slice(&price.to_le_bytes());
    data.extend_from_slice(&size.to_le_bytes());
    data.extend_from_slice(&0i64.to_le_bytes()); // expiry_ts
    data.extend_from_slice(&0u16.to_le_bytes()); // max_slippage_bps
    data.push(reduce_only as u8);
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

/// place_order's `market_acc` was never checked for ownership or canonical PDA —
/// any account with byte 0 == DISC_MARKET and attacker-chosen max_leverage /
/// taker_fee_bps / maker_rebate_bps would be trusted verbatim, including by
/// settlement, which stamps those bps straight into every FillEvent.
#[test]
fn test_place_order_rejects_forged_market_account() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let taker = Pubkey::new_unique();
    let order_book = Pubkey::new_unique();
    let credit_pda = Pubkey::new_unique();

    // A forged Market: right discriminator and byte layout, but NOT owned by the
    // program (an attacker's own account, or one created via a foreign program).
    let mut forged = Market::zeroed();
    forged.discriminator = DISC_MARKET;
    forged.max_leverage = 255; // attacker maximizes leverage to defeat the margin gate
    forged.maker_rebate_bps = u16::MAX; // and rebate, to mint collateral on settlement
    forged.tick_size = 1;
    forged.lot_size = 1;
    let forged_market_acc = Account {
        lamports: 10_000_000,
        data: bytemuck::bytes_of(&forged).to_vec(),
        owner: Pubkey::new_unique(), // NOT the program
        executable: false,
        rent_epoch: 0,
    };

    let ob_data = order_book_data(0, 4, 2, 4);
    let credit_acc = credit_account(&program_id, &taker, 0, 10 * PRICE_SCALE);
    let (global_pk, global_acc) = global_state_account(&program_id);

    let accounts = vec![
        (Pubkey::new_unique(), forged_market_acc),
        (order_book, program_account(&program_id, &ob_data)),
        (credit_pda, credit_acc),
        (taker, Account::default()),
        (global_pk, global_acc),
    ];
    let market_key = accounts[0].0;

    let ix = place_order_ix(
        &program_id,
        market_key,
        order_book,
        credit_pda,
        taker,
        global_pk,
        SIDE_BID,
        ORDER_TYPE_LIMIT,
        1_000,
        100_000_000,
        false,
    );
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "place_order accepted a forged (non-program-owned) Market account: {:?}",
        res.program_result
    );
}

/// reduce_only used to skip BOTH the margin availability gate and the taker debit,
/// trusting an unverifiable client-supplied flag. An account with ZERO funded
/// credit could set reduce_only=1 and cross a real maker's resting order, draining
/// the maker's margin into a free position. This asserts that path is now rejected.
#[test]
fn test_place_order_reduce_only_no_longer_bypasses_margin_gate() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let maker = Pubkey::new_unique();
    let taker = Pubkey::new_unique();

    let (market, _) = Pubkey::find_program_address(&[SEED_MARKET, &0u16.to_le_bytes()], &program_id);
    let (order_book, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let credit_pda = Pubkey::new_unique();

    let market_acc = market_account(&program_id, 0);
    // Real resting bid: 1 lot @ $150, with realistic reserved margin.
    let rest_price = 150 * PRICE_SCALE;
    let rest_size = 100_000_000u64; // 0.1 SOL, one lot
    let rest_margin = 750_000u64; // ~ notional/leverage
    let ob_data = order_book_with_resting_bid(0, &maker, rest_price, rest_size, rest_margin);

    // Taker has ZERO funded credit — the exploit's entire premise.
    let credit_acc = credit_account(&program_id, &taker, 0, 0);
    let (global_pk, global_acc) = global_state_account(&program_id);

    let accounts = vec![
        (market, market_acc),
        (order_book, program_account(&program_id, &ob_data)),
        (credit_pda, credit_acc),
        (taker, Account::default()),
        (global_pk, global_acc),
    ];

    // Taker SELLS at the minimum tick — far below the resting bid, so it crosses —
    // with reduce_only=1 and the exact resting size so it fully drains the slot.
    let ix = place_order_ix(
        &program_id,
        market,
        order_book,
        credit_pda,
        taker,
        global_pk,
        SIDE_ASK,
        ORDER_TYPE_LIMIT,
        1_000, // market.tick_size, the minimum
        rest_size,
        true, // reduce_only
    );
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "reduce_only order with zero credit was accepted and allowed to cross a funded maker: {:?}",
        res.program_result
    );
}

/// Same scenario as above but reduce_only=0, to confirm the underlying real-money
/// path (a properly-margined taker crossing a real maker) still works — the fix
/// must not have broken ordinary trading.
#[test]
fn test_place_order_normal_fill_still_works() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let maker = Pubkey::new_unique();
    let taker = Pubkey::new_unique();

    let (market, _) = Pubkey::find_program_address(&[SEED_MARKET, &0u16.to_le_bytes()], &program_id);
    let (order_book, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let credit_pda = Pubkey::new_unique();

    let market_acc = market_account(&program_id, 0);
    let rest_price = 150 * PRICE_SCALE;
    let rest_size = 100_000_000u64;
    let rest_margin = 750_000u64;
    let ob_data = order_book_with_resting_bid(0, &maker, rest_price, rest_size, rest_margin);

    // Taker funds enough real credit to cover the fill at the crossing price.
    let credit_acc = credit_account(&program_id, &taker, 0, 10 * PRICE_SCALE);
    let (global_pk, global_acc) = global_state_account(&program_id);

    let accounts = vec![
        (market, market_acc),
        (order_book, program_account(&program_id, &ob_data)),
        (credit_pda, credit_acc),
        (taker, Account::default()),
        (global_pk, global_acc),
    ];

    let ix = place_order_ix(
        &program_id,
        market,
        order_book,
        credit_pda,
        taker,
        global_pk,
        SIDE_ASK,
        ORDER_TYPE_LIMIT,
        1_000,
        rest_size,
        false,
    );
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "a properly-funded normal fill should succeed: {:?}",
        res.program_result
    );

    let credit: &TradingCredit =
        bytemuck::from_bytes(&res.resulting_accounts[2].1.data[..TradingCredit::LEN]);
    assert!(
        credit.credit < 10 * PRICE_SCALE,
        "taker's credit must be debited for the real fill"
    );
}
