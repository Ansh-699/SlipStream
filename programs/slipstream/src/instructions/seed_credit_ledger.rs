use pinocchio::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::{GlobalState, TradingCredit, UserAccount, SEED_CREDIT, SEED_GLOBAL};

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
/// PER MARKET, SUMMED (remediate review F4). The ledger is one number per USER,
/// raised by `fund_trading_credit` on EVERY market, while a TradingCredit is per
/// (user, market). Seeding it from one credit overwrote the other markets'
/// share: harmless at `market_count == 1`, and the instant a second market
/// existed it would let a seed for market 0 erase (or, with a large `amount`,
/// stand in for) what the user had parked on market 1. The seed is therefore
/// `Σ_i min(credit_i.credit, amount_i)` over every market, and every market must
/// be accounted for — a credit that was never created contributes zero, it is
/// not silently left out.
///
/// The one-market form is byte-for-byte the old one (one credit, one amount),
/// so an existing caller keeps working while `market_count <= 1`.
///
/// Instruction data: amount_i: u64, one per market, in market-index order
///   (`max(market_count, 1)` of them).
///
/// Accounts:
///   [0] global_state   (R)      — authority + market_count source, PDA-pinned
///   [1] user_account   (W)      — the ledger being written
///   [2] trading_credit (R)      — market 0's credit PDA [SEED_CREDIT, owner, 0]
///   [3] authority      (signer) — must equal `global_state.authority`
///   [4..] the credit PDAs for markets 1, 2, ... in order (absent on a
///         one-market deployment). Each must be the canonical PDA and either
///         program-owned (undelegated) or never created (`data_is_empty()`); a
///         delegated credit is refused, its `credit` is meaningless to L1.
pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [global_state_acc, user_account_acc, trading_credit_acc, authority, remaining @ ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if global_state_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (global_pda, _) = pinocchio::pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    if global_state_acc.key() != &global_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    let global = GlobalState::from_account_info(global_state_acc)?;
    if &global.authority != authority.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }
    // A credit cannot exist before its market, so a ledger worth seeding implies
    // at least one market; `max(1)` keeps the pre-market form well defined.
    let markets = global.market_count.max(1) as usize;

    // `amount == 0` is legal and load-bearing: it is how a stale ledger is
    // cleared to unlock a user's free_collateral (Decision 4b).
    if data.len() < 8 * markets {
        return Err(ProgramError::InvalidInstructionData);
    }
    if remaining.len() < markets - 1 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    if user_account_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let owner = UserAccount::from_account_info(user_account_acc)?.owner;

    let mut seed: u64 = 0;
    for i in 0..markets {
        let credit_acc = if i == 0 {
            trading_credit_acc
        } else {
            &remaining[i - 1]
        };
        let amount = u64::from_le_bytes(data[8 * i..8 * i + 8].try_into().unwrap());
        let term = credit_term(program_id, credit_acc, &owner, i as u16, amount)?;
        seed = seed
            .checked_add(term)
            .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
    }

    let user_mut = UserAccount::from_account_info_mut(user_account_acc)?;
    user_mut.reserved_margin = seed;

    Ok(())
}

/// One market's share of the seed: `min(credit, amount)` for an undelegated
/// credit, zero for one never created, refused for anything else.
fn credit_term(
    program_id: &Pubkey,
    credit_acc: &AccountInfo,
    owner: &[u8; 32],
    market_index: u16,
    amount: u64,
) -> Result<u64, ProgramError> {
    // The canonical address, so the bytes read are this user's credit for this
    // market and not some other program-owned account shaped like one (an
    // undelegated account's bytes were authored by the ER).
    let (expected, _) = pinocchio::pubkey::find_program_address(
        &[SEED_CREDIT, owner, &market_index.to_le_bytes()],
        program_id,
    );
    if credit_acc.key() != &expected {
        return Err(SlipstreamError::InvalidPda.into());
    }
    // Never created on this market: nothing parked there.
    if credit_acc.data_is_empty() && credit_acc.owner() != program_id {
        return Ok(0);
    }
    // A delegated credit's bytes are ER-authored and its `credit` is meaningless
    // to L1; refuse to read one.
    if credit_acc.owner() != program_id {
        return Err(SlipstreamError::CreditStillActive.into());
    }
    let credit = TradingCredit::from_account_info(credit_acc)?;
    if credit.owner != *owner {
        return Err(SlipstreamError::InvalidAuthority.into());
    }
    if credit.market_index != market_index {
        return Err(SlipstreamError::InvalidMarketIndex.into());
    }
    Ok(credit.credit.min(amount))
}
