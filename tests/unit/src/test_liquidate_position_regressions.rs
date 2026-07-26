//! Mollusk regression test proving liquidate_position no longer drains an
//! arbitrary caller-supplied account through the unvalidated LiquidationIntent
//! cleanup path.
//!
//! Before this fix, `close_liquidation_intent` zeroed whatever account was
//! passed at the `liquidation_intent` slot and moved its lamports to the
//! liquidator with NO owner check, NO discriminator check, and NO check that it
//! belonged to this position — on the ORDINARY, successful liquidation path (and
//! the health-recovered early-exit path exercised here), not some edge case.
#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::state::*;

const PRICE_SCALE: u64 = 1_000_000;
const SOL: i64 = 1_000_000_000;

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

/// A PriceUpdateV2-shaped Pyth account (len 134..248): price@73, expo@89,
/// publish_time@93. publish_time=0 matches mollusk's default Clock (unix_timestamp
/// 0), the same pattern used in test_security_regressions.rs, so this reading is
/// FRESH, isolating the account-validation fix under test.
fn fake_pyth_account(price: i64, expo: i32) -> Vec<u8> {
    let mut data = vec![0u8; 200];
    data[73..81].copy_from_slice(&price.to_le_bytes());
    data[89..93].copy_from_slice(&expo.to_le_bytes());
    data[93..101].copy_from_slice(&0i64.to_le_bytes());
    data
}

#[test]
fn test_liquidate_position_rejects_forged_liquidation_intent_account() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();
    let liquidator = Pubkey::new_unique();

    let (market_pk, _) =
        Pubkey::find_program_address(&[SEED_MARKET, &0u16.to_le_bytes()], &program_id);
    let pyth_pk = Pubkey::new_unique();
    let switchboard_pk = Pubkey::new_unique();
    let position_pk = Pubkey::new_unique();
    let user_pk = Pubkey::new_unique();
    let system_program_pk = Pubkey::new_unique(); // not exercised on this path

    let mark = 150 * PRICE_SCALE;

    let mut mkt = Market::zeroed();
    mkt.discriminator = DISC_MARKET;
    mkt.max_leverage = 20;
    mkt.pyth_feed = pyth_pk.to_bytes();
    mkt.switchboard_feed = switchboard_pk.to_bytes();

    // A healthy, well-collateralized position: takes the health-recovered
    // early-exit branch, which also runs the LiquidationIntent cleanup.
    let mut pos = Position::zeroed();
    pos.discriminator = DISC_POSITION;
    pos.owner = owner.to_bytes();
    pos.size = SOL / 10; // 0.1 SOL
    pos.entry_price = mark;
    pos.collateral = 1_000 * PRICE_SCALE; // wildly overcollateralized -> healthy

    let mut usr = UserAccount::zeroed();
    usr.discriminator = DISC_USER_ACCOUNT;
    usr.owner = owner.to_bytes();

    // The forged "LiquidationIntent": actually a real, program-owned GlobalState
    // account (a real admin secret, in spirit) with real lamports to steal.
    let mut forged = GlobalState::zeroed();
    forged.discriminator = DISC_GLOBAL_STATE;
    forged.authority = Pubkey::new_unique().to_bytes();
    let forged_intent_pk = Pubkey::new_unique();
    let forged_account = Account {
        lamports: 5_000_000,
        data: bytemuck::bytes_of(&forged).to_vec(),
        owner: program_id,
        executable: false,
        rent_epoch: 0,
    };

    let accounts = vec![
        (market_pk, program_account(&program_id, bytemuck::bytes_of(&mkt))),
        (position_pk, program_account(&program_id, bytemuck::bytes_of(&pos))),
        (user_pk, program_account(&program_id, bytemuck::bytes_of(&usr))),
        (
            pyth_pk,
            Account {
                lamports: 1_000_000,
                data: fake_pyth_account(150_000_000, -6),
                owner: Pubkey::new_unique(),
                executable: false,
                rent_epoch: 0,
            },
        ),
        // Too short for parse_switchboard (needs len >= 104) -> triggers the
        // documented single-oracle (Pyth-only) devnet fallback.
        (
            switchboard_pk,
            Account {
                lamports: 1_000_000,
                data: vec![0u8; 10],
                owner: Pubkey::new_unique(),
                executable: false,
                rent_epoch: 0,
            },
        ),
        (forged_intent_pk, forged_account.clone()),
        (liquidator, Account::default()),
        (system_program_pk, Account::default()),
    ];

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(market_pk, false),
            AccountMeta::new(position_pk, false),
            AccountMeta::new(user_pk, false),
            AccountMeta::new_readonly(pyth_pk, false),
            AccountMeta::new_readonly(switchboard_pk, false),
            AccountMeta::new(forged_intent_pk, false),
            AccountMeta::new_readonly(liquidator, true),
            AccountMeta::new_readonly(system_program_pk, false),
        ],
        data: vec![0x05u8],
    };
    let res = m.process_instruction(&ix, &accounts);

    // The health-recovered branch calls close_liquidation_intent BEFORE it
    // returns HealthFactorAboveThreshold, so a forged account is rejected right
    // there (InvalidAccountData, from the new discriminator check) — the
    // threshold error is never reached at all. Either way the instruction must
    // fail and the forged account must be untouched; the companion test below
    // proves the same market/position/oracle setup DOES reach
    // HealthFactorAboveThreshold when the intent account is legitimately empty,
    // confirming this isn't failing upstream for an unrelated reason.
    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "a forged LiquidationIntent must not be accepted: {:?}",
        res.program_result
    );

    let forged_after = &res.resulting_accounts[5].1;
    assert_eq!(
        forged_after.data, forged_account.data,
        "the forged LiquidationIntent account's data must be untouched, not zeroed"
    );
    assert_eq!(
        forged_after.lamports, forged_account.lamports,
        "the forged account's lamports must not be drained to the liquidator"
    );
}

