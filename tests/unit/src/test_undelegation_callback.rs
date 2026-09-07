//! Regression tests for the MagicBlock undelegation callback route.
//!
//! The delegation program cannot hand a data-bearing account back directly, so
//! its `undelegate` copies the committed bytes into an "undelegate-buffer" PDA
//! of its own, CLOSES the delegated account, and CPIs the OWNER program with
//! `[196,28,41,206,48,37,51,167] ++ borsh(Vec<Vec<u8>> seeds)` over accounts
//! `[delegated, buffer, payer, system_program]`, then asserts the owner program
//! restored `delegated.data == buffer.data`.
//!
//! `instructions::process` used to `split_first()` a ONE-byte discriminator and
//! match `0x00..=0x2A`, so byte 196 hit `_ => Err(InvalidInstructionData)`, the
//! CPI failed, and the validator's whole `undelegate` transaction reverted. Live
//! proof (devnet, 2026-07-28), tx
//! 5bPgmyYNYu3WE5zojVkPR8jREWvwengkXzpNAaJSVtH51NSA8Mb3QWexneD1RZg8enPreBZRbJ3a1wvogEnYCN7j:
//! "Program 7qujfsb4... consumed 109 CU ... failed: invalid instruction data".
//! Ten TradingCredit PDAs are stranded that way; none has ever come back.
#![cfg(test)]

use mollusk_svm::program::keyed_account_for_system_program;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;

use slipstream::error::SlipstreamError;
use slipstream::instructions::delegate_trading_credit::DELEGATION_PROGRAM_ID;
use slipstream::state::*;

/// `dlp_api::consts::EXTERNAL_UNDELEGATE_DISCRIMINATOR`.
const EXTERNAL_UNDELEGATE_DISCRIMINATOR: [u8; 8] = [196, 28, 41, 206, 48, 37, 51, 167];
/// `dlp_api::pda::UNDELEGATE_BUFFER_TAG` — derived under the DELEGATION program,
/// NOT under the owner program (that is `b"buffer"`, a different PDA).
const UNDELEGATE_BUFFER_TAG: &[u8] = b"undelegate-buffer";

const MARKET_INDEX: u16 = 0;
/// The live devnet legacy `TradingCredit` layout, still on 12 delegated accounts.
const LEGACY_LEN: usize = 56;

fn mollusk(program_id: &Pubkey) -> Mollusk {
    std::env::set_var(
        "SBF_OUT_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy"),
    );
    Mollusk::new(program_id, "slipstream")
}

fn deleg_program_id() -> Pubkey {
    Pubkey::new_from_array(DELEGATION_PROGRAM_ID)
}

/// Borsh `Vec<Vec<u8>>` — what the delegation record replays to us.
fn borsh_seeds(seeds: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(seeds.len() as u32).to_le_bytes());
    for s in seeds {
        out.extend_from_slice(&(s.len() as u32).to_le_bytes());
        out.extend_from_slice(s);
    }
    out
}

fn callback_data(seeds: &[&[u8]]) -> Vec<u8> {
    let mut d = EXTERNAL_UNDELEGATE_DISCRIMINATOR.to_vec();
    d.extend_from_slice(&borsh_seeds(seeds));
    d
}

/// A modern 96-byte credit, as the ER would have committed it.
fn modern_credit_bytes(owner: &Pubkey, credit: u64) -> Vec<u8> {
    let mut d = vec![0u8; TradingCredit::LEN];
    d[0] = DISC_TRADING_CREDIT;
    d[1] = 254; // bump
    d[2..4].copy_from_slice(&MARKET_INDEX.to_le_bytes());
    d[8..40].copy_from_slice(&owner.to_bytes());
    d[40..48].copy_from_slice(&credit.to_le_bytes());
    d
}

/// The pre-session-keys 56-byte layout (first 56 bytes are byte-identical).
fn legacy_credit_bytes(owner: &Pubkey, credit: u64) -> Vec<u8> {
    modern_credit_bytes(owner, credit)[..LEGACY_LEN].to_vec()
}

/// The delegated account exactly as `dlp::close_pda` leaves it right before the
/// callback CPI: zero lamports, zero data, assigned to the system program.
fn closed_delegated_account() -> Account {
    Account {
        lamports: 0,
        data: vec![],
        owner: Pubkey::default(), // system program
        executable: false,
        rent_epoch: 0,
    }
}

