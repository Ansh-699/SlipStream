use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction, Signer},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    seeds,
    ProgramResult,
};
use pinocchio_system::instructions::Assign;

use crate::error::SlipstreamError;
use crate::state::{GlobalState, SEED_DELEGATE_BUFFER, SEED_GLOBAL, SEED_ORDERBOOK};

// MagicBlock delegation program: DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh
const DELEGATION_PROGRAM_ID: Pubkey = [
    0xB5, 0xB7, 0x00, 0xE1, 0xF2, 0x57, 0x3A, 0xC0,
    0xCC, 0x06, 0x22, 0x01, 0x34, 0x4A, 0xCF, 0x97,
    0xB8, 0x35, 0x06, 0xEB, 0x8C, 0xE5, 0x19, 0x98,
    0xCC, 0x62, 0x7E, 0x18, 0x93, 0x80, 0xA7, 0x3E,
];

/// MagicBlock delegation `delegate` seed tags (must match the delegation program's
/// PDA derivations — see the installed `@magicblock-labs/ephemeral-rollups-sdk`).
const DELEGATION_RECORD_TAG: &[u8] = b"delegation";
const DELEGATION_METADATA_TAG: &[u8] = b"delegation-metadata";

/// Commit frequency (ms) recorded in the delegation record. The SDK default is
/// `u32::MAX` (≈ "commit only on undelegate"); we use that so the ER is not forced
/// to commit the orderbook on a timer — commits happen on settlement/undelegate.
const COMMIT_FREQUENCY_MS: u32 = u32::MAX;

/// delegate_orderbook instruction data: market_index: u16
const IX_DATA_LEN: usize = 2;

