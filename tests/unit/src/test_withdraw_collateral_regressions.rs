//! Mollusk regression tests for withdraw_collateral's vault-pin and mandatory
//! same-slot-guard fixes.
//!
//! Before this fix: (1) `quote_vault_acc` was never checked against any
//! Market's registered vault, so the caller chose the source of funds
//! outright; (2) the same-slot flash guard only scanned OPTIONAL trailing
//! Position accounts, so it was fully bypassed by simply not passing any.
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
fn withdraw_ix(
    program_id: &Pubkey,
    user_account: Pubkey,
    owner: Pubkey,
    quote_vault: Pubkey,
    user_token_acc: Pubkey,
    vault_authority: Pubkey,
    token_program: Pubkey,
    market: Pubkey,
    global_state: Pubkey,
    positions: &[Pubkey],
    amount: u64,
) -> Instruction {
    let mut data = vec![0x03u8];
    data.extend_from_slice(&amount.to_le_bytes());
    let mut accounts = vec![
        AccountMeta::new(user_account, false),
        AccountMeta::new_readonly(owner, true),
        AccountMeta::new(quote_vault, false),
        AccountMeta::new(user_token_acc, false),
        AccountMeta::new_readonly(vault_authority, false),
        AccountMeta::new_readonly(token_program, false), // unused before every revert path tested here
        AccountMeta::new_readonly(market, false),
        AccountMeta::new_readonly(global_state, false),
    ];
    for p in positions {
        accounts.push(AccountMeta::new_readonly(*p, false));
    }
    Instruction { program_id: *program_id, accounts, data }
}

struct Setup {
    program_id: Pubkey,
    owner: Pubkey,
    user_account_pk: Pubkey,
    quote_vault_pk: Pubkey,
    vault_authority_pk: Pubkey,
    token_program_pk: Pubkey,
    market_pk: Pubkey,
    global_pk: Pubkey,
    position_pk: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
}

/// Builds a well-formed withdraw scenario (real vault, empty Position on the
/// only market) that would otherwise succeed structurally.
fn setup(free_collateral: u64, position_open_slot: u64, position_exists: bool) -> Setup {
    let program_id = Pubkey::new_unique();
    let owner = Pubkey::new_unique();
    let user_account_pk = Pubkey::new_unique();
    let quote_vault_pk = Pubkey::new_unique();
    let user_token_acc_pk = Pubkey::new_unique();
    let (vault_authority_pk, _) =
        Pubkey::find_program_address(&[SEED_VAULT_AUTHORITY], &program_id);
    let (market_pk, _) = Pubkey::find_program_address(&[SEED_MARKET, &0u16.to_le_bytes()], &program_id);
    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], &program_id);
    let (position_pk, _) = Pubkey::find_program_address(
        &[SEED_POSITION, owner.as_ref(), &0u16.to_le_bytes()],
        &program_id,
    );
    let token_program_pk = Pubkey::new_unique();

    let mut user = UserAccount::zeroed();
    user.discriminator = DISC_USER_ACCOUNT;
    user.owner = owner.to_bytes();
    user.free_collateral = free_collateral;

    let mut mkt = Market::zeroed();
    mkt.discriminator = DISC_MARKET;
    mkt.market_index = 0;
    mkt.quote_vault = quote_vault_pk.to_bytes();

    let mut global = GlobalState::zeroed();
    global.discriminator = DISC_GLOBAL_STATE;
    global.market_count = 1;

    let mut accounts = vec![
        (user_account_pk, program_account(&program_id, bytemuck::bytes_of(&user))),
        (quote_vault_pk, Account::default()),
        (user_token_acc_pk, Account::default()),
        (market_pk, program_account(&program_id, bytemuck::bytes_of(&mkt))),
        (global_pk, program_account(&program_id, bytemuck::bytes_of(&global))),
        (owner, Account::default()),
        (token_program_pk, Account::default()),
        (vault_authority_pk, Account::default()),
    ];

    if position_exists {
        let mut pos = Position::zeroed();
        pos.discriminator = DISC_POSITION;
        pos.market_index = 0;
        pos.owner = owner.to_bytes();
        pos.open_slot = position_open_slot;
        accounts.push((position_pk, program_account(&program_id, bytemuck::bytes_of(&pos))));
    } else {
        accounts.push((position_pk, Account::default()));
    }

    Setup {
        program_id,
        owner,
        user_account_pk,
        quote_vault_pk,
        vault_authority_pk,
        token_program_pk,
        market_pk,
        global_pk,
        position_pk,
        accounts,
    }
}

