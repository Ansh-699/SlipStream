//! Mollusk (in-process SVM) tests for the close_position / execute_trigger
//! money paths. These run the REAL compiled program (target/deploy/slipstream.so
//! — build with `cargo build-sbf --manifest-path programs/slipstream/Cargo.toml`
//! first; the bare workspace build feature-unifies `no-entrypoint` from this
//! test crate and emits an entrypoint-less stub).
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
const SOL: i64 = 1_000_000_000; // BASE_SCALE

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

fn market_account(program_id: &Pubkey, mark: u64, oi_long: u64, oi_short: u64) -> Account {
    let mut m = Market::zeroed();
    m.discriminator = DISC_MARKET;
    m.last_mark_price = mark;
    m.open_interest_long = oi_long;
    m.open_interest_short = oi_short;
    m.insurance_fund_balance = 1_000 * PRICE_SCALE;
    program_account(program_id, bytemuck::bytes_of(&m))
}

fn position_account(program_id: &Pubkey, owner: &Pubkey, size: i64, entry: u64, collateral: u64) -> Account {
    let mut p = Position::zeroed();
    p.discriminator = DISC_POSITION;
    p.owner = owner.to_bytes();
    p.size = size;
    p.entry_price = entry;
    p.collateral = collateral;
    program_account(program_id, bytemuck::bytes_of(&p))
}

fn user_account(program_id: &Pubkey, owner: &Pubkey, free: u64) -> Account {
    let mut u = UserAccount::zeroed();
    u.discriminator = DISC_USER_ACCOUNT;
    u.owner = owner.to_bytes();
    u.free_collateral = free;
    program_account(program_id, bytemuck::bytes_of(&u))
}

/// close_position instruction: disc 0x08 (+ optional close_size/limit_price).
fn close_ix(
    program_id: &Pubkey,
    market: Pubkey,
    position: Pubkey,
    user: Pubkey,
    owner: Pubkey,
    tail: Option<(u64, u64)>,
) -> Instruction {
    let mut data = vec![0x08u8];
    if let Some((close_size, limit_price)) = tail {
        data.extend_from_slice(&close_size.to_le_bytes());
        data.extend_from_slice(&limit_price.to_le_bytes());
    }
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(market, false),
            AccountMeta::new(position, false),
            AccountMeta::new(user, false),
            AccountMeta::new_readonly(owner, true),
        ],
        data,
    }
}

struct Setup {
    program_id: Pubkey,
    market: Pubkey,
    position: Pubkey,
    user: Pubkey,
    owner: Pubkey,
}

fn setup() -> Setup {
    Setup {
        program_id: Pubkey::new_unique(),
        market: Pubkey::new_unique(),
        position: Pubkey::new_unique(),
        user: Pubkey::new_unique(),
        owner: Pubkey::new_unique(),
    }
}

#[test]
fn test_full_close_credits_pnl_and_zeroes_position() {
    let s = setup();
    let m = mollusk(&s.program_id);

    // Long 2 SOL @ $100, mark $110, 10 USDC collateral => +$20 uPnL, $30 settled.
    let accounts = vec![
        (s.market, market_account(&s.program_id, 110 * PRICE_SCALE, 2 * SOL as u64, 0)),
        (s.position, position_account(&s.program_id, &s.owner, 2 * SOL, 100 * PRICE_SCALE, 10 * PRICE_SCALE)),
        (s.user, user_account(&s.program_id, &s.owner, 5 * PRICE_SCALE)),
        (s.owner, Account::default()),
    ];
    let ix = close_ix(&s.program_id, s.market, s.position, s.user, s.owner, None);
    let res = m.process_instruction(&ix, &accounts);
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);

    let pos: &Position = bytemuck::from_bytes(&res.resulting_accounts[1].1.data[..Position::LEN]);
    assert_eq!(pos.size, 0);
    assert_eq!(pos.collateral, 0);
    assert_eq!(pos.realized_pnl, 20 * PRICE_SCALE as i64);

    let user: &UserAccount = bytemuck::from_bytes(&res.resulting_accounts[2].1.data[..UserAccount::LEN]);
    assert_eq!(user.free_collateral, (5 + 10 + 20) * PRICE_SCALE);

    let market: &Market = bytemuck::from_bytes(&res.resulting_accounts[0].1.data[..Market::LEN]);
    assert_eq!(market.open_interest_long, 0);
}

#[test]
fn test_partial_close_scales_size_collateral_and_oi() {
    let s = setup();
    let m = mollusk(&s.program_id);

    let accounts = vec![
        (s.market, market_account(&s.program_id, 110 * PRICE_SCALE, 2 * SOL as u64, 0)),
        (s.position, position_account(&s.program_id, &s.owner, 2 * SOL, 100 * PRICE_SCALE, 10 * PRICE_SCALE)),
        (s.user, user_account(&s.program_id, &s.owner, 0)),
        (s.owner, Account::default()),
    ];
    // Close 1 of 2 SOL, no price bound.
    let ix = close_ix(&s.program_id, s.market, s.position, s.user, s.owner, Some((SOL as u64, 0)));
    let res = m.process_instruction(&ix, &accounts);
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);

    let pos: &Position = bytemuck::from_bytes(&res.resulting_accounts[1].1.data[..Position::LEN]);
    assert_eq!(pos.size, SOL); // half remains
    assert_eq!(pos.collateral, 5 * PRICE_SCALE); // half released
    assert_eq!(pos.entry_price, 100 * PRICE_SCALE); // entry unchanged on reduce
    assert_eq!(pos.realized_pnl, 10 * PRICE_SCALE as i64); // half the +$20

    let user: &UserAccount = bytemuck::from_bytes(&res.resulting_accounts[2].1.data[..UserAccount::LEN]);
    assert_eq!(user.free_collateral, (5 + 10) * PRICE_SCALE);

    let market: &Market = bytemuck::from_bytes(&res.resulting_accounts[0].1.data[..Market::LEN]);
    assert_eq!(market.open_interest_long, SOL as u64);
}