/// Companion to the test above: the exact same market/position/user/oracle setup,
/// but with a legitimately EMPTY intent account (the ordinary "no intent has ever
/// been created" case) must reach and return HealthFactorAboveThreshold — proving
/// the forged-account test above is rejected BY THE FIX, not by some unrelated
/// setup problem that never reaches close_liquidation_intent at all.
#[test]
fn test_liquidate_position_healthy_position_reaches_threshold_check_with_empty_intent() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();
    let liquidator = Pubkey::new_unique();

    let (market_pk, _) =
        Pubkey::find_program_address(&[SEED_MARKET, &0u16.to_le_bytes()], &program_id);
    let pyth_pk = Pubkey::new_unique();
    let switchboard_pk = Pubkey::new_unique();
    let position_pk = Pubkey::new_unique();
    let user_pk = Pubkey::new_unique();
    let system_program_pk = Pubkey::new_unique();
    let empty_intent_pk = Pubkey::new_unique();

    let mark = 150 * PRICE_SCALE;

    let mut mkt = Market::zeroed();
    mkt.discriminator = DISC_MARKET;
    mkt.max_leverage = 20;
    mkt.pyth_feed = pyth_pk.to_bytes();
    mkt.switchboard_feed = switchboard_pk.to_bytes();

    let mut pos = Position::zeroed();
    pos.discriminator = DISC_POSITION;
    pos.owner = owner.to_bytes();
    pos.size = SOL / 10;
    pos.entry_price = mark;
    pos.collateral = 1_000 * PRICE_SCALE;

    let mut usr = UserAccount::zeroed();
    usr.discriminator = DISC_USER_ACCOUNT;
    usr.owner = owner.to_bytes();

    let accounts = vec![
        (market_pk, program_account(&program_id, bytemuck::bytes_of(&mkt))),
        (position_pk, program_account(&program_id, bytemuck::bytes_of(&pos))),
        (user_pk, program_account(&program_id, bytemuck::bytes_of(&usr))),
        (
            pyth_pk,
            Account {
                lamports: 1_000_000,
                data: fake_pyth_account(150_000_000, -6),
                owner: Pubkey::new_unique(),
                executable: false,
                rent_epoch: 0,
            },
        ),
        (
            switchboard_pk,
            Account {
                lamports: 1_000_000,
                data: vec![0u8; 10],
                owner: Pubkey::new_unique(),
                executable: false,
                rent_epoch: 0,
            },
        ),
        // Genuinely empty: data_is_empty() is true, so close_liquidation_intent
        // is never even called.
        (empty_intent_pk, Account::default()),
        (liquidator, Account::default()),
        (system_program_pk, Account::default()),
    ];

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(market_pk, false),
            AccountMeta::new(position_pk, false),
            AccountMeta::new(user_pk, false),
            AccountMeta::new_readonly(pyth_pk, false),
            AccountMeta::new_readonly(switchboard_pk, false),
            AccountMeta::new(empty_intent_pk, false),
            AccountMeta::new_readonly(liquidator, true),
            AccountMeta::new_readonly(system_program_pk, false),
        ],
        data: vec![0x05u8],
    };
    let res = m.process_instruction(&ix, &accounts);

    let expected = solana_program_error::ProgramError::Custom(
        slipstream::error::SlipstreamError::HealthFactorAboveThreshold as u32,
    );
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(expected),
        "the same setup must reach the health check and report the position as healthy"
    );
}
