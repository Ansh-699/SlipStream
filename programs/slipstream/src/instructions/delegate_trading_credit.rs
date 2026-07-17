use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction, Signer},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    seeds,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::{Assign, CreateAccount};

use crate::error::SlipstreamError;
use crate::state::{TradingCredit, SEED_CREDIT, SEED_DELEGATE_BUFFER};

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
/// to commit the credit on a timer — it commits on undelegate.
const COMMIT_FREQUENCY_MS: u32 = u32::MAX;

/// Instruction data (optional): the SESSION authority + expiry to authorize as
/// part of delegation, so "delegate + authorize session" is ONE signature/tx:
///   session_authority: [u8; 32]
///   session_expiry:    i64        (unix secs; 0 = no session)
/// Total 40 bytes (after the 1-byte dispatcher discriminator is stripped).
///
/// Backward compatible: any data shorter than 40 bytes (e.g. the legacy 8-byte
/// `valid_until` the old builder passed) simply leaves the session fields at
/// their current value, so older clients still delegate without a session.
const SESSION_DATA_LEN: usize = 32 + 8;

/// Finalize delegation of a user's `TradingCredit` PDA to the MagicBlock ER.
///
/// This mirrors the working `delegate_orderbook` flow and the MagicBlock SDK
/// `createDelegateInstruction`. The earlier implementation built only four CPI
/// account metas while forwarding three `AccountInfo`s (so Pinocchio reverted
/// with `NotEnoughAccountKeys`) AND used the wrong instruction-data ABI (an
/// Anchor discriminator instead of the zero-discriminator + seeds-vec the
/// delegation program expects). Both are fixed here.
///
/// Unlike the ~612 KB OrderBook (which needs the chunked `delegate_orderbook_prepare`
/// dance to stage its buffer under the 10,240-byte CPI growth cap), the
/// `TradingCredit` is tiny (96 bytes), so the delegate buffer is created and
/// populated inline in a single `CreateAccount` CPI before the delegate CPI.
///
/// Accounts:
///   [0] payer               (signer, writable) — funds the buffer rent (= owner)
///   [1] trading_credit      (writable)         — the delegated PDA (this program signs)
///   [2] owner               (signer)           — credit owner; authority gate
///   [3] owner_program       (read)             — THIS program's account id (delegation reads it)
///   [4] delegate_buffer     (writable)         — `[b"buffer", trading_credit]` under this program
///   [5] delegation_record   (writable)         — `[b"delegation", trading_credit]` under delegation program
///   [6] delegation_metadata (writable)         — `[b"delegation-metadata", trading_credit]` under delegation program
///   [7] delegation_program  (read)
///   [8] system_program      (read)
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [
        payer,
        trading_credit_acc,
        owner,
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
    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system_program.key() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    // The owner_program account passed for the delegation CPI must be THIS program.
    if owner_program_acc.key() != program_id {
        return Err(SlipstreamError::InvalidProgramId.into());
    }
    if *delegation_program.key() != DELEGATION_PROGRAM_ID {
        return Err(SlipstreamError::InvalidProgramId.into());
    }

    // Validate the credit account, owner, and PDA before any mutation.
    let market_index_bytes = {
        let credit = TradingCredit::from_account_info(trading_credit_acc)?;
        if credit.owner != *owner.key() {
            return Err(SlipstreamError::InvalidAuthority.into());
        }
        credit.market_index.to_le_bytes()
    };

    let (expected_pda, bump) = pinocchio::pubkey::find_program_address(
        &[SEED_CREDIT, owner.key().as_ref(), &market_index_bytes],
        program_id,
    );
    if trading_credit_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    // The credit must still be owned by this program (i.e. not already delegated).
    if !trading_credit_acc.is_owned_by(program_id) {
        return Err(SlipstreamError::InvalidProgramId.into());
    }

    let credit_len = trading_credit_acc.data_len();

    // Validate the delegate buffer PDA (created here, under THIS program).
    let (buffer_pda, buffer_bump) = pinocchio::pubkey::find_program_address(
        &[SEED_DELEGATE_BUFFER, trading_credit_acc.key().as_ref()],
        program_id,
    );
    if buffer_acc.key() != &buffer_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    // Validate the delegation record / metadata PDAs (uninitialized; created by CPI).
    let (record_pda, _record_bump) = pinocchio::pubkey::find_program_address(
        &[DELEGATION_RECORD_TAG, trading_credit_acc.key().as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    if delegation_record_acc.key() != &record_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    let (metadata_pda, _metadata_bump) = pinocchio::pubkey::find_program_address(
        &[DELEGATION_METADATA_TAG, trading_credit_acc.key().as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    if delegation_metadata_acc.key() != &metadata_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let credit_bump_bytes = [bump];
    let credit_signer_seeds = seeds![
        SEED_CREDIT,
        owner.key().as_ref(),
        &market_index_bytes,
        &credit_bump_bytes
    ];

    // Step 0: if the instruction data carries a session authority + expiry,
    // write them into the (still program-owned) TradingCredit BEFORE the
    // copy-to-buffer/zero/assign/delegate dance, so the committed buffer (and
    // therefore the ER copy) includes the authorized session key. The owner
    // signs this instruction, so authorizing the session is owner-gated.
    if data.len() >= SESSION_DATA_LEN {
        let mut session_authority = [0u8; 32];
        session_authority.copy_from_slice(&data[..32]);
        let session_expiry = i64::from_le_bytes(data[32..40].try_into().unwrap());
        let credit = TradingCredit::from_account_info_mut(trading_credit_acc)?;
        credit.session_authority = session_authority;
        credit.session_expiry = session_expiry;
    }

    // Step 1: create the delegate buffer PDA at the credit's exact size and copy
    // the credit bytes into it. The TradingCredit (96 bytes) is far below the
    // 10,240-byte CPI growth cap, so a single CreateAccount CPI suffices (no need
    // for the chunked prepare dance the OrderBook requires). The delegation
    // program restores the account data from this buffer after the owner change.
    {
        let rent = Rent::get()?;
        let buffer_lamports = rent.minimum_balance(credit_len);
        let buffer_bump_bytes = [buffer_bump];
        let buffer_seeds = seeds![
            SEED_DELEGATE_BUFFER,
            trading_credit_acc.key().as_ref(),
            &buffer_bump_bytes
        ];
        CreateAccount {
            from: payer,
            to: buffer_acc,
            lamports: buffer_lamports,
            space: credit_len as u64,
            owner: program_id,
        }
        .invoke_signed(&[Signer::from(&buffer_seeds)])?;

        let credit_data = unsafe { trading_credit_acc.borrow_data_unchecked() };
        let buf_data = unsafe { buffer_acc.borrow_mut_data_unchecked() };
        buf_data.copy_from_slice(&credit_data[..credit_len]);
    }

    // Step 2: zero the credit data so it can be reassigned to another owner.
    {
        let credit_data = unsafe { trading_credit_acc.borrow_mut_data_unchecked() };
        unsafe { pinocchio::memory::sol_memset(credit_data, 0, credit_data.len()) };
    }

    // Step 3: assign credit → delegation program (System Assign can only reassign
    // an account it currently owns, so directly write the owner to System first —
    // permitted because this program owns the now-zeroed account — then Assign via
    // CPI signed by the credit PDA seeds).
    if trading_credit_acc.owner() != &pinocchio_system::ID {
        unsafe { trading_credit_acc.assign(&pinocchio_system::ID) };
    }
    Assign {
        account: trading_credit_acc,
        owner: &DELEGATION_PROGRAM_ID,
    }
    .invoke_signed(&[Signer::from(&credit_signer_seeds)])?;

    // Step 4: build the delegation `delegate` instruction data (matches the SDK's
    // serializeDelegateInstructionData and delegate_orderbook):
    //   discriminator: u64 = 0
    //   commit_frequency_ms: u32
    //   seeds: vec<vec<u8>>  (the credit PDA derivation seeds, no bump)
    //   validator: option<pubkey>  (None => single 0 byte)
    let mut ix_data = [0u8; 128];
    let mut off = 0usize;
    // discriminator (8 bytes, zero)
    off += 8;
    // commit_frequency_ms (u32 LE)
    ix_data[off..off + 4].copy_from_slice(&COMMIT_FREQUENCY_MS.to_le_bytes());
    off += 4;
    // seeds vec length (u32 LE) = 3
    ix_data[off..off + 4].copy_from_slice(&3u32.to_le_bytes());
    off += 4;
    // seed[0]: SEED_CREDIT
    ix_data[off..off + 4].copy_from_slice(&(SEED_CREDIT.len() as u32).to_le_bytes());
    off += 4;
    ix_data[off..off + SEED_CREDIT.len()].copy_from_slice(SEED_CREDIT);
    off += SEED_CREDIT.len();
    // seed[1]: owner pubkey (32 bytes)
    ix_data[off..off + 4].copy_from_slice(&32u32.to_le_bytes());
    off += 4;
    ix_data[off..off + 32].copy_from_slice(owner.key().as_ref());
    off += 32;
    // seed[2]: market_index_bytes (2 bytes)
    ix_data[off..off + 4].copy_from_slice(&(market_index_bytes.len() as u32).to_le_bytes());
    off += 4;
    ix_data[off..off + market_index_bytes.len()].copy_from_slice(&market_index_bytes);
    off += market_index_bytes.len();
    // validator option = None (single 0 byte)
    ix_data[off] = 0;
    off += 1;

    let account_metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable_signer(trading_credit_acc.key()),
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

    // EVERY meta has a corresponding AccountInfo forwarded (7 metas, 7 infos), so
    // account_infos.len() >= metas.len() and Pinocchio no longer reverts with
    // NotEnoughAccountKeys. The credit PDA signs via invoke_signed.
    invoke_signed(
        &instruction,
        &[
            payer,
            trading_credit_acc,
            owner_program_acc,
            buffer_acc,
            delegation_record_acc,
            delegation_metadata_acc,
            system_program,
        ],
        &[Signer::from(&credit_signer_seeds)],
    )?;

    // Step 5: close the buffer PDA, returning its rent to the payer.
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
