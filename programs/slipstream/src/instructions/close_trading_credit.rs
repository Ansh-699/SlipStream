use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::TradingCredit;

/// close_trading_credit
///
/// Safely closes the caller's NON-delegated `TradingCredit` PDA and refunds the
/// rent to the owner. Used to migrate a legacy (e.g. 56-byte) credit to the new
/// layout: close the old account, then the frontend re-inits a fresh credit at
/// the current `TradingCredit::LEN`.
///
/// Safety gates:
///   - The account MUST still be owned by THIS program (i.e. NOT delegated to
///     the MagicBlock delegation program). A delegated account is owned by the
///     delegation program, so the `owner() != program_id` check rejects it and
///     we never attempt to close a delegated credit.
///   - The owner must sign.
///   - `committed == 0` and `active_orders == 0` (no margin reserved against
///     resting orders), so closing cannot strand funds locked in the book.
///
/// Note: this does NOT validate against `credit > 0` because the credit balance
/// is migration-only test funds here and is independently recoverable via the
/// UserAccount accounting; the brief's migration path closes only idle credits.
/// Callers should withdraw credit first if they want to preserve it.
///
/// Accounts:
///   [0] trading_credit (writable) — the PDA to close
///   [1] owner          (signer, writable) — receives the rent refund
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [trading_credit_acc, owner, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    // CRITICAL: a delegated credit is owned by the delegation program, not this
    // program. Refusing to operate on a non-program-owned account guarantees we
    // never close (or corrupt) a delegated credit.
    if trading_credit_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    let credit = TradingCredit::from_account_info(trading_credit_acc)?;
    if credit.owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }
    // Must be free of any reserved margin / resting orders.
    if credit.committed != 0 || credit.active_orders != 0 {
        return Err(SlipstreamError::CreditStillActive.into());
    }

    // Zero the data (invalidates the discriminator) and refund all lamports to owner.
    let acc_data = unsafe { trading_credit_acc.borrow_mut_data_unchecked() };
    for b in acc_data.iter_mut() {
        *b = 0;
    }
    let lamports = unsafe { *trading_credit_acc.borrow_lamports_unchecked() };
    unsafe {
        *trading_credit_acc.borrow_mut_lamports_unchecked() = 0;
        *owner.borrow_mut_lamports_unchecked() += lamports;
    }
    Ok(())
}