#[test]
fn test_close_slippage_bound_rejects() {
    let s = setup();
    let m = mollusk(&s.program_id);

    let accounts = vec![
        (s.market, market_account(&s.program_id, 110 * PRICE_SCALE, 2 * SOL as u64, 0)),
        (s.position, position_account(&s.program_id, &s.owner, 2 * SOL, 100 * PRICE_SCALE, 10 * PRICE_SCALE)),
        (s.user, user_account(&s.program_id, &s.owner, 0)),
        (s.owner, Account::default()),
    ];
    // Closing a long sells: demanding at least $115 when mark is $110 must fail.
    let ix = close_ix(&s.program_id, s.market, s.position, s.user, s.owner, Some((0, 115 * PRICE_SCALE)));
    let res = m.process_instruction(&ix, &accounts);
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(ProgramError::Custom(SlipstreamError::SlippageExceeded as u32))
    );
}

fn trigger_setup(
    s: &Setup,
    trigger_above: u8,
    trigger_price: u64,
    mark: u64,
) -> (Pubkey, Vec<(Pubkey, Account)>, Pubkey) {
    let kind = TRIGGER_KIND_STOP_LOSS;
    let (trigger_pda, bump) = Pubkey::find_program_address(
        &[SEED_TRIGGER, s.owner.as_ref(), &0u16.to_le_bytes(), &[kind]],
        &s.program_id,
    );
    let mut t = TriggerOrder::zeroed();
    t.discriminator = DISC_TRIGGER_ORDER;
    t.bump = bump;
    t.kind = kind;
    t.trigger_above = trigger_above;
    t.owner = s.owner.to_bytes();
    t.trigger_price = trigger_price;

    let executor = Pubkey::new_unique();
    let accounts = vec![
        (s.market, market_account(&s.program_id, mark, 2 * SOL as u64, 0)),
        (s.position, position_account(&s.program_id, &s.owner, 2 * SOL, 100 * PRICE_SCALE, 10 * PRICE_SCALE)),
        (s.user, user_account(&s.program_id, &s.owner, 0)),
        (trigger_pda, program_account(&s.program_id, bytemuck::bytes_of(&t))),
        (s.owner, Account::default()),
        (executor, Account { lamports: 1_000_000, ..Account::default() }),
    ];
    (trigger_pda, accounts, executor)
}

fn execute_ix(s: &Setup, trigger: Pubkey, executor: Pubkey) -> Instruction {
    Instruction {
        program_id: s.program_id,
        accounts: vec![
            AccountMeta::new(s.market, false),
            AccountMeta::new(s.position, false),
            AccountMeta::new(s.user, false),
            AccountMeta::new(trigger, false),
            AccountMeta::new(s.owner, false),
            AccountMeta::new(executor, true),
        ],
        data: vec![0x24],
    }
}

#[test]
fn test_execute_trigger_closes_position_and_pays_executor() {
    let s = setup();
    let m = mollusk(&s.program_id);

    // Long stop-loss at $95 (fire when mark <= 95); mark $90 => met.
    let (trigger, accounts, executor) = trigger_setup(&s, 0, 95 * PRICE_SCALE, 90 * PRICE_SCALE);
    let trigger_rent = accounts[3].1.lamports;
    let ix = execute_ix(&s, trigger, executor);
    let res = m.process_instruction(&ix, &accounts);
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);

    let pos: &Position = bytemuck::from_bytes(&res.resulting_accounts[1].1.data[..Position::LEN]);
    assert_eq!(pos.size, 0);
    // -$20 loss + $10 collateral = -$10 net => insurance fund absorbs, user gets 0.
    let user: &UserAccount = bytemuck::from_bytes(&res.resulting_accounts[2].1.data[..UserAccount::LEN]);
    assert_eq!(user.free_collateral, 0);
    let market: &Market = bytemuck::from_bytes(&res.resulting_accounts[0].1.data[..Market::LEN]);
    assert_eq!(market.insurance_fund_balance, (1_000 - 10) * PRICE_SCALE);

    // Trigger closed: data zeroed, rent moved to the executor.
    assert!(res.resulting_accounts[3].1.data.iter().all(|&b| b == 0));
    assert_eq!(res.resulting_accounts[3].1.lamports, 0);
    assert_eq!(res.resulting_accounts[5].1.lamports, 1_000_000 + trigger_rent);
}

#[test]
fn test_execute_trigger_rejects_when_condition_not_met() {
    let s = setup();
    let m = mollusk(&s.program_id);

    // Stop-loss at $95; mark $100 => not met.
    let (trigger, accounts, executor) = trigger_setup(&s, 0, 95 * PRICE_SCALE, 100 * PRICE_SCALE);
    let ix = execute_ix(&s, trigger, executor);
    let res = m.process_instruction(&ix, &accounts);
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(ProgramError::Custom(
            SlipstreamError::TriggerConditionNotMet as u32
        ))
    );
}
