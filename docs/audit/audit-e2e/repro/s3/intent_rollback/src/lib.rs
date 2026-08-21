//! Scratch audit reproduction for run `audit-e2e`, slice S3, class S3-C9.
//!
//! Claim under test: the health-recovered branch of `liquidate_position`
//! (`programs/slipstream/src/instructions/liquidate_position.rs:157-163`) calls
//! `close_liquidation_intent` (`:337-362`) — which zeroes the account data at
//! `:352-355` and moves its lamports at `:357-361` — and then returns `Err` at
//! `:162`. The `Err` discards every account write the instruction made, so the
//! clear never persists and the `LiquidationIntent` survives the recovery.
//!
//! This crate is NOT part of the product workspace and is never run by
//! `cargo test --workspace`. Run explicitly:
//!   cargo build-sbf --manifest-path programs/slipstream/Cargo.toml
//!   CARGO_TARGET_DIR=/tmp/s3-intent-repro cargo test --manifest-path \
//!     docs/audit/audit-e2e/repro/s3/intent_rollback/Cargo.toml -- --nocapture

#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;

use slipstream::error::SlipstreamError;
use slipstream::state::*;

const PRICE_SCALE: u64 = 1_000_000;
const SOL: i64 = 1_000_000_000;
const IX_LIQUIDATE_POSITION: u8 = 0x05;
const INTENT_LAMPORTS: u64 = 5_000_000;

fn mollusk(program_id: &Pubkey) -> Mollusk {
    std::env::set_var(
        "SBF_OUT_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../../../target/deploy"),
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

/// PriceUpdateV2-shaped Pyth account, copied from
/// `tests/unit/src/test_liquidate_position_regressions.rs:46-54`:
/// verification_level@40 (1 = Full), price@73, conf@81 (0), expo@89,
/// publish_time@93 (0, matching mollusk's default Clock -> fresh).
fn fake_pyth_account(price: i64, expo: i32) -> Vec<u8> {
    let mut data = vec![0u8; 200];
    data[40] = 1;
    data[73..81].copy_from_slice(&price.to_le_bytes());
    data[89..93].copy_from_slice(&expo.to_le_bytes());
    data[93..101].copy_from_slice(&0i64.to_le_bytes());
    data
}

fn err(e: SlipstreamError) -> ProgramError {
    ProgramError::Custom(e as u32)
}

/// Builds the health-recovered scenario with a real `LiquidationIntent` sitting
/// at the canonical `[SEED_LIQ_INTENT, position]` PDA. `intent_position` lets the
/// caller point the intent at a DIFFERENT position, which makes
/// `close_liquidation_intent` bail at `:347-349` instead of reaching its write —
/// that is the control case that proves the write is reached in the main case.
fn run(intent_position: Option<Pubkey>) -> (MolluskResult, Account, Account) {
    // FIXED, not new_unique(): every run must derive the SAME market PDA, so the
    // market-identity check at liquidate_position.rs:71-78 — which also returns
    // InvalidPda — behaves identically in both cases. The main case proves that
    // check passes (it reaches :162), so an InvalidPda in the control can only
    // have come from :347-349. It also makes the compute-unit counts comparable.
    let program_id = Pubkey::new_from_array([7u8; 32]);
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();
    let liquidator = Pubkey::new_unique();

    let (market_pk, _) =
        Pubkey::find_program_address(&[SEED_MARKET, &0u16.to_le_bytes()], &program_id);
    let pyth_pk = Pubkey::new_unique();
    let switchboard_pk = Pubkey::new_unique();
    let position_pk = Pubkey::new_unique();
    let user_pk = Pubkey::new_unique();
    let system_program_pk = Pubkey::new_unique(); // not reached on this path

    let (intent_pk, bump) =
        Pubkey::find_program_address(&[SEED_LIQ_INTENT, position_pk.as_ref()], &program_id);

    let mark = 150 * PRICE_SCALE;

    let mut mkt = Market::zeroed();
    mkt.discriminator = DISC_MARKET;
    mkt.max_leverage = 20;
    mkt.pyth_feed = pyth_pk.to_bytes();
    mkt.switchboard_feed = switchboard_pk.to_bytes();

    // Wildly overcollateralized -> health >= threshold -> the recovery branch
    // at liquidate_position.rs:157.
    let mut pos = Position::zeroed();
    pos.discriminator = DISC_POSITION;
    pos.owner = owner.to_bytes();
    pos.size = SOL / 10;
    pos.entry_price = mark;
    pos.collateral = 1_000 * PRICE_SCALE;

    let mut usr = UserAccount::zeroed();
    usr.discriminator = DISC_USER_ACCOUNT;
    usr.owner = owner.to_bytes();

    // A genuine intent, exactly as `handle_grace_window` writes it at
    // liquidate_position.rs:297-304.
    let mut intent = LiquidationIntent::zeroed();
    intent.discriminator = DISC_LIQUIDATION_INTENT;
    intent.bump = bump;
    intent.position = intent_position.unwrap_or(position_pk).to_bytes();
    intent.created_ts = 0;
    intent.deadline_ts = LiquidationIntent::GRACE_WINDOW_SECS;
    intent.initial_health_factor = 900_000;

    let intent_account = Account {
        lamports: INTENT_LAMPORTS,
        data: bytemuck::bytes_of(&intent).to_vec(),
        owner: program_id,
        executable: false,
        rent_epoch: 0,
    };
    let liquidator_account = Account {
        lamports: 1_000_000_000,
        ..Account::default()
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
        // Too short for parse_switchboard -> documented Pyth-only fallback.
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
        (intent_pk, intent_account.clone()),
        (liquidator, liquidator_account.clone()),
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
            AccountMeta::new(intent_pk, false),
            AccountMeta::new(liquidator, true),
            AccountMeta::new_readonly(system_program_pk, false),
        ],
        data: vec![IX_LIQUIDATE_POSITION],
    };

    let res = m.process_instruction(&ix, &accounts);
    println!("compute units consumed: {}", res.compute_units_consumed);
    let intent_after = res.resulting_accounts[5].1.clone();
    let liquidator_after = res.resulting_accounts[6].1.clone();
    (res.program_result, intent_after, liquidator_after)
}

