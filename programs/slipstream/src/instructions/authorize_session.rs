use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::TradingCredit;

/// authorize_session
///
/// Owner-signed instruction to set / rotate / clear the SESSION authority on a
/// `TradingCredit` WITHOUT re-delegating. Run it on whichever layer currently
/// owns the credit (this program): the base layer for a non-delegated credit,
/// or the ER for a delegated credit (the program owns the delegated account's
/// logic on the ER, so this write lands in the ER copy). This lets the user
/// rotate the session key or extend the expiry with a single owner signature.
///
/// To CLEAR a session, pass an all-zero authority (and/or expiry 0).
///
/// Accounts:
///   [0] trading_credit (writable) — owned by this program (base) or the ER copy
///   [1] owner          (signer)   — must equal credit.owner
///
/// Instruction data (40 bytes):
///   session_authority: [u8; 32]
///   session_expiry:    i64
const IX_DATA_LEN: usize = 32 + 8;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [trading_credit_acc, owner, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    // The program must own the account to mutate it (true on the base layer for a
    // non-delegated credit AND on the ER for a delegated credit).
    if trading_credit_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    let mut session_authority = [0u8; 32];
    session_authority.copy_from_slice(&data[..32]);
    let session_expiry = i64::from_le_bytes(data[32..40].try_into().unwrap());

    let credit = TradingCredit::from_account_info_mut(trading_credit_acc)?;
    if credit.owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }
    credit.session_authority = session_authority;
    credit.session_expiry = session_expiry;

    Ok(())
}
