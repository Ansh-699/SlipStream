//! R7 — keeper role separation (the code half of `S10-01`).
//!
//! `record_pending_fill`, `initialize_fill_log` and `delegate_fill_log` gate on
//! `GlobalState.authority`, which is also the BPF upgrade authority and the USDC
//! mint authority. The fill-log keeper signs those three with a hot key on a
//! keeper VM, so today the upgrade authority is required hot in production.
#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::state::*;

const IX_RECORD_PENDING_FILL: u8 = 0x14;
const IX_SET_KEEPER: u8 = 0x2A;

/// `GlobalState` grows past `LEN` with the lazy-resize pattern it already uses
/// for `pending_authority` (`propose_authority.rs:79-92`).
const KEEPER_OFFSET: usize = 136;
const KEEPER_EXTENDED_LEN: usize = 168;

fn mollusk(program_id: &Pubkey) -> Mollusk {
    std::env::set_var(
        "SBF_OUT_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy"),
    );
    Mollusk::new(program_id, "slipstream")
}

fn pa(program_id: &Pubkey, data: Vec<u8>) -> Account {
    Account { lamports: 10_000_000, data, owner: *program_id, executable: false, rent_epoch: 0 }
}

fn global_bytes(authority: &Pubkey, keeper: Option<&Pubkey>) -> Vec<u8> {
    let mut g = GlobalState::zeroed();
    g.discriminator = DISC_GLOBAL_STATE;
    g.authority = authority.to_bytes();
    let mut d = bytemuck::bytes_of(&g).to_vec();
    if let Some(k) = keeper {
        d.resize(KEEPER_EXTENDED_LEN, 0);
        d[KEEPER_OFFSET..KEEPER_OFFSET + 32].copy_from_slice(&k.to_bytes());
    }
    d
}

fn user(owner: &Pubkey) -> UserAccount {
    let mut u = UserAccount::zeroed();
    u.discriminator = DISC_USER_ACCOUNT;
    u.owner = owner.to_bytes();
    u
}

/// The fill-log keeper must be able to sign `record_pending_fill` with a key
/// that is NOT the admin key — and a stranger must still be refused.
#[test]
fn test_fill_log_instructions_accept_keeper_and_reject_stranger() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let authority = Pubkey::new_unique();
    let keeper = Pubkey::new_unique();
    let stranger = Pubkey::new_unique();
    let victim_owner = Pubkey::new_unique();

    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], &program_id);
    let victim_pk = Pubkey::new_unique();

    let accounts = vec![
        (global_pk, pa(&program_id, global_bytes(&authority, Some(&keeper)))),
        (keeper, Account::default()),
        (stranger, Account::default()),
        (victim_pk, pa(&program_id, bytemuck::bytes_of(&user(&victim_owner)).to_vec())),
    ];

    let build = |signer: Pubkey| {
        let mut data = vec![IX_RECORD_PENDING_FILL];
        data.extend_from_slice(&1u16.to_le_bytes());
        Instruction {
            program_id,
            accounts: vec![
                AccountMeta::new_readonly(global_pk, false),
                AccountMeta::new_readonly(signer, true),
                AccountMeta::new(victim_pk, false),
            ],
            data,
        }
    };

    let res = m.process_instruction(&build(keeper), &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "record_pending_fill still requires the admin key — the keeper VM must hold \
         the upgrade/mint authority to run: {:?}",
        res.program_result
    );
    let after: &UserAccount =
        bytemuck::from_bytes(&res.resulting_accounts[3].1.data[..UserAccount::LEN]);
    assert_eq!(after.pending_fills, 1, "the keeper's call must take effect");

    let res = m.process_instruction(&build(stranger), &accounts);
    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "a stranger was accepted alongside the new keeper role: {:?}",
        res.program_result
    );
}

/// The three gated instructions must fall back to `authority` while the live
/// `GlobalState` is still at its unextended length, so nothing breaks before the
/// operator calls `set_keeper`.
#[test]
fn test_fill_log_instructions_fall_back_to_authority_when_unextended() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let authority = Pubkey::new_unique();
    let victim_owner = Pubkey::new_unique();

    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], &program_id);
    let victim_pk = Pubkey::new_unique();

    // Unextended: exactly GlobalState::LEN, no keeper field at all.
    let accounts = vec![
        (global_pk, pa(&program_id, global_bytes(&authority, None))),
        (authority, Account::default()),
        (victim_pk, pa(&program_id, bytemuck::bytes_of(&user(&victim_owner)).to_vec())),
    ];

    let mut data = vec![IX_RECORD_PENDING_FILL];
    data.extend_from_slice(&1u16.to_le_bytes());
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new_readonly(global_pk, false),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(victim_pk, false),
        ],
        data,
    };
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "the authority fallback broke on a not-yet-extended GlobalState: {:?}",
        res.program_result
    );
}

/// Only the admin key may install a keeper.
#[test]
fn test_set_keeper_requires_authority() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let authority = Pubkey::new_unique();
    let stranger = Pubkey::new_unique();
    let new_keeper = Pubkey::new_unique();

    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], &program_id);

    let accounts = vec![
        (
            global_pk,
            Account {
                // Pre-funded past the extended rent so the lazy resize succeeds.
                lamports: 100_000_000,
                data: global_bytes(&authority, None),
                owner: program_id,
                executable: false,
                rent_epoch: 0,
            },
        ),
        (stranger, Account { lamports: 100_000_000, ..Account::default() }),
        (authority, Account { lamports: 100_000_000, ..Account::default() }),
        (
            solana_address::Address::from([0u8; 32]),
            Account::default(),
        ),
    ];

    let build = |signer: Pubkey| {
        let mut data = vec![IX_SET_KEEPER];
        data.extend_from_slice(&new_keeper.to_bytes());
        Instruction {
            program_id,
            accounts: vec![
                AccountMeta::new(global_pk, false),
                AccountMeta::new(signer, true),
                AccountMeta::new_readonly(solana_address::Address::from([0u8; 32]), false),
            ],
            data,
        }
    };

    let res = m.process_instruction(&build(stranger), &accounts);
    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "set_keeper accepted a stranger installing themselves as keeper: {:?}",
        res.program_result
    );

    let res = m.process_instruction(&build(authority), &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "the authority could not install a keeper: {:?}",
        res.program_result
    );
    let data = &res.resulting_accounts[0].1.data;
    assert!(
        data.len() >= KEEPER_OFFSET + 32,
        "GlobalState was not extended to hold the keeper field"
    );
    assert_eq!(
        &data[KEEPER_OFFSET..KEEPER_OFFSET + 32],
        &new_keeper.to_bytes()[..],
        "the keeper field was not written"
    );
}
