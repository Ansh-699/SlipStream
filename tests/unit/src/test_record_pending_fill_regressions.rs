//! Mollusk regression test for record_pending_fill's authentication fix.
//!
//! Before this fix, the instruction had no signer requirement at all: anyone
//! could bump any listed UserAccount's `pending_fills` toward u16::MAX (a
//! permanent withdrawal/close freeze, since nothing but a real settled fill ever
//! decrements it) or bump their OWN account once to permanently detour every
//! liquidation attempt against them into the pending-fills grace window.
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

#[test]
fn test_record_pending_fill_rejects_unauthenticated_caller() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let real_authority = Pubkey::new_unique();
    let attacker = Pubkey::new_unique();
    let victim_owner = Pubkey::new_unique();

    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], &program_id);

    let mut global = GlobalState::zeroed();
    global.discriminator = DISC_GLOBAL_STATE;
    global.authority = real_authority.to_bytes();

    let mut victim = UserAccount::zeroed();
    victim.discriminator = DISC_USER_ACCOUNT;
    victim.owner = victim_owner.to_bytes();
    victim.pending_fills = 0;

    let victim_pk = Pubkey::new_unique();
    let accounts = vec![
        (global_pk, program_account(&program_id, bytemuck::bytes_of(&global))),
        (attacker, Account::default()),
        (victim_pk, program_account(&program_id, bytemuck::bytes_of(&victim))),
    ];

    // record_pending_fill (0x14): [global_state, authority(signer), ...users].
    // `attacker` signs, but is NOT global.authority.
    let mut data = vec![0x14u8];
    data.extend_from_slice(&1u16.to_le_bytes()); // num_users = 1

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new_readonly(global_pk, false),
            AccountMeta::new_readonly(attacker, true),
            AccountMeta::new(victim_pk, false),
        ],
        data,
    };
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "record_pending_fill accepted a non-authority signer: {:?}",
        res.program_result
    );

    let victim_after: &UserAccount =
        bytemuck::from_bytes(&res.resulting_accounts[2].1.data[..UserAccount::LEN]);
    assert_eq!(
        victim_after.pending_fills, 0,
        "pending_fills must not be bumped by an unauthenticated caller"
    );
}

#[test]
fn test_record_pending_fill_accepts_real_authority() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let real_authority = Pubkey::new_unique();
    let victim_owner = Pubkey::new_unique();

    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], &program_id);

    let mut global = GlobalState::zeroed();
    global.discriminator = DISC_GLOBAL_STATE;
    global.authority = real_authority.to_bytes();

    let mut victim = UserAccount::zeroed();
    victim.discriminator = DISC_USER_ACCOUNT;
    victim.owner = victim_owner.to_bytes();

    let victim_pk = Pubkey::new_unique();
    let accounts = vec![
        (global_pk, program_account(&program_id, bytemuck::bytes_of(&global))),
        (real_authority, Account::default()),
        (victim_pk, program_account(&program_id, bytemuck::bytes_of(&victim))),
    ];

    let mut data = vec![0x14u8];
    data.extend_from_slice(&1u16.to_le_bytes());

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new_readonly(global_pk, false),
            AccountMeta::new_readonly(real_authority, true),
            AccountMeta::new(victim_pk, false),
        ],
        data,
    };
    let res = m.process_instruction(&ix, &accounts);
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);

    let victim_after: &UserAccount =
        bytemuck::from_bytes(&res.resulting_accounts[2].1.data[..UserAccount::LEN]);
    assert_eq!(victim_after.pending_fills, 1);
}
