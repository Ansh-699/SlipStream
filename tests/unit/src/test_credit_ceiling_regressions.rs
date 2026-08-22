//! R1 — credit-ceiling regressions. Each test FAILS against the unmodified
//! program and must pass after `UserAccount.reserved_margin` is renamed to
//! `reserved_margin` and given the Decision-3 invariant.
//!
//! NOTE FOR THE BUILDER: these tests are written against the POST-fix field
//! name `reserved_margin`. Until the rename lands they will not compile;
//! that is the intended before-state for tests 1 and 2 (see the check file for
//! the recorded raw before-state, which was captured with the field still
//! named `reserved_margin`).
#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::state::*;

const IX_FUND_TRADING_CREDIT: u8 = 0x0E;
const IX_WITHDRAW_TRADING_CREDIT: u8 = 0x13;
const IX_SEED_CREDIT_LEDGER: u8 = 0x28;

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

fn user(owner: &Pubkey, free: u64, outstanding: u64) -> UserAccount {
    let mut u = UserAccount::zeroed();
    u.discriminator = DISC_USER_ACCOUNT;
    u.owner = owner.to_bytes();
    u.free_collateral = free;
    // POST-FIX FIELD NAME. Pre-fix this is `reserved_margin`.
    u.reserved_margin = outstanding;
    u
}

fn credit(owner: &Pubkey, amount: u64) -> TradingCredit {
    let mut c = TradingCredit::zeroed();
    c.discriminator = DISC_TRADING_CREDIT;
    c.owner = owner.to_bytes();
    c.credit = amount;
    c
}

fn global(authority: &Pubkey) -> GlobalState {
    let mut g = GlobalState::zeroed();
    g.discriminator = DISC_GLOBAL_STATE;
    g.authority = authority.to_bytes();
    g
}

/// THE ANCHOR ATTACK. A hostile ER commits `credit.credit = 1_000_000 USDC`
/// against a user whose L1 ledger records only 50 USDC ever funded.
/// `withdraw_trading_credit` must pay at most the ledger.
#[test]
fn test_er_inflated_credit_cannot_exceed_l1_ledger() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();

    const FUNDED: u64 = 50_000_000; // 50 USDC — what L1 actually recorded
    const INFLATED: u64 = 1_000_000_000_000; // 1,000,000 USDC — what the ER claims

    let user_pk = Pubkey::new_unique();
    let credit_pk = Pubkey::new_unique();

    let accounts = vec![
        (
            user_pk,
            program_account(&program_id, bytemuck::bytes_of(&user(&owner, 0, FUNDED))),
        ),
        (
            credit_pk,
            program_account(&program_id, bytemuck::bytes_of(&credit(&owner, INFLATED))),
        ),
        (owner, Account::default()),
    ];

    let mut data = vec![IX_WITHDRAW_TRADING_CREDIT];
    data.extend_from_slice(&INFLATED.to_le_bytes());

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(user_pk, false),
            AccountMeta::new(credit_pk, false),
            AccountMeta::new_readonly(owner, true),
        ],
        data,
    };
    let res = m.process_instruction(&ix, &accounts);

    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "withdraw_trading_credit paid out an ER-authored credit above the L1 ledger: {:?}",
        res.program_result
    );

    let after: &UserAccount = bytemuck::from_bytes(&res.resulting_accounts[0].1.data[..UserAccount::LEN]);
    assert_eq!(
        after.free_collateral, 0,
        "free_collateral must not move when the ceiling binds"
    );
    assert_eq!(
        after.reserved_margin, FUNDED,
        "the ledger must not move when the ceiling binds"
    );
}

