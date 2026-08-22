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
use crate::state::{
    FillLogHeader, GlobalState, DISC_FILL_LOG, SEED_DELEGATE_BUFFER, SEED_FILL_LOG, SEED_GLOBAL,
};

// MagicBlock delegation program: DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh
const DELEGATION_PROGRAM_ID: Pubkey = [
    0xB5, 0xB7, 0x00, 0xE1, 0xF2, 0x57, 0x3A, 0xC0,
    0xCC, 0x06, 0x22, 0x01, 0x34, 0x4A, 0xCF, 0x97,
    0xB8, 0x35, 0x06, 0xEB, 0x8C, 0xE5, 0x19, 0x98,
    0xCC, 0x62, 0x7E, 0x18, 0x93, 0x80, 0xA7, 0x3E,
];

const DELEGATION_RECORD_TAG: &[u8] = b"delegation";
const DELEGATION_METADATA_TAG: &[u8] = b"delegation-metadata";

/// Commit only on explicit commit (not on a timer), same as the orderbook/credit.
const COMMIT_FREQUENCY_MS: u32 = u32::MAX;

/// delegate_fill_log (disc 0x1E): delegate a FillLog PDA to the MagicBlock ER.
///
/// This is the SMALL-account delegate flow (identical in structure to the
/// working `delegate_trading_credit`): the FillLog (~8 KB) fits under the
/// 10,240-byte CPI growth cap, so the delegate buffer is created + populated in a
/// single CreateAccount CPI. Because it is small it can later be undelegated and
/// re-delegated cleanly (or rotated by epoch) to refresh the sponsored-commit
/// budget — the thing the oversized OrderBook can never do.
///
/// Accounts:
///   [0] payer               (signer, writable) — funds the buffer rent (= authority)
///   [1] fill_log            (writable)         — the delegated PDA (this program signs)
///   [2] global_state        (read)             — authority gate
///   [3] owner_program       (read)             — THIS program's id
///   [4] delegate_buffer     (writable)         — [b"buffer", fill_log] under this program
///   [5] delegation_record   (writable)         — [b"delegation", fill_log] under delegation program
///   [6] delegation_metadata (writable)         — [b"delegation-metadata", fill_log] under delegation program
///   [7] delegation_program  (read)
///   [8] system_program      (read)
///
/// Instruction data: market_index: u16, epoch: u32 (6 bytes)
const IX_DATA_LEN: usize = 2 + 4;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [
        payer,
        fill_log_acc,
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
    if owner_program_acc.key() != program_id {
        return Err(SlipstreamError::InvalidProgramId.into());
    }
    if *delegation_program.key() != DELEGATION_PROGRAM_ID {
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
    // S10-01: accept the installed keeper as well as the admin key, so the
    // fill-log keeper VM no longer has to hold the key that is also the BPF
    // upgrade authority and the USDC mint authority. A stranger is still
    // refused, and an unextended GlobalState still accepts `authority` alone.
    let global_data = unsafe { global_state_acc.borrow_data_unchecked() };
    if !GlobalState::is_authority_or_keeper(global_data, payer.key()) {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index = u16::from_le_bytes([data[0], data[1]]);
    let epoch = u32::from_le_bytes([data[2], data[3], data[4], data[5]]);
    let market_index_bytes = market_index.to_le_bytes();
    let epoch_bytes = epoch.to_le_bytes();

    // Validate the FillLog account + PDA, and confirm the header matches.
    {
        let fl_data = unsafe { fill_log_acc.borrow_data_unchecked() };
        if fl_data.len() < FillLogHeader::LEN || fl_data[0] != DISC_FILL_LOG {
            return Err(ProgramError::InvalidAccountData);
        }
        let header: &FillLogHeader = bytemuck::from_bytes(&fl_data[..FillLogHeader::LEN]);
        if header.market_index != market_index || header.epoch != epoch {
            return Err(SlipstreamError::InvalidPda.into());
        }
    }

    let (expected_pda, bump) = pinocchio::pubkey::find_program_address(
        &[SEED_FILL_LOG, &market_index_bytes, &epoch_bytes],
        program_id,
    );
    if fill_log_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    if !fill_log_acc.is_owned_by(program_id) {
        return Err(SlipstreamError::InvalidProgramId.into());
    }

    let fl_len = fill_log_acc.data_len();

    let (buffer_pda, buffer_bump) = pinocchio::pubkey::find_program_address(
        &[SEED_DELEGATE_BUFFER, fill_log_acc.key().as_ref()],
        program_id,
    );
    if buffer_acc.key() != &buffer_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let (record_pda, _r) = pinocchio::pubkey::find_program_address(
        &[DELEGATION_RECORD_TAG, fill_log_acc.key().as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    if delegation_record_acc.key() != &record_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    let (metadata_pda, _m) = pinocchio::pubkey::find_program_address(
        &[DELEGATION_METADATA_TAG, fill_log_acc.key().as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    if delegation_metadata_acc.key() != &metadata_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let fl_bump_bytes = [bump];
    let fl_signer_seeds = seeds![SEED_FILL_LOG, &market_index_bytes, &epoch_bytes, &fl_bump_bytes];

    // Step 1: create the delegate buffer at the FillLog's exact size, copy bytes in.
    {
        let rent = Rent::get()?;
        let buffer_lamports = rent.minimum_balance(fl_len);
        let buffer_bump_bytes = [buffer_bump];
        let buffer_seeds = seeds![
            SEED_DELEGATE_BUFFER,
            fill_log_acc.key().as_ref(),
            &buffer_bump_bytes
        ];
        CreateAccount {
            from: payer,
            to: buffer_acc,
            lamports: buffer_lamports,
            space: fl_len as u64,
            owner: program_id,
        }
        .invoke_signed(&[Signer::from(&buffer_seeds)])?;

        let fl_data = unsafe { fill_log_acc.borrow_data_unchecked() };
        let buf_data = unsafe { buffer_acc.borrow_mut_data_unchecked() };
        buf_data.copy_from_slice(&fl_data[..fl_len]);
    }

    // Step 2: zero the FillLog so it can be reassigned.
    {
        let fl_data = unsafe { fill_log_acc.borrow_mut_data_unchecked() };
        unsafe { pinocchio::memory::sol_memset(fl_data, 0, fl_data.len()) };
    }

    // Step 3: assign FillLog → delegation program.
    if fill_log_acc.owner() != &pinocchio_system::ID {
        unsafe { fill_log_acc.assign(&pinocchio_system::ID) };
    }
    Assign {
        account: fill_log_acc,
        owner: &DELEGATION_PROGRAM_ID,
    }
    .invoke_signed(&[Signer::from(&fl_signer_seeds)])?;

    // Step 4: build delegation `delegate` ix data (disc=0u64, commit_freq u32,
    // seeds vec [SEED_FILL_LOG, market_index_le, epoch_le], validator None).
    let mut ix_data = [0u8; 96];
    let mut off = 0usize;
    off += 8; // discriminator (zero)
    ix_data[off..off + 4].copy_from_slice(&COMMIT_FREQUENCY_MS.to_le_bytes());
    off += 4;
    ix_data[off..off + 4].copy_from_slice(&3u32.to_le_bytes()); // seeds vec len = 3
    off += 4;
    // seed[0]: SEED_FILL_LOG
    ix_data[off..off + 4].copy_from_slice(&(SEED_FILL_LOG.len() as u32).to_le_bytes());
    off += 4;
    ix_data[off..off + SEED_FILL_LOG.len()].copy_from_slice(SEED_FILL_LOG);
    off += SEED_FILL_LOG.len();
    // seed[1]: market_index_bytes (2)
    ix_data[off..off + 4].copy_from_slice(&(market_index_bytes.len() as u32).to_le_bytes());
    off += 4;
    ix_data[off..off + market_index_bytes.len()].copy_from_slice(&market_index_bytes);
    off += market_index_bytes.len();
    // seed[2]: epoch_bytes (4)
    ix_data[off..off + 4].copy_from_slice(&(epoch_bytes.len() as u32).to_le_bytes());
    off += 4;
    ix_data[off..off + epoch_bytes.len()].copy_from_slice(&epoch_bytes);
    off += epoch_bytes.len();
    // validator option = None
    ix_data[off] = 0;
    off += 1;

    let account_metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable_signer(fill_log_acc.key()),
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
    invoke_signed(
        &instruction,
        &[
            payer,
            fill_log_acc,
            owner_program_acc,
            buffer_acc,
            delegation_record_acc,
            delegation_metadata_acc,
            system_program,
        ],
        &[Signer::from(&fl_signer_seeds)],
    )?;

    // Step 5: close the buffer PDA, returning rent to the payer.
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
