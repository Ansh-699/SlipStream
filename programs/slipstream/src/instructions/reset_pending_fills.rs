use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::{GlobalState, UserAccount, SEED_GLOBAL};

/// reset_pending_fills (disc 0x29) — authority-gated clear of one
/// `UserAccount.pending_fills` counter. Closes `S4-04`.
///
/// `pending_fills` is bumped once per user listed on a `record_pending_fill`
/// and decremented once per (fill, side) by settlement, so a partial-prefix
/// settle leaves a permanent residue. It gates `withdraw_collateral`,
/// `close_user_account` and the `liquidate_position` grace window, and nothing
/// on chain could ever lower it. On the live deployment 13 of 45 accounts are
/// stuck behind it holding 438,643.10 USDC, and the fills that would have
/// decremented them are among the 33,146 destroyed by `S4-01` — they are not
/// coming back. This is the only path that clears them.
///
/// The symmetry half of the fix is off-chain: the keepers now list a user once
/// per (fill, side) rather than once per batch, so the bump and the decrement
/// count the same unit. That is a keeper-enforced invariant and therefore
/// strictly weaker than an on-chain rule. Named ceiling, not hidden: the
/// durable fix is to gate withdrawal on a specific unsettled sequence rather
/// than on a free-running counter. Recorded as follow-up, deliberately not
/// done here.
///
/// Instruction data: none.
///
/// Accounts:
///   [0] global_state  (read)   — authority gate
///   [1] user_account  (write)  — the counter being cleared
///   [2] authority     (signer) — must equal GlobalState.authority
///
/// This is a standing authority-gated clear of a withdrawal gate. It grants no
/// capability the key does not already have: the holder of
/// `GlobalState.authority` is also the upgrade authority and can replace the
/// program outright. Same argument intake ruling 2 makes for
/// `seed_credit_ledger`; if the `S10-01` key ceremony ever happens, both should
/// be revisited.
pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    let [global_state_acc, user_acc, authority] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    // GlobalState is only READ here, so the runtime's write protection does not
    // catch a forged (attacker-owned) account — pin owner + PDA first.
    if global_state_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (global_pda, _) = pinocchio::pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    if global_state_acc.key() != &global_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    let global = GlobalState::from_account_info(global_state_acc)?;
    if global.authority != *authority.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    if user_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    // No arithmetic: the counter is stored, not adjusted. Nothing else on the
    // account is touched, so no balance can move on this path.
    UserAccount::from_account_info_mut(user_acc)?.pending_fills = 0;

    Ok(())
}