/// The cap must never bind on an honest user: fund 100, withdraw 100, ledger
/// returns to zero. Guards the fix against over-tightening.
#[test]
fn test_honest_fund_then_withdraw_round_trips() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();
    let authority = Pubkey::new_unique();

    const AMOUNT: u64 = 100_000_000; // 100 USDC

    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], &program_id);
    let user_pk = Pubkey::new_unique();
    let credit_pk = Pubkey::new_unique();

    // --- fund_trading_credit: free 100 -> 0, credit 0 -> 100, ledger 0 -> 100
    let accounts = vec![
        (
            user_pk,
            program_account(&program_id, bytemuck::bytes_of(&user(&owner, AMOUNT, 0))),
        ),
        (
            credit_pk,
            program_account(&program_id, bytemuck::bytes_of(&credit(&owner, 0))),
        ),
        (owner, Account::default()),
        (
            global_pk,
            program_account(&program_id, bytemuck::bytes_of(&global(&authority))),
        ),
    ];
    let mut data = vec![IX_FUND_TRADING_CREDIT];
    data.extend_from_slice(&AMOUNT.to_le_bytes());
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(user_pk, false),
            AccountMeta::new(credit_pk, false),
            AccountMeta::new_readonly(owner, true),
            AccountMeta::new_readonly(global_pk, false),
        ],
        data,
    };
    let res = m.process_instruction(&ix, &accounts);
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);

    let funded_user: UserAccount =
        *bytemuck::from_bytes(&res.resulting_accounts[0].1.data[..UserAccount::LEN]);
    let funded_credit: TradingCredit =
        *bytemuck::from_bytes(&res.resulting_accounts[1].1.data[..TradingCredit::LEN]);
    assert_eq!(funded_user.free_collateral, 0);
    assert_eq!(funded_credit.credit, AMOUNT);
    assert_eq!(
        funded_user.reserved_margin, AMOUNT,
        "fund_trading_credit must raise the L1 credit ledger by the funded amount"
    );

    // --- withdraw_trading_credit: the full honest amount must go through.
    let accounts = vec![
        (
            user_pk,
            program_account(&program_id, bytemuck::bytes_of(&funded_user)),
        ),
        (
            credit_pk,
            program_account(&program_id, bytemuck::bytes_of(&funded_credit)),
        ),
        (owner, Account::default()),
    ];
    let mut data = vec![IX_WITHDRAW_TRADING_CREDIT];
    data.extend_from_slice(&AMOUNT.to_le_bytes());
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(user_pk, false),
            AccountMeta::new(credit_pk, false),
            AccountMeta::new_readonly(owner, true),
        ],
        data,
    };
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "the ceiling blocked an honest full withdrawal: {:?}",
        res.program_result
    );
    let after: &UserAccount = bytemuck::from_bytes(&res.resulting_accounts[0].1.data[..UserAccount::LEN]);
    assert_eq!(after.free_collateral, AMOUNT);
    assert_eq!(
        after.reserved_margin, 0,
        "withdraw_trading_credit must lower the ledger by what it paid"
    );
}

/// The grandfather seed is authority-gated and bounded by an explicit
/// authority-supplied amount, so it can never be used to raise a stranger's
/// ceiling nor to re-trust an arbitrary ER-authored `credit`.
#[test]
fn test_seed_credit_ledger_rejects_non_authority() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let authority = Pubkey::new_unique();
    let stranger = Pubkey::new_unique();
    let owner = Pubkey::new_unique();

    const ER_CLAIM: u64 = 7_017_392_213_830_636_841; // a real live devnet value
    const OPERATOR_BELIEVES: u64 = 500_000_000; // 500 USDC

    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], &program_id);
    let user_pk = Pubkey::new_unique();
    let credit_pk = Pubkey::new_unique();

    let base = vec![
        (
            global_pk,
            program_account(&program_id, bytemuck::bytes_of(&global(&authority))),
        ),
        (
            user_pk,
            program_account(&program_id, bytemuck::bytes_of(&user(&owner, 0, 0))),
        ),
        (
            credit_pk,
            program_account(&program_id, bytemuck::bytes_of(&credit(&owner, ER_CLAIM))),
        ),
        (stranger, Account::default()),
        (authority, Account::default()),
    ];

    let build = |signer: Pubkey, amount: u64| {
        let mut data = vec![IX_SEED_CREDIT_LEDGER];
        data.extend_from_slice(&amount.to_le_bytes());
        Instruction {
            program_id,
            accounts: vec![
                AccountMeta::new_readonly(global_pk, false),
                AccountMeta::new(user_pk, false),
                AccountMeta::new_readonly(credit_pk, false),
                AccountMeta::new_readonly(signer, true),
            ],
            data,
        }
    };

    // A stranger must be refused outright.
    let res = m.process_instruction(&build(stranger, ER_CLAIM), &base);
    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "seed_credit_ledger accepted a non-authority signer: {:?}",
        res.program_result
    );
    let after: &UserAccount = bytemuck::from_bytes(&res.resulting_accounts[1].1.data[..UserAccount::LEN]);
    assert_eq!(after.reserved_margin, 0, "a stranger raised their own ceiling");

    // The authority may seed, but only up to the amount it explicitly states —
    // the ER-authored `credit` can lower the seed, never raise it.
    let res = m.process_instruction(&build(authority, OPERATOR_BELIEVES), &base);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "the authority could not seed the ledger: {:?}",
        res.program_result
    );
    let after: &UserAccount = bytemuck::from_bytes(&res.resulting_accounts[1].1.data[..UserAccount::LEN]);
    assert_eq!(
        after.reserved_margin, OPERATOR_BELIEVES,
        "seed must be min(credit.credit, authority-supplied amount), never the raw ER value"
    );
}