/// The delegation program's undelegate buffer, holding the committed bytes.
fn buffer_account(data: Vec<u8>) -> Account {
    Account {
        lamports: 2_000_000,
        data,
        owner: deleg_program_id(),
        executable: false,
        rent_epoch: 0,
    }
}

struct Fixture {
    program_id: Pubkey,
    owner: Pubkey,
    credit_pk: Pubkey,
    buffer_pk: Pubkey,
    payer_pk: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
}

/// Build the exact account set the delegation program's `cpi_external_undelegate`
/// passes: [delegated (w), buffer (w, signer), payer (w, signer), system].
fn fixture(program_id: Pubkey, committed: Vec<u8>) -> Fixture {
    let owner = Pubkey::new_unique();
    let (credit_pk, _) = Pubkey::find_program_address(
        &[SEED_CREDIT, &owner.to_bytes(), &MARKET_INDEX.to_le_bytes()],
        &program_id,
    );
    let (buffer_pk, _) = Pubkey::find_program_address(
        &[UNDELEGATE_BUFFER_TAG, &credit_pk.to_bytes()],
        &deleg_program_id(),
    );
    let payer_pk = Pubkey::new_unique();

    let accounts = vec![
        (credit_pk, closed_delegated_account()),
        (buffer_pk, buffer_account(committed)),
        (
            payer_pk,
            Account {
                lamports: 1_000_000_000,
                ..Account::default()
            },
        ),
        keyed_account_for_system_program(),
    ];

    Fixture {
        program_id,
        owner,
        credit_pk,
        buffer_pk,
        payer_pk,
        accounts,
    }
}

impl Fixture {
    fn seeds(&self) -> Vec<Vec<u8>> {
        vec![
            SEED_CREDIT.to_vec(),
            self.owner.to_bytes().to_vec(),
            MARKET_INDEX.to_le_bytes().to_vec(),
        ]
    }

    fn instruction(&self, data: Vec<u8>, buffer: Pubkey) -> Instruction {
        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(self.credit_pk, false),
                AccountMeta::new(buffer, true),
                AccountMeta::new(self.payer_pk, true),
                AccountMeta::new_readonly(Pubkey::default(), false),
            ],
            data,
        }
    }
}

fn owned_seed_refs(seeds: &[Vec<u8>]) -> Vec<&[u8]> {
    seeds.iter().map(|s| s.as_slice()).collect()
}

/// THE defect: the 8-byte callback must ROUTE, re-create the PDA under this
/// program, and restore the committed bytes byte-for-byte (the delegation
/// program checks exactly that and otherwise aborts with
/// InvalidAccountDataAfterCPI).
#[test]
fn test_undelegation_callback_restores_modern_96_byte_credit() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let f = fixture(program_id, vec![]);

    const CREDIT: u64 = 20_000_000_000; // the largest live delegated credit, 20,000 USDC
    let committed = modern_credit_bytes(&f.owner, CREDIT);
    let f = Fixture {
        accounts: vec![
            f.accounts[0].clone(),
            (f.buffer_pk, buffer_account(committed.clone())),
            f.accounts[2].clone(),
            f.accounts[3].clone(),
        ],
        ..f
    };

    let seeds = f.seeds();
    let ix = f.instruction(callback_data(&owned_seed_refs(&seeds)), f.buffer_pk);
    let res = m.process_instruction(&ix, &f.accounts);

    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "the 8-byte undelegation callback must route instead of falling through \
         to InvalidInstructionData: {:?}",
        res.program_result
    );

    let (pk, restored) = &res.resulting_accounts[0];
    assert_eq!(pk, &f.credit_pk);
    assert_eq!(
        restored.owner, program_id,
        "the credit must come back owned by this program"
    );
    assert_eq!(
        restored.data, committed,
        "data must equal the buffer byte-for-byte or dlp aborts with \
         InvalidAccountDataAfterCPI"
    );
    assert!(restored.lamports > 0, "the re-created PDA must be rent-exempt");

    // Typed load must succeed on the restored bytes — this is what
    // withdraw_trading_credit / close_trading_credit then operate on.
    let credit = bytemuck::from_bytes::<TradingCredit>(&restored.data[..TradingCredit::LEN]);
    assert_eq!(credit.owner, f.owner.to_bytes());
    assert_eq!(credit.credit, CREDIT);
}

