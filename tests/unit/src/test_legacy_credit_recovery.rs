//! R2 — legacy 56-byte `TradingCredit` recovery (`S1-01`), and the guard that
//! keeps the recovery branch from becoming a hole in R1's ceiling.
#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::state::*;

const IX_CLOSE_TRADING_CREDIT: u8 = 0x1C;

/// The pre-session-keys layout: disc, bump, market_index, active_orders,
/// _padding[2], owner[32], credit, committed  == 56 bytes.
const LEGACY_LEN: usize = 56;

fn mollusk(program_id: &Pubkey) -> Mollusk {
    std::env::set_var(
        "SBF_OUT_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy"),
    );
    Mollusk::new(program_id, "slipstream")
}

fn program_account(program_id: &Pubkey, data: Vec<u8>) -> Account {
    Account {
        lamports: 1_280_640, // the live devnet legacy-credit rent, to the lamport
        data,
        owner: *program_id,
        executable: false,
        rent_epoch: 0,
    }
}

/// Hand-build the 56-byte legacy layout. The first 56 bytes of the modern
/// 96-byte struct are byte-identical, which is what makes the fixed-offset
/// read in the recovery branch sound.
fn legacy_credit_bytes(owner: &Pubkey, credit: u64, committed: u64, active_orders: u16) -> Vec<u8> {
    let mut d = vec![0u8; LEGACY_LEN];
    d[0] = DISC_TRADING_CREDIT;
    d[1] = 255; // bump
    d[2..4].copy_from_slice(&0u16.to_le_bytes()); // market_index
    d[4..6].copy_from_slice(&active_orders.to_le_bytes());
    d[8..40].copy_from_slice(&owner.to_bytes());
    d[40..48].copy_from_slice(&credit.to_le_bytes());
    d[48..56].copy_from_slice(&committed.to_le_bytes());
    d
}

fn user_account(owner: &Pubkey, free: u64) -> UserAccount {
    let mut u = UserAccount::zeroed();
    u.discriminator = DISC_USER_ACCOUNT;
    u.owner = owner.to_bytes();
    u.free_collateral = free;
    u
}

/// The live devnet legacy credit holding 13,163.24 USDC. Closing it must
/// recover the balance to `UserAccount.free_collateral`, not destroy it.
#[test]
fn test_close_trading_credit_recovers_legacy_56_byte_account() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();

    const STRANDED: u64 = 13_163_240_000; // the real live value

    let credit_pk = Pubkey::new_unique();
    let user_pk = Pubkey::new_unique();

    let accounts = vec![
        (
            credit_pk,
            program_account(&program_id, legacy_credit_bytes(&owner, STRANDED, 0, 0)),
        ),
        (owner, Account::default()),
        (
            user_pk,
            Account {
                lamports: 10_000_000,
                data: bytemuck::bytes_of(&user_account(&owner, 0)).to_vec(),
                owner: program_id,
                executable: false,
                rent_epoch: 0,
            },
        ),
    ];

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(credit_pk, false),
            AccountMeta::new(owner, true),
            AccountMeta::new(user_pk, false),
        ],
        data: vec![IX_CLOSE_TRADING_CREDIT],
    };
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "close_trading_credit still refuses the 56-byte legacy layout: {:?}",
        res.program_result
    );

    let after: &UserAccount =
        bytemuck::from_bytes(&res.resulting_accounts[2].1.data[..UserAccount::LEN]);
    assert_eq!(
        after.free_collateral, STRANDED,
        "the legacy credit balance must be recovered to free_collateral, not destroyed"
    );
    assert_eq!(
        res.resulting_accounts[0].1.data.iter().copied().max().unwrap_or(0),
        0,
        "the closed credit account must be fully zeroed"
    );
}

/// R2 must not become a bypass of R1's ceiling, and it must not silently
/// destroy a live balance: closing a MODERN 96-byte credit that still holds
/// `credit > 0` must be refused, so the owner is forced through
/// `withdraw_trading_credit` (where the ledger cap applies).
#[test]
fn test_legacy_recovery_rejects_modern_length_account() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();

    const BALANCE: u64 = 500_000_000; // the one live modern credit, 500 USDC

    let mut c = TradingCredit::zeroed();
    c.discriminator = DISC_TRADING_CREDIT;
    c.owner = owner.to_bytes();
    c.credit = BALANCE;

    let credit_pk = Pubkey::new_unique();
    let user_pk = Pubkey::new_unique();

    let accounts = vec![
        (
            credit_pk,
            program_account(&program_id, bytemuck::bytes_of(&c).to_vec()),
        ),
        (owner, Account::default()),
        (
            user_pk,
            Account {
                lamports: 10_000_000,
                data: bytemuck::bytes_of(&user_account(&owner, 0)).to_vec(),
                owner: program_id,
                executable: false,
                rent_epoch: 0,
            },
        ),
    ];

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(credit_pk, false),
            AccountMeta::new(owner, true),
            AccountMeta::new(user_pk, false),
        ],
        data: vec![IX_CLOSE_TRADING_CREDIT],
    };
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "close_trading_credit destroyed a live 96-byte credit balance (and, post-R1, \
         would leave credit_outstanding stale and lock the owner's free_collateral): {:?}",
        res.program_result
    );

    let after: &UserAccount =
        bytemuck::from_bytes(&res.resulting_accounts[2].1.data[..UserAccount::LEN]);
    assert_eq!(after.free_collateral, 0, "no funds may move on a refused close");
}
