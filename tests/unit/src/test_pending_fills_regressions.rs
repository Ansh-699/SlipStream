//! R5 — `pending_fills` symmetry and reset (`S4-04`).
//!
//! The 13 live devnet accounts holding 438,643.10 USDC are stuck behind a
//! counter nothing on chain can lower. `reset_pending_fills` is the only half
//! of R5 that lives in the program; the symmetry half lives in the keepers and
//! is graded by the keeper-side item in the check file.
#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::state::*;

const IX_RESET_PENDING_FILLS: u8 = 0x29;

fn mollusk(program_id: &Pubkey) -> Mollusk {
    std::env::set_var(
        "SBF_OUT_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy"),
    );
    Mollusk::new(program_id, "slipstream")
}

fn pa(program_id: &Pubkey, data: &[u8]) -> Account {
    Account { lamports: 10_000_000, data: data.to_vec(), owner: *program_id, executable: false, rent_epoch: 0 }
}

#[test]
fn test_reset_pending_fills_requires_authority_and_unblocks_withdrawal() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let authority = Pubkey::new_unique();
    let stranger = Pubkey::new_unique();
    let victim = Pubkey::new_unique();

    // The live devnet account stuck at pending_fills = 7 holding 5,000.00 USDC.
    const STUCK_BALANCE: u64 = 5_000_000_000;

    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], &program_id);

    let mut g = GlobalState::zeroed();
    g.discriminator = DISC_GLOBAL_STATE;
    g.authority = authority.to_bytes();

    let mut u = UserAccount::zeroed();
    u.discriminator = DISC_USER_ACCOUNT;
    u.owner = victim.to_bytes();
    u.pending_fills = 7;
    u.free_collateral = STUCK_BALANCE;

    let user_pk = Pubkey::new_unique();
    let accounts = vec![
        (global_pk, pa(&program_id, bytemuck::bytes_of(&g))),
        (user_pk, pa(&program_id, bytemuck::bytes_of(&u))),
        (stranger, Account::default()),
        (authority, Account::default()),
    ];

    let build = |signer: Pubkey| Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new_readonly(global_pk, false),
            AccountMeta::new(user_pk, false),
            AccountMeta::new_readonly(signer, true),
        ],
        data: vec![IX_RESET_PENDING_FILLS],
    };

    // A stranger must not be able to clear anyone's gate.
    let res = m.process_instruction(&build(stranger), &accounts);
    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "reset_pending_fills accepted a non-authority signer: {:?}",
        res.program_result
    );
    let after: &UserAccount =
        bytemuck::from_bytes(&res.resulting_accounts[1].1.data[..UserAccount::LEN]);
    assert_eq!(after.pending_fills, 7, "a stranger cleared the withdrawal gate");

    // The authority may clear it, which is what unblocks the 438,643.10 USDC.
    let res = m.process_instruction(&build(authority), &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "the authority could not clear a stuck pending_fills counter: {:?}",
        res.program_result
    );
    let after: &UserAccount =
        bytemuck::from_bytes(&res.resulting_accounts[1].1.data[..UserAccount::LEN]);
    assert_eq!(after.pending_fills, 0, "the counter must be cleared");
    assert_eq!(
        after.free_collateral, STUCK_BALANCE,
        "clearing the gate must not move the balance"
    );
}