/// The 12 live delegated credits still on the 56-byte layout must come back too:
/// the handler sizes the new account from the BUFFER, never from a struct LEN.
#[test]
fn test_undelegation_callback_restores_legacy_56_byte_credit() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let f = fixture(program_id, vec![]);

    let committed = legacy_credit_bytes(&f.owner, 13_163_240_000);
    assert_eq!(committed.len(), LEGACY_LEN);
    let f = Fixture {
        accounts: vec![
            f.accounts[0].clone(),
            (f.buffer_pk, buffer_account(committed.clone())),
            f.accounts[2].clone(),
            f.accounts[3].clone(),
        ],
        ..f
    };

    let seeds = f.seeds();
    let ix = f.instruction(callback_data(&owned_seed_refs(&seeds)), f.buffer_pk);
    let res = m.process_instruction(&ix, &f.accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "{:?}",
        res.program_result
    );

    let restored = &res.resulting_accounts[0].1;
    assert_eq!(restored.owner, program_id);
    assert_eq!(restored.data.len(), LEGACY_LEN);
    assert_eq!(restored.data, committed);
}

/// Only the delegation program can sign for a PDA under the delegation program,
/// so the buffer address is the caller's identity proof. A buffer at any other
/// address must be refused — otherwise the callback becomes a public
/// "create this PDA with bytes I chose" instruction.
#[test]
fn test_callback_rejects_a_buffer_that_is_not_the_delegation_program_pda() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let f = fixture(program_id, vec![]);

    let committed = modern_credit_bytes(&f.owner, 999_000_000);
    let rogue_buffer = Pubkey::new_unique();
    let accounts = vec![
        f.accounts[0].clone(),
        (rogue_buffer, buffer_account(committed)),
        f.accounts[2].clone(),
        f.accounts[3].clone(),
    ];

    let seeds = f.seeds();
    let ix = f.instruction(callback_data(&owned_seed_refs(&seeds)), rogue_buffer);
    let res = m.process_instruction(&ix, &accounts);
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(ProgramError::Custom(SlipstreamError::InvalidPda as u32)),
    );
}

/// The replayed seeds must derive the account being re-created, or the callback
/// could be steered at an address this program never registered.
#[test]
fn test_callback_rejects_seeds_that_do_not_derive_the_delegated_account() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let f = fixture(program_id, modern_credit_bytes(&Pubkey::new_unique(), 1));

    // Right shape, wrong owner seed => a different PDA.
    let stranger = Pubkey::new_unique();
    let seeds = vec![
        SEED_CREDIT.to_vec(),
        stranger.to_bytes().to_vec(),
        MARKET_INDEX.to_le_bytes().to_vec(),
    ];
    let ix = f.instruction(callback_data(&owned_seed_refs(&seeds)), f.buffer_pk);
    let res = m.process_instruction(&ix, &f.accounts);
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(ProgramError::Custom(SlipstreamError::InvalidPda as u32)),
    );
}

/// A truncated seeds payload must be rejected, not read past its end.
#[test]
fn test_callback_rejects_a_truncated_seeds_payload() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let f = fixture(program_id, modern_credit_bytes(&Pubkey::new_unique(), 1));

    let seeds = f.seeds();
    let mut data = callback_data(&owned_seed_refs(&seeds));
    data.truncate(data.len() - 8);
    let ix = f.instruction(data, f.buffer_pk);
    let res = m.process_instruction(&ix, &f.accounts);
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(ProgramError::InvalidInstructionData),
    );
}

/// The one-byte instruction space is untouched: 0xC4 is outside 0x00..=0x2A, and
/// an unknown one-byte discriminator must still be rejected the same way.
#[test]
fn test_one_byte_dispatch_still_rejects_unknown_discriminators() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let f = fixture(program_id, modern_credit_bytes(&Pubkey::new_unique(), 1));

    let ix = f.instruction(vec![0x7Fu8], f.buffer_pk);
    let res = m.process_instruction(&ix, &f.accounts);
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(ProgramError::InvalidInstructionData),
    );
}
