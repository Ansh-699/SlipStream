use pinocchio::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

use crate::error::SlipstreamError;
use crate::math::fixed_point::compute_notional;
use crate::state::{
    FillEvent, FillLogHeader, GlobalState, Market, Position, UserAccount, DISC_FILL_LOG,
    DISC_POSITION, DISC_USER_ACCOUNT, SEED_FILL_LOG, SEED_GLOBAL, SEED_MARKET, SEED_POSITION,
    SEED_USER,
};

/// Why the fill was skipped, reported as the first byte of the return data.
pub const SKIP_REASON_MISSING_ACCOUNT: u8 = 1;
pub const SKIP_REASON_INVALID_FILL: u8 = 2;

/// skip_unsettleable_fill (disc 0x2B) — authority-gated, on-chain-PROVEN skip
/// of the ONE fill that is blocking the settlement cursor. Closes the F3
/// finding of the remediate review (`S4-01` follow-up, `s4.md:140-141`).
///
/// WHY: `settle_from_log` advances `Market.last_settled_sequence` only across a
/// contiguous run and `break`s on a fill whose maker or taker has no L1
/// `UserAccount` / `Position` (an "orphan", e.g. a prior bot session's key that
/// will never sign `initialize_user`). That stop is deliberate — the instruction
/// is permissionless, and advancing on "account not supplied" let anyone discard
/// the whole queue. But it also means one orphan blocks every fill behind it,
/// forever, and nothing on chain could move the cursor past it. The same holds
/// for a fill that violates the margin bound: settlement reverts on it every
/// time.
///
/// This moves the cursor past exactly that fill, and ONLY when the program can
/// prove for itself that settlement can never apply it:
///   1. the fill must be the one settlement is stuck on — the first entry in
///      ring order above the cursor — and its sequence must be exactly
///      `last_settled + 1` (a gap is refused: a missing sequence may still arrive
///      in another epoch's log, and skipping it would drop it when it does);
///   2. the caller must name that sequence, so a stale or racing call cannot
///      skip the fill after it;
///   3. either one of the four canonical accounts settlement needs is not an
///      initialized program-owned account (reason 1), or the fill fails the
///      bound settlement applies (`filled_margin > notional`, or a notional that
///      overflows — reason 2). A fill whose four accounts all exist and whose
///      margin is in bounds is refused with `FillSettleable`, so not even the
///      authority can use this to discard a real, settleable trade.
///
/// Canonical PDAs are what make "missing" provable: `initialize_user` and
/// `initialize_position` create these accounts only at
/// `[SEED_USER, owner]` and `[SEED_POSITION, owner, market_index]`, and both
/// require the owner's signature, so an account absent from its PDA does not
/// exist anywhere and cannot be created by anyone but its owner.
///
/// AUTHORITY ONLY, deliberately not the keeper. A missing `Position` is curable
/// by its owner (one `initialize_position`), and the fill is lost to L1 once it
/// is skipped. Whether to wait for the owner is a judgement, not something the
/// keeper VM should automate.
///
/// What a skip does and does not touch:
///   - the cursor advances by exactly one sequence;
///   - each leg's `UserAccount.pending_fills`, where that account exists, is
///     decremented exactly as settlement would have (once per (fill, side),
///     guarded at zero), so the withdrawal gate does not keep the residue;
///   - nothing else moves. No Position, no collateral, no fee, no credit
///     ledger. The margin the ER drained for this fill stays in the vault;
///     `withdraw_trading_credit` still pays `min(credit, ledger)`, so leaving the
///     ledger untouched can only under-pay, never over-pay.
///
/// Not pause-gated: it is an authority recovery tool, and the authority can
/// unpause anyway.
///
/// Instruction data:
///   market_index: u16
///   epoch:        u32
///   sequence:     u64   (must equal `last_settled_sequence + 1`)
///
/// Accounts:
///   [0] market         (W)
///   [1] fill_log       (R, committed L1 copy)
///   [2] global_state   (R)      — authority source, PDA-pinned
///   [3] authority      (signer) — must equal `GlobalState.authority`
///   [4] maker_user     (W)      — PDA [SEED_USER, fill.maker]
///   [5] taker_user     (W)      — PDA [SEED_USER, fill.taker]
///   [6] maker_position (R)      — PDA [SEED_POSITION, fill.maker, market_index]
///   [7] taker_position (R)      — PDA [SEED_POSITION, fill.taker, market_index]
///
/// Return data: reason (u8) then the skipped sequence (u64 LE).
const IX_DATA_LEN: usize = 2 + 4 + 8;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [market_acc, fill_log_acc, global_state_acc, authority, maker_user_acc, taker_user_acc, maker_pos_acc, taker_pos_acc, _remaining @ ..] =
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
    let market_index = u16::from_le_bytes([data[0], data[1]]);
    let epoch = u32::from_le_bytes([data[2], data[3], data[4], data[5]]);
    let sequence = u64::from_le_bytes(data[6..14].try_into().unwrap());
    let market_index_bytes = market_index.to_le_bytes();
    let epoch_bytes = epoch.to_le_bytes();

    // GlobalState is only READ, so pin owner + PDA before trusting `authority`.
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

    if market_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (market_pda, _) =
        pinocchio::pubkey::find_program_address(&[SEED_MARKET, &market_index_bytes], program_id);
    if market_acc.key() != &market_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    let (fl_pda, _) = pinocchio::pubkey::find_program_address(
        &[SEED_FILL_LOG, &market_index_bytes, &epoch_bytes],
        program_id,
    );
    if fill_log_acc.key() != &fl_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let last_settled = Market::from_account_info(market_acc)?.last_settled_sequence();
    // The cursor is a u32 window; `last_settled + 1` must still fit in it.
    if last_settled >= u32::MAX as u64 {
        return Err(SlipstreamError::FillSequenceOutOfRange.into());
    }
    if sequence != last_settled + 1 {
        return Err(SlipstreamError::InvalidFillSequence.into());
    }

    let fill = blocking_fill(fill_log_acc, last_settled)?;
    if fill.sequence != sequence {
        // The first fill above the cursor is not the next sequence: a gap, which
        // settlement already stops at without reverting. Not ours to skip.
        return Err(SlipstreamError::InvalidFillSequence.into());
    }

    // Reason 2 first: a fill settlement would revert on is unsettleable whatever
    // accounts exist. Same bound, same order, as settle_from_log.
    let invalid = match compute_notional(fill.quantity, fill.price) {
        Ok(notional) => fill.filled_margin > notional,
        Err(_) => true,
    };

    let (maker_user_pda, _) =
        pinocchio::pubkey::find_program_address(&[SEED_USER, &fill.maker], program_id);
    let (taker_user_pda, _) =
        pinocchio::pubkey::find_program_address(&[SEED_USER, &fill.taker], program_id);
    let (maker_pos_pda, _) = pinocchio::pubkey::find_program_address(
        &[SEED_POSITION, &fill.maker, &market_index_bytes],
        program_id,
    );
    let (taker_pos_pda, _) = pinocchio::pubkey::find_program_address(
        &[SEED_POSITION, &fill.taker, &market_index_bytes],
        program_id,
    );
    // The proof is only as good as the addresses it inspects: any other account
    // passed here would let a caller "prove" a real user's account missing.
    if maker_user_acc.key() != &maker_user_pda
        || taker_user_acc.key() != &taker_user_pda
        || maker_pos_acc.key() != &maker_pos_pda
        || taker_pos_acc.key() != &taker_pos_pda
    {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let maker_user_exists = user_exists(program_id, maker_user_acc, &fill.maker);
    let taker_user_exists = user_exists(program_id, taker_user_acc, &fill.taker);
    let missing = !maker_user_exists
        || !taker_user_exists
        || !position_exists(program_id, maker_pos_acc, &fill.maker, market_index)
        || !position_exists(program_id, taker_pos_acc, &fill.taker, market_index);

    let reason = if invalid {
        SKIP_REASON_INVALID_FILL
    } else if missing {
        SKIP_REASON_MISSING_ACCOUNT
    } else {
        return Err(SlipstreamError::FillSettleable.into());
    };

    // Release the pending-fill bumps this fill carried, one per (fill, side),
    // exactly as settlement would have. A missing account has no counter to
    // release. When maker == taker both legs land on the same account, as they
    // do in settlement.
    if maker_user_exists {
        let user = UserAccount::from_account_info_mut(maker_user_acc)?;
        user.pending_fills = user.pending_fills.saturating_sub(1);
    }
    if taker_user_exists {
        let user = UserAccount::from_account_info_mut(taker_user_acc)?;
        user.pending_fills = user.pending_fills.saturating_sub(1);
    }

    Market::from_account_info_mut(market_acc)?.set_last_settled_sequence(sequence);

    let mut out = [0u8; 9];
    out[0] = reason;
    out[1..].copy_from_slice(&sequence.to_le_bytes());
    pinocchio::cpi::set_return_data(&out);

    Ok(())
}

