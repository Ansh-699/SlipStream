//! Mollusk regression tests for `update_position`'s reduce/flatten accounting.
//!
//! Before this fix, a fill that reduced or flattened a position unconditionally
//! ADDED the fill's margin to `Position.collateral` and never released anything:
//! the position's original collateral plus every `realized_pnl` ever accrued
//! became permanently unreachable once size hit 0 (close_position and
//! liquidate_position both reject on `pos.is_empty()`), and any margin
//! `place_order` charged for what turned out to be a reducing fill was never
//! refunded either.
#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::state::*;

const PRICE_SCALE: u64 = 1_000_000;
const SOL: u64 = 1_000_000_000;

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

fn market_account(program_id: &Pubkey) -> Account {
    let mut m = Market::zeroed();
    m.discriminator = DISC_MARKET;
    m.market_index = 0;
    m.max_leverage = 20;
    m.taker_fee_bps = 10;
    m.maker_rebate_bps = 5;
    m.tick_size = 1_000;
    m.lot_size = 100_000_000;
    // last_settled_sequence() reads _padding2, left zero -> cursor starts at 0.
    program_account(program_id, bytemuck::bytes_of(&m))
}

/// A tiny (empty) order book whose committed fill ring holds exactly one fill.
fn order_book_with_one_fill(fill: FillEvent) -> Vec<u8> {
    let max_slots = 2u16;
    let max_levels = 2u16;
    let max_fills = 4u16;
    let size = OrderBookHeader::compute_account_size(max_slots, max_levels, max_fills);
    let mut data = vec![0u8; size];
    {
        let header: &mut OrderBookHeader = bytemuck::from_bytes_mut(&mut data[..OrderBookHeader::LEN]);
        header.discriminator = DISC_ORDER_BOOK;
        header.bump = 1;
        header.market_index = 0;
        header.max_order_slots = max_slots;
        header.max_price_levels_per_side = max_levels;
        header.max_fill_events = max_fills;
        header.free_slot_count = max_slots;
        header.next_order_id = 1;
        header.next_fill_sequence = 2;
        header.fill_event_head = 0;
        header.fill_event_count = 1;
    }
    let fills_base = OrderBookHeader::LEN
        + (max_slots as usize) * OrderSlot::LEN
        + (max_levels as usize) * PriceLevel::LEN * 2;
    data[fills_base..fills_base + FillEvent::LEN].copy_from_slice(bytemuck::bytes_of(&fill));
    data
}

fn user_account(program_id: &Pubkey, owner: &Pubkey, free: u64) -> Account {
    let mut u = UserAccount::zeroed();
    u.discriminator = DISC_USER_ACCOUNT;
    u.owner = owner.to_bytes();
    u.free_collateral = free;
    program_account(program_id, bytemuck::bytes_of(&u))
}

fn position_account(
    program_id: &Pubkey,
    owner: &Pubkey,
    size: i64,
    entry: u64,
    collateral: u64,
) -> Account {
    let mut p = Position::zeroed();
    p.discriminator = DISC_POSITION;
    p.owner = owner.to_bytes();
    p.market_index = 0;
    p.size = size;
    p.entry_price = entry;
    p.collateral = collateral;
    program_account(program_id, bytemuck::bytes_of(&p))
}

fn global_state_account(program_id: &Pubkey) -> (Pubkey, Account) {
    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    let mut g = GlobalState::zeroed();
    g.discriminator = DISC_GLOBAL_STATE;
    (global_pk, program_account(program_id, bytemuck::bytes_of(&g)))
}

#[allow(clippy::too_many_arguments)]
fn settle_trades_ix(
    program_id: &Pubkey,
    market: Pubkey,
    order_book: Pubkey,
    global_state: Pubkey,
    maker_user: Pubkey,
    taker_user: Pubkey,
    maker_pos: Pubkey,
    taker_pos: Pubkey,
) -> Instruction {
    let mut data = vec![0x04u8];
    data.extend_from_slice(&1u16.to_le_bytes()); // num_fills
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(market, false),
            AccountMeta::new_readonly(order_book, false),
            AccountMeta::new_readonly(global_state, false),
            AccountMeta::new(maker_user, false),
            AccountMeta::new(taker_user, false),
            AccountMeta::new(maker_pos, false),
            AccountMeta::new(taker_pos, false),
        ],
        data,
    }
}

/// A fill that exactly flattens the maker's existing long at no PnL (fill price
/// == entry price) must release ALL of the position's collateral plus the
/// margin refund into the owner's free_collateral, and leave Position.collateral
/// at zero — not stranded.
#[test]
fn test_reduce_to_flat_releases_collateral_instead_of_stranding_it() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let maker = Pubkey::new_unique();
    let taker = Pubkey::new_unique();

    let (market, _) = Pubkey::find_program_address(&[SEED_MARKET, &0u16.to_le_bytes()], &program_id);
    let (order_book, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let maker_user_pk = Pubkey::new_unique();
    let taker_user_pk = Pubkey::new_unique();
    let maker_pos_pk = Pubkey::new_unique();
    let taker_pos_pk = Pubkey::new_unique();

    let entry = 150 * PRICE_SCALE;
    let size = SOL / 10; // 0.1 SOL, one lot
    let existing_collateral = 1_000_000u64;
    let fill_margin = 500_000u64;

    let fill = FillEvent {
        sequence: 1,
        maker: maker.to_bytes(),
        taker: taker.to_bytes(),
        price: entry, // same as entry -> zero PnL, isolates the release/refund math
        quantity: size,
        filled_margin: fill_margin,
        taker_fee_bps_snapshot: 10,
        maker_rebate_bps_snapshot: 5,
        maker_side: SIDE_ASK, // maker's resting order was an ASK -> reduces a long
        _pad: [0u8; 3],
    };

    let (global_pk, global_acc) = global_state_account(&program_id);

    let accounts = vec![
        (market, market_account(&program_id)),
        (order_book, program_account(&program_id, &order_book_with_one_fill(fill))),
        (global_pk, global_acc),
        (maker_user_pk, user_account(&program_id, &maker, 0)),
        (taker_user_pk, user_account(&program_id, &taker, 0)),
        (
            maker_pos_pk,
            position_account(&program_id, &maker, size as i64, entry, existing_collateral),
        ),
        (taker_pos_pk, position_account(&program_id, &taker, 0, 0, 0)),
    ];

    let ix = settle_trades_ix(
        &program_id,
        market,
        order_book,
        global_pk,
        maker_user_pk,
        taker_user_pk,
        maker_pos_pk,
        taker_pos_pk,
    );
    let res = m.process_instruction(&ix, &accounts);
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);

    let maker_pos: &Position =
        bytemuck::from_bytes(&res.resulting_accounts[5].1.data[..Position::LEN]);
    assert_eq!(maker_pos.size, 0, "position must be fully flattened");
    assert_eq!(
        maker_pos.collateral, 0,
        "flattened position must not retain any stranded collateral"
    );

    let maker_user: &UserAccount =
        bytemuck::from_bytes(&res.resulting_accounts[3].1.data[..UserAccount::LEN]);
    // settle_trades separately credits the maker rebate (apply_bps(notional, 5bps) on a
    // $15 notional fill = 7_500) into the same free_collateral — additive to, not
    // instead of, the release/refund this test targets.
    let notional = 15_000_000u64; // compute_notional(0.1 SOL, $150)
    let maker_rebate = notional * 5 / 10_000;
    assert_eq!(
        maker_user.free_collateral,
        existing_collateral + fill_margin + maker_rebate,
        "released collateral + refunded fill margin + maker rebate must reach free_collateral, not vanish"
    );
}
