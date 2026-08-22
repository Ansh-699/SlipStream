use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::instructions::ensure_not_globally_paused;
use crate::state::{GlobalState, TradingCredit, UserAccount, SEED_GLOBAL};

/// Instruction data: amount: u64
/// Caller must ensure TradingCredit is NOT delegated (we can't write delegated
/// state from L1). The owner check + program_id check on account owner catches this.
const IX_DATA_LEN: usize = 8;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [user_account_acc, trading_credit_acc, owner, global_state_acc, _remaining @ ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if global_state_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (global_pda, _) = pinocchio::pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    if global_state_acc.key() != &global_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    ensure_not_globally_paused(GlobalState::from_account_info(global_state_acc)?)?;

    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount = u64::from_le_bytes(data[..8].try_into().unwrap());
    if amount == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Both accounts must still be owned by this program (not delegated)
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
    if user.free_collateral < amount {
        return Err(SlipstreamError::InsufficientCollateral.into());
    }

    // Atomic transfer on L1 state: UserAccount.free -= amount, TradingCredit.credit += amount.
    // Vault USDC doesn't move — this is pure accounting.
    let user_mut = UserAccount::from_account_info_mut(user_account_acc)?;
    user_mut.free_collateral = user_mut.free_collateral.saturating_sub(amount);
    // Raise L1's own credit ledger in the same instruction that lowers
    // free_collateral: this is the ONLY site that raises it, and it is the
    // ceiling withdraw_trading_credit pays out under. `checked_add`, not
    // saturating: a saturated ledger would silently overstate the ceiling, and
    // this is the one arm where refusing the call costs the honest user
    // nothing (the transfer is atomic, so nothing has moved yet).
    user_mut.reserved_margin = user_mut
        .reserved_margin
        .checked_add(amount)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;

    let credit_mut = TradingCredit::from_account_info_mut(trading_credit_acc)?;
    credit_mut.credit = credit_mut
        .credit
        .checked_add(amount)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;

    Ok(())
}
