use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::{GlobalState, UserAccount, SEED_GLOBAL};

/// Keeper instruction: increments `UserAccount.pending_fills` for each user
/// listed. Called by the settlement keeper immediately when it observes a new
/// fill on the ER queue, before submitting `settle_trades`. The same keeper
/// bundles both transactions via Jito so they land atomically.
///
/// Instruction data:
///   num_users: u16 (number of unique user accounts being bumped)
///
/// Accounts:
///   [0] global_state (read)    — authority gate
///   [1] authority    (signer)  — must equal GlobalState.authority
///   [2..] exactly `num_users` UserAccount PDAs, all writable.
///
/// Security: this was previously permissionless, with only an `acc.owner() ==
/// program_id` check per listed account and no cap tying the bump to a real
/// fill. `pending_fills` is a monotonic counter decremented one-per-settled-fill
/// by settle_trades/settle_from_log, with no user- or admin-facing reset path,
/// and it gates BOTH withdraw_collateral/close_user_account AND liquidation
/// (liquidate_position routes into the pending-fills grace window whenever it is
/// nonzero). Unauthenticated, it was a permanent, unbounded DoS on any listed
/// victim's withdrawals (bump toward u16::MAX; recovering requires that many
/// real fills) and a self-liquidation immunity switch (bump your own account
/// once, and every liquidation attempt against you detours into the grace
/// window instead of settling) — not "temporarily block", as the comment this
/// replaces claimed. Now requires the same authority signer every other
/// admin/keeper-gated instruction requires.
const IX_DATA_LEN: usize = 2;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [global_state_acc, authority, remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
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
    if !GlobalState::is_authority_or_keeper(global_data, authority.key()) {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let num_users = u16::from_le_bytes([data[0], data[1]]) as usize;
    if num_users == 0 || num_users > remaining.len() {
        return Err(ProgramError::InvalidInstructionData);
    }

    for acc in &remaining[..num_users] {
        if acc.owner() != program_id {
            return Err(ProgramError::IllegalOwner);
        }
        let user = UserAccount::from_account_info_mut(acc)?;
        user.pending_fills = user
            .pending_fills
            .checked_add(1)
            .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
    }

    Ok(())
}
