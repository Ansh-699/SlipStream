//! Mollusk test proving the global pause switch, wired up for the first time in
//! this change, actually blocks a trading instruction.
//!
//! Before this fix, `ensure_not_globally_paused` (programs/slipstream/src/
//! instructions/mod.rs) was defined but had ZERO call sites anywhere in the
//! program — the emergency kill switch `emergency_undelegate` sets gated
//! nothing at all.
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

fn place_order_ix(
    program_id: &Pubkey,
    market: Pubkey,
    order_book: Pubkey,
    credit: Pubkey,
    signer: Pubkey,
    global_state: Pubkey,
) -> Instruction {
    let mut data = vec![0x10u8];
    data.push(SIDE_BID);
    data.push(ORDER_TYPE_LIMIT);
    data.extend_from_slice(&(1_000u64).to_le_bytes());
    data.extend_from_slice(&(100_000_000u64).to_le_bytes());
    data.extend_from_slice(&0i64.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
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

fn setup(paused: u8) -> (Pubkey, Pubkey, Pubkey, Pubkey, Pubkey, Pubkey, Vec<(Pubkey, Account)>) {
    let program_id = Pubkey::new_unique();
    let signer = Pubkey::new_unique();
    let (market, _) = Pubkey::find_program_address(&[SEED_MARKET, &0u16.to_le_bytes()], &program_id);
    let (order_book, _) =
        Pubkey::find_program_address(&[SEED_ORDERBOOK, &0u16.to_le_bytes()], &program_id);
    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], &program_id);
    let credit_pk = Pubkey::new_unique();

    let mut mkt = Market::zeroed();
    mkt.discriminator = DISC_MARKET;
    mkt.max_leverage = 20;
    mkt.tick_size = 1_000;
    mkt.lot_size = 100_000_000;
    mkt.last_mark_price = 150 * PRICE_SCALE;

    let ob_size = OrderBookHeader::compute_account_size(4, 2, 4);
    let mut ob_data = vec![0u8; ob_size];
    {
        let header: &mut OrderBookHeader = bytemuck::from_bytes_mut(&mut ob_data[..OrderBookHeader::LEN]);
        header.discriminator = DISC_ORDER_BOOK;
        header.market_index = 0;
        header.orders_per_user = DEFAULT_ORDERS_PER_USER;
        header.max_order_slots = 4;
        header.max_price_levels_per_side = 2;
        header.max_fill_events = 4;
        header.free_slot_count = 4;
        header.next_order_id = 1;
        header.next_fill_sequence = 1;
    }

    let mut credit = TradingCredit::zeroed();
    credit.discriminator = DISC_TRADING_CREDIT;
    credit.owner = signer.to_bytes();
    credit.credit = 10 * PRICE_SCALE;

    let mut global = GlobalState::zeroed();
    global.discriminator = DISC_GLOBAL_STATE;
    global.paused = paused;

    let accounts = vec![
        (market, program_account(&program_id, bytemuck::bytes_of(&mkt))),
        (order_book, program_account(&program_id, &ob_data)),
        (credit_pk, program_account(&program_id, bytemuck::bytes_of(&credit))),
        (signer, Account::default()),
        (global_pk, program_account(&program_id, bytemuck::bytes_of(&global))),
    ];
    (program_id, market, order_book, credit_pk, signer, global_pk, accounts)
}

#[test]
fn test_place_order_rejected_while_globally_paused() {
    let (program_id, market, order_book, credit_pk, signer, global_pk, accounts) = setup(1);
    let m = mollusk(&program_id);
    let ix = place_order_ix(&program_id, market, order_book, credit_pk, signer, global_pk);
    let res = m.process_instruction(&ix, &accounts);

    let expected = solana_program_error::ProgramError::Custom(
        slipstream::error::SlipstreamError::GlobalPaused as u32,
    );
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(expected),
        "place_order must be rejected with GlobalPaused while the protocol is paused"
    );
}

#[test]
fn test_place_order_succeeds_when_not_paused() {
    let (program_id, market, order_book, credit_pk, signer, global_pk, accounts) = setup(0);
    let m = mollusk(&program_id);
    let ix = place_order_ix(&program_id, market, order_book, credit_pk, signer, global_pk);
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "place_order must succeed normally when not paused: {:?}",
        res.program_result
    );
}
