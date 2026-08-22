use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::{TradingCredit, UserAccount};

/// Instruction data: amount: u64
///
/// Requires `TradingCredit` to be idle (`active_orders == 0` and `committed == 0`)
/// and undelegated (account owner == program_id). The caller must first call
/// `undelegate_trading_credit` if a session is active.
const IX_DATA_LEN: usize = 8;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [user_account_acc, trading_credit_acc, owner, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount = u64::from_le_bytes(data[..8].try_into().unwrap());
    if amount == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    if user_account_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    if trading_credit_acc.owner() != program_id {
        return Err(SlipstreamError::CreditStillActive.into());
    }

    let user = UserAccount::from_account_info(user_account_acc)?;
    let credit = TradingCredit::from_account_info(trading_credit_acc)?;
    if user.owner != *owner.key() || credit.owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }
    if !credit.is_idle() {
        return Err(SlipstreamError::CreditStillActive.into());
    }
    if credit.credit < amount {
        return Err(SlipstreamError::InsufficientCredit.into());
    }
    // THE CEILING. `credit.credit` above is ER-authored on any credit that has
    // ever been delegated, so on its own it authorises pulling an arbitrary
    // number out of the vault. `reserved_margin` — the credit ledger on the
    // never-delegated UserAccount — is what L1 itself recorded as funded, minus
    // what settlement consumed and what was already withdrawn. Paying out at
    // most min(credit.credit, ledger) bounds the ER by what went in. Under an
    // honest ER the two are equal and this gate never binds.
    if user.reserved_margin < amount {
        return Err(SlipstreamError::CreditCeilingExceeded.into());
    }

    let credit_mut = TradingCredit::from_account_info_mut(trading_credit_acc)?;
    credit_mut.credit = credit_mut.credit.saturating_sub(amount);

    let user_mut = UserAccount::from_account_info_mut(user_account_acc)?;
    // Both gates above already proved `amount` fits, so neither subtraction can
    // underflow; saturating matches the credit decrement beside it and cannot
    // panic under the workspace's `overflow-checks = true`.
    user_mut.reserved_margin = user_mut.reserved_margin.saturating_sub(amount);
    user_mut.free_collateral = user_mut
        .free_collateral
        .checked_add(amount)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;

    Ok(())
}
