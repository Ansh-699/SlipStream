//! Mollusk regression test for initialize_market's fee/rebate bound check.
//!
//! Before this fix, maker_rebate_bps was never checked against taker_fee_bps.
//! Since settle_trades.rs / settle_from_log.rs pay the maker rebate out of the
//! taker fee on every fill, a market created with maker_rebate_bps >
//! taker_fee_bps would mint collateral on every single trade regardless of
//! who paid what.
#![cfg(test)]

use bytemuck::Zeroable;
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

#[allow(clippy::too_many_arguments)]
fn initialize_market_ix(
    program_id: &Pubkey,
    global_state: Pubkey,
    market: Pubkey,
    order_book: Pubkey,
    quote_vault: Pubkey,
    pyth_feed: Pubkey,
    switchboard_feed: Pubkey,
    authority: Pubkey,
    taker_fee_bps: u16,
    maker_rebate_bps: u16,
) -> Instruction {
    let mut data = vec![0x00u8];
    data.extend_from_slice(&0u16.to_le_bytes()); // market_index
    data.extend_from_slice(&1_000u64.to_le_bytes()); // tick_size
    data.extend_from_slice(&100_000_000u64.to_le_bytes()); // lot_size
    data.push(20); // max_leverage
    data.extend_from_slice(&taker_fee_bps.to_le_bytes());
    data.extend_from_slice(&maker_rebate_bps.to_le_bytes());
    data.extend_from_slice(&3_600u64.to_le_bytes()); // funding_interval_secs
    data.extend_from_slice(&0u16.to_le_bytes()); // max_order_slots (0 => default)
    data.extend_from_slice(&0u16.to_le_bytes()); // max_price_levels (0 => default)
    data.extend_from_slice(&0u16.to_le_bytes()); // max_fill_events (0 => default)

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(global_state, false),
            AccountMeta::new(market, false),
            AccountMeta::new(order_book, false),
            AccountMeta::new_readonly(quote_vault, false),
            AccountMeta::new_readonly(pyth_feed, false),
            AccountMeta::new_readonly(switchboard_feed, false),
            AccountMeta::new(authority, true),
            AccountMeta::new_readonly(Pubkey::default(), false), // system_program
        ],
        data,
    }
}

/// maker_rebate_bps > taker_fee_bps must be rejected before ever creating the
/// Market/OrderBook accounts — the rebate would mint value on every fill.
#[test]
fn test_initialize_market_rejects_rebate_exceeding_taker_fee() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let authority = Pubkey::new_unique();

    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], &program_id);
    let mut global = GlobalState::zeroed();
    global.discriminator = DISC_GLOBAL_STATE;
    global.authority = authority.to_bytes();

    let accounts = vec![
        (global_pk, program_account(&program_id, bytemuck::bytes_of(&global))),
        (Pubkey::new_unique(), Account::default()),
        (Pubkey::new_unique(), Account::default()),
        (Pubkey::new_unique(), Account::default()),
        (Pubkey::new_unique(), Account::default()),
        (Pubkey::new_unique(), Account::default()),
        (authority, Account::default()),
        (Pubkey::default(), Account::default()),
    ];
    let market = accounts[1].0;
    let order_book = accounts[2].0;
    let quote_vault = accounts[3].0;
    let pyth_feed = accounts[4].0;
    let switchboard_feed = accounts[5].0;

    let ix = initialize_market_ix(
        &program_id,
        global_pk,
        market,
        order_book,
        quote_vault,
        pyth_feed,
        switchboard_feed,
        authority,
        10,  // taker_fee_bps
        20,  // maker_rebate_bps > taker_fee_bps
    );
    let res = m.process_instruction(&ix, &accounts);
    let expected = solana_program_error::ProgramError::InvalidInstructionData;
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(expected),
        "maker_rebate_bps exceeding taker_fee_bps must be rejected: {:?}",
        res.program_result
    );
}