/// Finalize delegation of the OrderBook PDA to the MagicBlock ER.
///
/// Preconditions (enforced):
///   - The OrderBook is at its full size and owned by THIS program.
///   - `delegate_orderbook_prepare` has already populated the delegate buffer PDA
///     to the full OrderBook size (a byte-for-byte mirror).
///
/// Mechanics (mirrors the MagicBlock SDK `delegate_account`, adapted for an
/// account too large to buffer in a single CPI — the buffer is built beforehand
/// by `delegate_orderbook_prepare`):
///   1. Validate the buffer PDA is initialized, owned by this program, and exactly
///      the OrderBook's length.
///   2. Zero the OrderBook data and reassign it System → delegation program. Solana
///      requires the data to be zeroed before an account can be reassigned to
///      another owner; the delegation program restores the bytes from the buffer.
///   3. CPI the delegation program's `delegate` (discriminator 0u64, then
///      commit_frequency_ms: u32, seeds vec, validator option). The delegation
///      program copies the buffer back into the OrderBook, then creates the
///      delegation record + metadata PDAs.
///   4. Close the buffer PDA, returning its rent to the payer.
///
/// Accounts:
///   [0] payer               (signer, writable) — must equal GlobalState.authority
///   [1] order_book          (writable)         — the delegated account (PDA; this program signs)
///   [2] global_state        (read)             — authority gate
///   [3] owner_program       (read)             — THIS program's account id (delegation reads it)
///   [4] delegate_buffer     (writable)         — `[b"buffer", order_book]` under this program
///   [5] delegation_record   (writable)         — `[b"delegation", order_book]` under delegation program
///   [6] delegation_metadata (writable)         — `[b"delegation-metadata", order_book]` under delegation program
///   [7] delegation_program  (read)
///   [8] system_program      (read)
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [
        payer,
        order_book_acc,
        global_state_acc,
        owner_program_acc,
        buffer_acc,
        delegation_record_acc,
        delegation_metadata_acc,
        delegation_program,
        system_program,
        _remaining @ ..
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system_program.key() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    // The owner_program account passed for the delegation CPI must be THIS program.
    if owner_program_acc.key() != program_id {
        return Err(SlipstreamError::InvalidProgramId.into());
    }

    // GlobalState is only ever READ here, so a forged (attacker-owned) account is
    // not caught by the runtime's write protection — pin owner + PDA first.
    if global_state_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (global_pda, _) = pinocchio::pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    if global_state_acc.key() != &global_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    let global = GlobalState::from_account_info(global_state_acc)?;
    if global.authority != *payer.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    if *delegation_program.key() != DELEGATION_PROGRAM_ID {
        return Err(SlipstreamError::InvalidProgramId.into());
    }

    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index = u16::from_le_bytes([data[0], data[1]]);
    let market_index_bytes = market_index.to_le_bytes();

    let (expected_pda, ob_bump) =
        pinocchio::pubkey::find_program_address(&[SEED_ORDERBOOK, &market_index_bytes], program_id);
    if order_book_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    // The OrderBook must still be owned by this program (not already delegated).
    if !order_book_acc.is_owned_by(program_id) {
        return Err(SlipstreamError::InvalidProgramId.into());
    }

    let ob_len = order_book_acc.data_len();

    // Validate the prepared delegate buffer PDA.
    let (buffer_pda, _buffer_bump) = pinocchio::pubkey::find_program_address(
        &[SEED_DELEGATE_BUFFER, order_book_acc.key().as_ref()],
        program_id,
    );
    if buffer_acc.key() != &buffer_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    if !buffer_acc.is_owned_by(program_id) {
        return Err(SlipstreamError::InvalidProgramId.into());
    }
    // The buffer must be fully staged: exactly the OrderBook length. If not, the
    // caller must finish running `delegate_orderbook_prepare` first.
    if buffer_acc.data_len() != ob_len {
        return Err(SlipstreamError::AccountNotInitialized.into());
    }

    // Validate the delegation record / metadata PDAs (uninitialized; created by CPI).
    let (record_pda, _record_bump) = pinocchio::pubkey::find_program_address(
        &[DELEGATION_RECORD_TAG, order_book_acc.key().as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    if delegation_record_acc.key() != &record_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    let (metadata_pda, _metadata_bump) = pinocchio::pubkey::find_program_address(
        &[DELEGATION_METADATA_TAG, order_book_acc.key().as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    if delegation_metadata_acc.key() != &metadata_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let ob_bump_bytes = [ob_bump];
    let ob_signer_seeds = seeds![SEED_ORDERBOOK, &market_index_bytes, &ob_bump_bytes];

    // Step 1: zero the OrderBook data so it can be reassigned to another owner.
    {
        let ob_data = unsafe { order_book_acc.borrow_mut_data_unchecked() };
        unsafe { pinocchio::memory::sol_memset(ob_data, 0, ob_data.len()) };
    }

    // Step 2: assign OrderBook → delegation program. The System program's `Assign`
    // can only reassign an account it CURRENTLY owns, so we follow the MagicBlock
    // SDK two-step sequence:
    //   (a) directly write the owner to the System program — permitted because this
    //       program owns the account and its data is now zeroed; and
    //   (b) System `Assign` CPI (System → delegation program), signed by the
    //       OrderBook PDA seeds.
    // The delegation program's `process_delegate` then requires the delegated
    // account to already be owned by it.
    if order_book_acc.owner() != &pinocchio_system::ID {
        unsafe { order_book_acc.assign(&pinocchio_system::ID) };
    }
    Assign {
        account: order_book_acc,
        owner: &DELEGATION_PROGRAM_ID,
    }
    .invoke_signed(&[Signer::from(&ob_signer_seeds)])?;

    // Step 3: build the delegation `delegate` instruction data:
    //   discriminator: u64 = 0
    //   commit_frequency_ms: u32
    //   seeds: vec<vec<u8>>  (the OrderBook PDA seeds, so the delegation program can re-derive it)
    //   validator: option<pubkey>  (None => single 0 byte)
    //
    // Seeds passed are exactly the OrderBook derivation seeds (NOT the bump):
    //   seed[0] = SEED_ORDERBOOK (b"orderbook")
    //   seed[1] = market_index_bytes (u16 LE)
    let mut ix_data = [0u8; 64];
    let mut off = 0usize;
    // discriminator (8 bytes, zero)
    off += 8;
    // commit_frequency_ms (u32 LE)
    ix_data[off..off + 4].copy_from_slice(&COMMIT_FREQUENCY_MS.to_le_bytes());
    off += 4;
    // seeds vec length (u32 LE) = 2
    ix_data[off..off + 4].copy_from_slice(&2u32.to_le_bytes());
    off += 4;
    // seed[0]: SEED_ORDERBOOK
    ix_data[off..off + 4].copy_from_slice(&(SEED_ORDERBOOK.len() as u32).to_le_bytes());
    off += 4;
    ix_data[off..off + SEED_ORDERBOOK.len()].copy_from_slice(SEED_ORDERBOOK);
    off += SEED_ORDERBOOK.len();
    // seed[1]: market_index_bytes (2 bytes)
    ix_data[off..off + 4].copy_from_slice(&(market_index_bytes.len() as u32).to_le_bytes());
    off += 4;
    ix_data[off..off + market_index_bytes.len()].copy_from_slice(&market_index_bytes);
    off += market_index_bytes.len();
    // validator option = None (single 0 byte)
    ix_data[off] = 0;
    off += 1;

    let account_metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable_signer(order_book_acc.key()),
        AccountMeta::readonly(owner_program_acc.key()),
        AccountMeta::writable(buffer_acc.key()),
        AccountMeta::writable(delegation_record_acc.key()),
        AccountMeta::writable(delegation_metadata_acc.key()),
        AccountMeta::readonly(&pinocchio_system::ID),
    ];

    let instruction = Instruction {
        program_id: &DELEGATION_PROGRAM_ID,
        accounts: &account_metas,
        data: &ix_data[..off],
    };

    // The OrderBook PDA must sign (delegated account signer). `payer` signs at the
    // tx level. The owner program (this program) is referenced read-only.
    invoke_signed(
        &instruction,
        &[
            payer,
            order_book_acc,
            owner_program_acc,
            buffer_acc,
            delegation_record_acc,
            delegation_metadata_acc,
            system_program,
        ],
        &[Signer::from(&ob_signer_seeds)],
    )?;

    // Step 4: close the buffer PDA, returning rent to the payer.
    {
        let buf_lamports = buffer_acc.lamports();
        unsafe {
            *payer.borrow_mut_lamports_unchecked() += buf_lamports;
            *buffer_acc.borrow_mut_lamports_unchecked() = 0;
        }
        buffer_acc.resize(0)?;
        unsafe { buffer_acc.assign(&pinocchio_system::ID) };
    }

    Ok(())
}