/// Control: with the intent pointing at a different position,
/// `close_liquidation_intent` returns InvalidPda from its check at :347-349,
/// BEFORE the zeroing loop at :352-355. Getting a different error code here than
/// in the main case is what proves the main case runs past that check and
/// executes the write.
#[test]
fn control_close_bails_before_the_write_on_position_mismatch() {
    let (result, intent_after, liquidator_after) = run(Some(Pubkey::new_unique()));
    assert_eq!(
        result,
        MolluskResult::Failure(err(SlipstreamError::InvalidPda)),
        "expected the position-match check at :347-349 to reject, got {:?}",
        result
    );
    assert_eq!(intent_after.lamports, INTENT_LAMPORTS);
    assert_eq!(liquidator_after.lamports, 1_000_000_000);
}

/// The finding: the recovery branch runs `close_liquidation_intent` to
/// completion (data zeroed at :352-355, lamports moved at :357-361) and then
/// returns `Err(HealthFactorAboveThreshold)` at :162. The `Err` discards the
/// whole transaction's account writes, so the intent is still there afterwards,
/// discriminator intact and lamports intact.
#[test]
fn recovery_branch_clear_is_reverted_by_its_own_err() {
    let (result, intent_after, liquidator_after) = run(None);

    // Different error code than the control => execution got PAST :347-349 and
    // through the zero + lamport move, and the Err came from :162 instead.
    assert_eq!(
        result,
        MolluskResult::Failure(err(SlipstreamError::HealthFactorAboveThreshold)),
        "expected the recovery branch at :157-163, got {:?}",
        result
    );

    assert_eq!(
        intent_after.data[0],
        DISC_LIQUIDATION_INTENT,
        "the intent must have been zeroed by :352-355 and then restored by the \
         Err at :162 — data[0] is {} (0 would mean the clear persisted)",
        intent_after.data[0]
    );
    let reloaded: &LiquidationIntent = bytemuck::from_bytes(&intent_after.data[..LiquidationIntent::LEN]);
    assert_eq!(
        reloaded.deadline_ts,
        LiquidationIntent::GRACE_WINDOW_SECS,
        "the stale deadline survives, so is_expired(now) is true on the next call"
    );
    assert_eq!(
        intent_after.lamports, INTENT_LAMPORTS,
        "the rent lamports were never actually reclaimed either"
    );
    assert_eq!(liquidator_after.lamports, 1_000_000_000);

    println!(
        "intent after recovery call: disc={} deadline_ts={} lamports={} (unchanged)",
        intent_after.data[0], reloaded.deadline_ts, intent_after.lamports
    );
}
