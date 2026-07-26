//! Mollusk tests for the two-step GlobalState.authority rotation
//! (propose_authority 0x26 / accept_authority 0x27).
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

fn global_account(program_id: &Pubkey, authority: &Pubkey) -> Account {
    let mut g = GlobalState::zeroed();
    g.discriminator = DISC_GLOBAL_STATE;
    g.authority = authority.to_bytes();
    Account {
        lamports: 10_000_000,
        data: bytemuck::bytes_of(&g).to_vec(),
        owner: *program_id,
        executable: false,
        rent_epoch: 0,
    }
}

#[test]
fn test_propose_then_accept_rotates_authority() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let old_authority = Pubkey::new_unique();
    let new_authority = Pubkey::new_unique();
    let system_program_pk = Pubkey::default(); // System Program ID is the all-zero address

    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], &program_id);
    let accounts = vec![
        (global_pk, global_account(&program_id, &old_authority)),
        (old_authority, Account::default()),
        (system_program_pk, Account::default()),
    ];

    // propose_authority: data = new_authority (32 bytes).
    let mut data = vec![0x26u8];
    data.extend_from_slice(new_authority.as_ref());
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(global_pk, false),
            AccountMeta::new_readonly(old_authority, true),
            AccountMeta::new_readonly(system_program_pk, false),
        ],
        data,
    };
    let res = m.process_instruction(&ix, &accounts);
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);

    let global_after_propose = res.resulting_accounts[0].1.clone();
    // Extended by 32 bytes; authority unchanged until accepted.
    assert_eq!(global_after_propose.data.len(), 136);
    let global: &GlobalState =
        bytemuck::from_bytes(&global_after_propose.data[..GlobalState::LEN]);
    assert_eq!(global.authority, old_authority.to_bytes(), "authority must not change on propose");

    // accept_authority, signed by the NEW authority.
    let accounts2 = vec![
        (global_pk, global_after_propose),
        (new_authority, Account::default()),
    ];
    let ix2 = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(global_pk, false),
            AccountMeta::new_readonly(new_authority, true),
        ],
        data: vec![0x27u8],
    };
    let res2 = m.process_instruction(&ix2, &accounts2);
    assert!(matches!(res2.program_result, MolluskResult::Success), "{:?}", res2.program_result);

    let global_final: &GlobalState =
        bytemuck::from_bytes(&res2.resulting_accounts[0].1.data[..GlobalState::LEN]);
    assert_eq!(
        global_final.authority,
        new_authority.to_bytes(),
        "authority must be rotated after accept"
    );
    // pending_authority cleared.
    assert_eq!(&res2.resulting_accounts[0].1.data[104..136], &[0u8; 32]);
}

#[test]
fn test_accept_authority_rejects_wrong_signer() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let old_authority = Pubkey::new_unique();
    let new_authority = Pubkey::new_unique();
    let attacker = Pubkey::new_unique();
    let system_program_pk = Pubkey::new_unique();

    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], &program_id);
    let accounts = vec![
        (global_pk, global_account(&program_id, &old_authority)),
        (old_authority, Account::default()),
        (system_program_pk, Account::default()),
    ];

    let mut data = vec![0x26u8];
    data.extend_from_slice(new_authority.as_ref());
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(global_pk, false),
            AccountMeta::new_readonly(old_authority, true),
            AccountMeta::new_readonly(system_program_pk, false),
        ],
        data,
    };
    let res = m.process_instruction(&ix, &accounts);
    let global_after_propose = res.resulting_accounts[0].1.clone();

    // attacker (not the proposed new_authority) tries to accept.
    let accounts2 = vec![
        (global_pk, global_after_propose),
        (attacker, Account::default()),
    ];
    let ix2 = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(global_pk, false),
            AccountMeta::new_readonly(attacker, true),
        ],
        data: vec![0x27u8],
    };
    let res2 = m.process_instruction(&ix2, &accounts2);
    assert!(
        !matches!(res2.program_result, MolluskResult::Success),
        "a non-pending-authority signer must not be able to accept: {:?}",
        res2.program_result
    );

    let global_after: &GlobalState =
        bytemuck::from_bytes(&res2.resulting_accounts[0].1.data[..GlobalState::LEN]);
    assert_eq!(global_after.authority, old_authority.to_bytes(), "authority must not have changed");
}
