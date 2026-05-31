use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::UserAccount;

/// Permissionless keeper instruction: increments `UserAccount.pending_fills` for
/// each user listed. Called by the settlement keeper immediately when it observes
/// a new fill on the ER queue, before submitting `settle_trades`. The same keeper
/// bundles both transactions via Jito so they land atomically.
///
/// Instruction data:
///   num_users: u16 (number of unique user accounts being bumped)
///
/// Accounts: exactly `num_users` UserAccount PDAs, all writable.
///
/// Security: no signer requirement (permissionless). The only effect is incrementing
/// `pending_fills`, which is a monotonic counter. The counter is decremented by
/// `settle_trades`; a malicious keeper bumping it without a real fill would
/// temporarily block that user's withdrawal, which is a DoS, not a theft. Mitigate
/// by requiring the caller to hold some bond at the program level (deferred).
const IX_DATA_LEN: usize = 2;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let num_users = u16::from_le_bytes([data[0], data[1]]) as usize;
    if num_users == 0 || num_users > accounts.len() {
        return Err(ProgramError::InvalidInstructionData);
    }

    for acc in &accounts[..num_users] {
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
