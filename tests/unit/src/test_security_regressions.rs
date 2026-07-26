//! Mollusk regression tests for the account-validation fixes.
//!
//! These are NEGATIVE tests: each one drives the real compiled program down a path
//! that used to succeed and asserts it is now rejected. They exist because the rest
//! of the suite only covers happy paths, which is precisely the blind spot that let
//! these bugs ship.
//!
//! Build the program first:
//!   cargo build-sbf --manifest-path programs/slipstream/Cargo.toml
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

fn assert_rejected(res: &mollusk_svm::result::InstructionResult, what: &str) {
    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "{what} was ACCEPTED but must be rejected"
    );
}

/// Position and TradingCredit are both 96 bytes with `owner` at offset 8, so before
/// the discriminator check on the write path, `authorize_session` (0x1B) would
/// happily treat a Position as a TradingCredit. The 40 bytes it writes
/// (session_authority + session_expiry) land on Position.collateral, realized_pnl,
/// open_slot and the funding snapshot — letting any user set their own position's
/// collateral to an arbitrary value and withdraw it.
#[test]
fn test_authorize_session_rejects_position_account() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();
    let position = Pubkey::new_unique();

    // Sanity: the layout collision that makes the attack possible is real.
    assert_eq!(Position::LEN, TradingCredit::LEN);

    let mut p = Position::zeroed();
    p.discriminator = DISC_POSITION;
    p.owner = owner.to_bytes();
    p.size = 1_000_000_000;
    p.collateral = 10 * PRICE_SCALE;

    let accounts = vec![
        (position, program_account(&program_id, bytemuck::bytes_of(&p))),
        (owner, Account::default()),
    ];

    // session_authority = 0xAA.. , expiry = i64::MAX
    let mut data = vec![0x1Bu8];
    data.extend_from_slice(&[0xAAu8; 32]);
    data.extend_from_slice(&i64::MAX.to_le_bytes());

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(position, false),
            AccountMeta::new_readonly(owner, true),
        ],
        data,
    };

    let res = m.process_instruction(&ix, &accounts);
    assert_rejected(&res, "authorize_session against a Position account");

    // And the position must be untouched.
    let after: &Position = bytemuck::from_bytes(&res.resulting_accounts[0].1.data[..Position::LEN]);
    assert_eq!(after.collateral, 10 * PRICE_SCALE);
}

/// `crank_twap` (0x0B) is permissionless and writes `last_mark_price`, which
/// close_position/execute_trigger settle against. `parse_pyth` validates neither the
/// owner nor the identity of the account it reads, so the feed must be pinned to
/// `Market.pyth_feed` or any caller can choose the settlement price outright.
#[test]
fn test_crank_twap_rejects_foreign_oracle_account() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let market = Pubkey::new_unique();
    let real_feed = Pubkey::new_unique();
    let attacker_feed = Pubkey::new_unique();

    let mut mk = Market::zeroed();
    mk.discriminator = DISC_MARKET;
    mk.pyth_feed = real_feed.to_bytes();
    mk.last_mark_price = 100 * PRICE_SCALE;

    // A PriceUpdateV2-shaped buffer (len in 134..248) quoting an absurd price.
    // Layout: price i64 @73, expo i32 @89, publish_time i64 @93.
    let mut fake = vec![0u8; 200];
    // publish_time is deliberately set to the harness clock so this reading would
    // pass the freshness gate: the ONLY thing that may reject it is the identity
    // check. A test that passes for the wrong reason pins nothing.
    fake[73..81].copy_from_slice(&(1_000_000_000i64).to_le_bytes());
    fake[89..93].copy_from_slice(&(-6i32).to_le_bytes());
    fake[93..101].copy_from_slice(&0i64.to_le_bytes());

    let accounts = vec![
        (market, program_account(&program_id, bytemuck::bytes_of(&mk))),
        (
            attacker_feed,
            Account {
                lamports: 1_000_000,
                data: fake,
                owner: Pubkey::new_unique(), // not even a Pyth-owned account
                executable: false,
                rent_epoch: 0,
            },
        ),
    ];

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(market, false),
            AccountMeta::new_readonly(attacker_feed, false),
        ],
        data: vec![0x0Bu8],
    };

    let res = m.process_instruction(&ix, &accounts);
    assert_rejected(&res, "crank_twap with an unrecognised oracle account");

    let after: &Market = bytemuck::from_bytes(&res.resulting_accounts[0].1.data[..Market::LEN]);
    assert_eq!(
        after.last_mark_price,
        100 * PRICE_SCALE,
        "mark price must not move"
    );
}
