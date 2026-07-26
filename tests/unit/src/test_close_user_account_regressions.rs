//! Mollusk regression tests for close_user_account's open-position gate.
//!
//! Before this fix, closing a UserAccount only checked free_collateral,
//! reserved_margin (permanently 0 — dead code, never incremented anywhere) and
//! pending_fills, none of which catch an open Position. A user could purge their
//! UserAccount while holding an arbitrarily underwater position: liquidate_position
//! requires a live UserAccount, so the position became permanently unliquidatable.
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

fn setup(
    program_id: &Pubkey,
    owner: &Pubkey,
    position_size: i64,
) -> (Pubkey, Pubkey, Pubkey, Vec<(Pubkey, Account)>) {
    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    let (user_pk, _) = Pubkey::find_program_address(&[SEED_USER, owner.as_ref()], program_id);
    let (position_pk, _) = Pubkey::find_program_address(
        &[SEED_POSITION, owner.as_ref(), &0u16.to_le_bytes()],
        program_id,
    );

    let mut global = GlobalState::zeroed();
    global.discriminator = DISC_GLOBAL_STATE;
    global.market_count = 1;

    let mut user = UserAccount::zeroed();
    user.discriminator = DISC_USER_ACCOUNT;
    user.owner = owner.to_bytes();

    let mut pos = Position::zeroed();
    pos.discriminator = DISC_POSITION;
    pos.owner = owner.to_bytes();
    pos.size = position_size;

    let accounts = vec![
        (user_pk, program_account(program_id, bytemuck::bytes_of(&user))),
        (*owner, Account::default()),
        (global_pk, program_account(program_id, bytemuck::bytes_of(&global))),
        (position_pk, program_account(program_id, bytemuck::bytes_of(&pos))),
    ];
    (global_pk, user_pk, position_pk, accounts)
}

fn close_ix(program_id: &Pubkey, user_pk: Pubkey, owner: Pubkey, global_pk: Pubkey, position_pk: Pubkey) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(user_pk, false),
            AccountMeta::new(owner, true),
            AccountMeta::new_readonly(global_pk, false),
            AccountMeta::new_readonly(position_pk, false),
        ],
        data: vec![0x15u8],
    }
}

#[test]
fn test_close_user_account_rejects_while_position_open() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();

    let (global_pk, user_pk, position_pk, accounts) = setup(&program_id, &owner, 1_000_000_000);
    let ix = close_ix(&program_id, user_pk, owner, global_pk, position_pk);
    let res = m.process_instruction(&ix, &accounts);

    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "closing the UserAccount while a Position is open must be rejected: {:?}",
        res.program_result
    );

    // The UserAccount must be untouched (not zeroed/closed).
    let user_after: &UserAccount =
        bytemuck::from_bytes(&res.resulting_accounts[0].1.data[..UserAccount::LEN]);
    assert_eq!(user_after.discriminator, DISC_USER_ACCOUNT);
}

#[test]
fn test_close_user_account_succeeds_when_position_flat() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();

    let (global_pk, user_pk, position_pk, accounts) = setup(&program_id, &owner, 0);
    let ix = close_ix(&program_id, user_pk, owner, global_pk, position_pk);
    let res = m.process_instruction(&ix, &accounts);

    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "closing with a flat (size==0) position must succeed: {:?}",
        res.program_result
    );
    // Data zeroed and lamports drained to the owner.
    assert_eq!(res.resulting_accounts[0].1.lamports, 0);
    assert!(res.resulting_accounts[0].1.data.iter().all(|&b| b == 0));
}