/// The fill `settle_from_log` would stop or revert on: the first entry, in ring
/// order, whose sequence is above the cursor. Walks the committed ring with the
/// same bounds settlement applies to its ER-authored header.
fn blocking_fill(fill_log_acc: &AccountInfo, last_settled: u64) -> Result<FillEvent, ProgramError> {
    let fl_data = unsafe { fill_log_acc.borrow_data_unchecked() };
    if fl_data.len() < FillLogHeader::LEN || fl_data[0] != DISC_FILL_LOG {
        return Err(ProgramError::InvalidAccountData);
    }
    let header: &FillLogHeader = bytemuck::from_bytes(&fl_data[..FillLogHeader::LEN]);
    let (head, count, capacity) = (
        header.head as usize,
        header.count as usize,
        header.capacity as usize,
    );
    if capacity == 0 || FillLogHeader::LEN + capacity * FillEvent::LEN > fl_data.len() {
        return Err(ProgramError::InvalidAccountData);
    }
    if count > capacity {
        return Err(ProgramError::InvalidAccountData);
    }
    for processed in 0..count {
        let off = FillLogHeader::LEN + ((head + processed) % capacity) * FillEvent::LEN;
        let fill: FillEvent = *bytemuck::from_bytes(&fl_data[off..off + FillEvent::LEN]);
        if fill.sequence > last_settled {
            return Ok(fill);
        }
    }
    Err(SlipstreamError::FillQueueEmpty.into())
}

/// An initialized, program-owned `UserAccount` for `owner` — what settlement
/// needs to apply a leg. Anything else at the canonical PDA counts as missing.
fn user_exists(program_id: &Pubkey, acc: &AccountInfo, owner: &[u8; 32]) -> bool {
    if acc.owner() != program_id {
        return false;
    }
    let data = unsafe { acc.borrow_data_unchecked() };
    if data.len() < UserAccount::LEN || data[0] != DISC_USER_ACCOUNT {
        return false;
    }
    let user: &UserAccount = bytemuck::from_bytes(&data[..UserAccount::LEN]);
    user.owner == *owner
}

fn position_exists(
    program_id: &Pubkey,
    acc: &AccountInfo,
    owner: &[u8; 32],
    market_index: u16,
) -> bool {
    if acc.owner() != program_id {
        return false;
    }
    let data = unsafe { acc.borrow_data_unchecked() };
    if data.len() < Position::LEN || data[0] != DISC_POSITION {
        return false;
    }
    let pos: &Position = bytemuck::from_bytes(&data[..Position::LEN]);
    pos.owner == *owner && pos.market_index == market_index
}
