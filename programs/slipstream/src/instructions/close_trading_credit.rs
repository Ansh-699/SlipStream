use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::{TradingCredit, UserAccount, LEGACY_LEN};

/// close_trading_credit
///
/// Safely closes the caller's NON-delegated `TradingCredit` PDA and refunds the
/// rent to the owner.
///
/// This is also the recovery path for the four live 56-byte legacy credits
/// (13,313.24 USDC, `S1-01`). Every typed load rejects `data.len() < LEN`, so
/// those accounts are unreachable by `withdraw_trading_credit`,
/// `fund_trading_credit`, `delegate_trading_credit` and `authorize_session`, and
/// `initialize_trading_credit` refuses a non-empty account — this instruction is
/// the only way the money comes back. It reads them by fixed offset
/// (`TradingCredit::read_common`) and returns any remaining `credit` to
/// `UserAccount.free_collateral` before zeroing the account.
///
/// It does NOT recover the twelve *delegated* legacy credits (36,470.00 USDC):
/// the program owns none of their bytes and has no L1 undelegation path. That is
/// `S5-02` (P1) and is out of scope here.
///
/// Safety gates:
///   - The account MUST still be owned by THIS program (i.e. NOT delegated to
///     the MagicBlock delegation program). A delegated account is owned by the
///     delegation program, so the `owner() != program_id` check rejects it and
///     we never attempt to close a delegated credit.
///   - The owner must sign.
///   - `committed == 0` and `active_orders == 0` (no margin reserved against
///     resting orders), so closing cannot strand funds locked in the book.
///   - A CURRENT-layout (>= `TradingCredit::LEN`) credit that still holds
///     `credit > 0` is REFUSED. It must go through `withdraw_trading_credit`,
///     where the L1 credit ceiling applies. Closing it here would destroy the
///     balance outright and leave the `UserAccount` credit ledger stale, which
///     locks the owner's entire `free_collateral` behind `withdraw_collateral`'s
///     `reserved_margin` gate. The recovery branch is reachable ONLY at exactly
///     `LEGACY_LEN`, so it is not a way around that ceiling.
///
/// Accounts:
///   [0] trading_credit (writable) — the PDA to close
///   [1] owner          (signer, writable) — receives the rent refund
///   [2] user_account   (writable) — REQUIRED only when a legacy balance is being
///                      recovered; receives it in `free_collateral`
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [trading_credit_acc, owner, remaining @ ..] = accounts else {
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

    // Length discrimination first, and it is exact: only 56 is legacy, only
    // >= LEN is current. Anything in between is not a layout this program ever
    // wrote, and must not be read by offset.
    let len = trading_credit_acc.data_len();
    let is_legacy = match len {
        LEGACY_LEN => true,
        n if n >= TradingCredit::LEN => false,
        _ => return Err(SlipstreamError::LegacyLayoutRejected.into()),
    };

    let (credit_owner, credit_amt, committed, active_orders) = {
        let data = unsafe { trading_credit_acc.borrow_data_unchecked() };
        TradingCredit::read_common(data)?
    };

    if credit_owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }
    // Must be free of any reserved margin / resting orders.
    if committed != 0 || active_orders != 0 {
        return Err(SlipstreamError::CreditStillActive.into());
    }

    if credit_amt > 0 {
        if !is_legacy {
            // Withdraw first. See the safety gates above.
            return Err(SlipstreamError::CreditStillActive.into());
        }
        // Legacy recovery: hand the stranded balance back before we zero it.
        let [user_account_acc, ..] = remaining else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        if user_account_acc.owner() != program_id {
            return Err(ProgramError::IllegalOwner);
        }
        let user = UserAccount::from_account_info_mut(user_account_acc)?;
        if user.owner != *owner.key() {
            return Err(SlipstreamError::InvalidAuthority.into());
        }
        // checked, not saturating: a saturate here would silently destroy user
        // principal, which is the exact failure this instruction exists to undo.
        user.free_collateral = user
            .free_collateral
            .checked_add(credit_amt)
            .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
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
