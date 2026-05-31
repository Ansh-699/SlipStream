use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction, Signer},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    seeds,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::{GlobalState, SEED_ORDERBOOK};

/// emergency_undelegate
///
/// Authority-gated forcible commit + undelegate of a delegated account (typically
/// the OrderBook). Used when:
///   - The ER misbehaves (proven fraud)
///   - The 24h session timeout is too far away for an ongoing incident
///   - Operations need to drop into degraded mode (L1 matching) immediately
///
/// In production this should be gated on a 2-of-3 emergency multisig (§21). For
/// MVP we accept the GlobalState.authority signer; replacing it with a Squads
/// multisig PDA is a single field change in `GlobalState`.
///
/// Instruction data:
///   market_index: u16
///
/// Accounts:
///   [0] payer                  (signer, writable — pays for any rent in CPI)
///   [1] order_book             (writable — the delegated account)
///   [2] global_state           (read)
///   [3] authority              (signer — must equal `global_state.authority`)
///   [4] magic_context          (read)
///   [5] magic_program          (read)
///   [6] delegation_program     (read)
///   [7] system_program         (read)
const IX_DATA_LEN: usize = 2;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [
        payer,
        order_book_acc,
        global_state_acc,
        authority,
        magic_context,
        magic_program,
        delegation_program,
        system_program,
        _remaining @ ..
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let global = GlobalState::from_account_info(global_state_acc)?;
    if global.authority != *authority.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    let market_index = u16::from_le_bytes([data[0], data[1]]);
    let market_index_bytes = market_index.to_le_bytes();
    let (expected_pda, bump) = pinocchio::pubkey::find_program_address(
        &[SEED_ORDERBOOK, &market_index_bytes],
        program_id,
    );
    if order_book_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let bump_bytes = [bump];
    let signer_seeds = seeds![SEED_ORDERBOOK, &market_index_bytes, &bump_bytes];

    // Step 1: commit ER state to L1
    let commit_data: [u8; 8] = [82, 104, 152, 228, 209, 208, 105, 105];
    let commit_metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable(order_book_acc.key()),
        AccountMeta::readonly(magic_context.key()),
    ];
    let commit_ix = Instruction {
        program_id: magic_program.key(),
        accounts: &commit_metas,
        data: &commit_data,
    };
    invoke_signed(
        &commit_ix,
        &[payer, order_book_acc, magic_context],
        &[Signer::from(&signer_seeds)],
    )?;

    // Step 2: undelegate
    let undelegate_data: [u8; 8] = [131, 148, 82, 248, 89, 223, 190, 255];
    let undelegate_metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable(order_book_acc.key()),
        AccountMeta::readonly(program_id),
        AccountMeta::readonly(&pinocchio_system::ID),
    ];
    let undelegate_ix = Instruction {
        program_id: delegation_program.key(),
        accounts: &undelegate_metas,
        data: &undelegate_data,
    };
    invoke_signed(
        &undelegate_ix,
        &[payer, order_book_acc, system_program],
        &[Signer::from(&signer_seeds)],
    )?;

    // Step 3: pause the entire protocol so no new orders land while operators investigate
    let global_mut = GlobalState::from_account_info_mut(global_state_acc)?;
    global_mut.paused = 1;

    Ok(())
}
