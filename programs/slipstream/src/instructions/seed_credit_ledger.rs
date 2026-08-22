use pinocchio::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult};

use crate::error::SlipstreamError;
use crate::state::{GlobalState, TradingCredit, UserAccount, SEED_GLOBAL};

/// seed_credit_ledger (disc 0x28) — the grandfather / repair path for
/// `UserAccount.reserved_margin` (the credit ledger at offset 48).
///
/// Two jobs, spec Decisions 4 and 4b:
///
///   1. Grandfathering. 46 live TradingCredits were funded before the ceiling
///      existed, so their owner's ledger reads zero and their payout bound
///      would be zero until the operator seeds it.
///   2. Repair. The ledger goes stale on live accounts — a destroyed fill or a
///      `close_trading_credit` leaves it non-zero with no credit left to
///      withdraw, which would permanently lock the owner's `free_collateral`
///      behind `withdraw_collateral`'s gate 2. This instruction is therefore
///      deliberately NOT one-shot and deliberately accepts `amount == 0`.
///
/// It writes `min(credit.credit, amount)`, never `credit.credit` verbatim:
/// `credit.credit` is ER-authored on any account that has ever been delegated
/// (22 of the 45 live delegated credits currently carry
/// 7_017_392_213_830_636_841 against a vault holding ~511k USDC), so the
/// authority must state the number it believes and the ER value can only ever
/// lower the seed, never raise it.
///
/// Instruction data: amount: u64
///
/// Accounts:
///   [0] global_state   (R)      — authority source, PDA-pinned
///   [1] user_account   (W)      — the ledger being written
///   [2] trading_credit (R)      — must be program-owned, i.e. undelegated
///   [3] authority      (signer) — must equal `global_state.authority`
const IX_DATA_LEN: usize = 8;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [global_state_acc, user_account_acc, trading_credit_acc, authority, _remaining @ ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    // `amount == 0` is legal and load-bearing: it is how a stale ledger is
    // cleared to unlock a user's free_collateral (Decision 4b).
    let amount = u64::from_le_bytes(data[..8].try_into().unwrap());

    if global_state_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (global_pda, _) = pinocchio::pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    if global_state_acc.key() != &global_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    if &GlobalState::from_account_info(global_state_acc)?.authority != authority.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    if user_account_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    // A delegated credit's bytes are ER-authored and its `credit` is meaningless
    // to L1; refuse to read one.
    if trading_credit_acc.owner() != program_id {
        return Err(SlipstreamError::CreditStillActive.into());
    }

    let credit = TradingCredit::from_account_info(trading_credit_acc)?;
    let user = UserAccount::from_account_info(user_account_acc)?;
    if credit.owner != user.owner {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    let seed = credit.credit.min(amount);

    let user_mut = UserAccount::from_account_info_mut(user_account_acc)?;
    user_mut.reserved_margin = seed;

    Ok(())
}