/// A caller-supplied vault that doesn't match the market's registered
/// quote_vault must be rejected before ever attempting the transfer.
#[test]
fn test_withdraw_rejects_vault_not_matching_market() {
    let s = setup(1_000_000, 0, false);
    let m = mollusk(&s.program_id);
    let user_token_acc_pk = Pubkey::new_unique();
    let wrong_vault = Pubkey::new_unique(); // NOT s.quote_vault_pk

    let mut accounts = s.accounts;
    accounts.push((wrong_vault, Account::default()));
    accounts.push((user_token_acc_pk, Account::default()));

    let ix = withdraw_ix(
        &s.program_id,
        s.user_account_pk,
        s.owner,
        wrong_vault,
        user_token_acc_pk,
        s.vault_authority_pk,
        s.token_program_pk,
        s.market_pk,
        s.global_pk,
        &[s.position_pk],
        100_000,
    );
    let res = m.process_instruction(&ix, &accounts);
    let expected =
        solana_program_error::ProgramError::Custom(slipstream::error::SlipstreamError::InvalidVault as u32);
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(expected),
        "a vault not matching the market's registered quote_vault must be rejected: {:?}",
        res.program_result
    );
}

/// A Position opened THIS slot must block withdrawal even though the caller
/// cannot omit the Position account (it is now mandatory).
#[test]
fn test_withdraw_rejects_same_slot_position() {
    // Mollusk's default Clock has slot == 0, so a Position opened at slot 0 is
    // "this slot".
    let s = setup(1_000_000, 0, true);
    let m = mollusk(&s.program_id);
    let user_token_acc_pk = Pubkey::new_unique();
    let mut accounts = s.accounts;
    accounts.push((user_token_acc_pk, Account::default()));

    let ix = withdraw_ix(
        &s.program_id,
        s.user_account_pk,
        s.owner,
        s.quote_vault_pk,
        user_token_acc_pk,
        s.vault_authority_pk,
        s.token_program_pk,
        s.market_pk,
        s.global_pk,
        &[s.position_pk],
        100_000,
    );
    let res = m.process_instruction(&ix, &accounts);
    let expected = solana_program_error::ProgramError::Custom(
        slipstream::error::SlipstreamError::SameSlotWithdrawal as u32,
    );
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(expected),
        "a position opened this slot must block withdrawal: {:?}",
        res.program_result
    );
}

/// Omitting a market's Position account entirely must NOT bypass the guard —
/// it is now a mandatory account, so a short account list is a hard error.
#[test]
fn test_withdraw_rejects_when_mandatory_position_account_omitted() {
    let s = setup(1_000_000, 0, true);
    let m = mollusk(&s.program_id);
    let user_token_acc_pk = Pubkey::new_unique();
    let mut accounts = s.accounts;
    accounts.push((user_token_acc_pk, Account::default()));

    let ix = withdraw_ix(
        &s.program_id,
        s.user_account_pk,
        s.owner,
        s.quote_vault_pk,
        user_token_acc_pk,
        s.vault_authority_pk,
        s.token_program_pk,
        s.market_pk,
        s.global_pk,
        &[], // omitted — must not silently skip the guard
        100_000,
    );
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "omitting the mandatory Position account must not allow withdrawal to proceed: {:?}",
        res.program_result
    );
}
