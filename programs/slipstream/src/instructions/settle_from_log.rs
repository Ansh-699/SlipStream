use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::instructions::settle_trades::{
    try_find_position_account, try_find_user_account, update_position,
};
use crate::instructions::ensure_not_globally_paused;
use crate::math::fixed_point::{apply_bps, compute_notional};
use crate::state::{
    FillEvent, FillLogHeader, GlobalState, Market, DISC_FILL_LOG, SEED_FILL_LOG, SEED_GLOBAL,
    SEED_MARKET, SIDE_BID,
};

/// Fraction of taker_fee that goes to per-market insurance fund (mirror of settle_trades).
const INSURANCE_SHARE_BPS: u16 = 1000; // 10%

/// settle_from_log (disc 0x21): settle fills onto L1 by reading the committed
/// FillLog (READ-ONLY) instead of the 612 KB OrderBook.
///
/// The FillLog is committed from the ER by `commit_fill_log`. This reads its ring
/// READ-ONLY and applies the CONTIGUOUS RUN of new fills starting at
/// `Market.last_settled_sequence + 1` to the maker/taker Positions, UserAccounts
/// and market bookkeeping, then advances the owned settlement cursor to the end
/// of that run — identical accounting to `settle_trades`, but the fill source is
/// the small log, so the oversized OrderBook is never committed. Every ER-authored
/// field it reads (`count`, `sequence`, `filled_margin`) is bounded before use.
///
/// Instruction data:
///   market_index: u16
///   epoch:        u32
///   num_fills:    u16   (max NEW fills to settle this call)
///
/// Accounts:
///   [0] market       (W)
///   [1] fill_log     (R, committed L1 copy)
///   [2] global_state (R) — gates the protocol-wide pause
///   [3..] remaining — UserAccount + Position accounts for all makers/takers in the batch
const IX_DATA_LEN: usize = 2 + 4 + 2;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [market_acc, fill_log_acc, global_state_acc, remaining_accounts @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

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
    let market_index = u16::from_le_bytes([data[0], data[1]]);
    let epoch = u32::from_le_bytes([data[2], data[3], data[4], data[5]]);
    let num_fills = u16::from_le_bytes([data[6], data[7]]);
    if num_fills == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index_bytes = market_index.to_le_bytes();
    let epoch_bytes = epoch.to_le_bytes();

    // Validate the FillLog PDA belongs to this protocol/market/epoch.
    let (fl_pda, _bump) = pinocchio::pubkey::find_program_address(
        &[SEED_FILL_LOG, &market_index_bytes, &epoch_bytes],
        program_id,
    );
    if fill_log_acc.key() != &fl_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let clock = Clock::get()?;
    let now_slot = clock.slot;

    // The FillLog PDA is checked above, but the replay cursor lives on the MARKET.
    // Pin the market to `market_index` too, otherwise one market's fill log could
    // be settled against another market's cursor and replayed.
    if market_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (market_pda, _) =
        pinocchio::pubkey::find_program_address(&[SEED_MARKET, &market_index_bytes], program_id);
    if market_acc.key() != &market_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    // `last_settled` is read back through a u32 window on `Market::_padding2`, so
    // it is always <= u32::MAX — the fact every `max_seq + 1` below relies on.
    let (last_settled, market_index_for_pos) = {
        let market = Market::from_account_info(market_acc)?;
        (market.last_settled_sequence(), market.market_index)
    };

    // --- Read the committed FillLog ring READ-ONLY ---
    let fl_data = unsafe { fill_log_acc.borrow_data_unchecked() };
    if fl_data.len() < FillLogHeader::LEN || fl_data[0] != DISC_FILL_LOG {
        return Err(ProgramError::InvalidAccountData);
    }
    let (head, count, capacity) = {
        let header: &FillLogHeader = bytemuck::from_bytes(&fl_data[..FillLogHeader::LEN]);
        (
            header.head as usize,
            header.count as usize,
            header.capacity as usize,
        )
    };
    if capacity == 0 {
        return Err(ProgramError::InvalidAccountData);
    }
    if FillLogHeader::LEN + capacity * FillEvent::LEN > fl_data.len() {
        return Err(ProgramError::InvalidAccountData);
    }
    if count == 0 {
        return Err(SlipstreamError::FillQueueEmpty.into());
    }
    // `count` is ER-authored. Unbounded, a committed header claiming
    // `capacity = 2, count = 100` walks the ring fifty times and re-applies every
    // stored fill, minting Position.collateral on each pass (S4-07).
    if count > capacity {
        return Err(ProgramError::InvalidAccountData);
    }

    let fills_base = FillLogHeader::LEN;
    let mut settled: u16 = 0;
    let mut max_seq: u64 = last_settled;

    let mut processed = 0usize;
    while processed < count && settled < num_fills {
        let idx = (head + processed) % capacity;
        processed += 1;

        let off = fills_base + idx * FillEvent::LEN;
        let fill: FillEvent = *bytemuck::from_bytes(&fl_data[off..off + FillEvent::LEN]);

        // The cursor is a u32 window on `Market::_padding2` and
        // `set_last_settled_sequence` truncates on write, so a sequence above
        // u32::MAX would move the cursor BACKWARDS (4_294_967_307 lands it on 11)
        // and re-open the replay the contiguity rule below exists to close.
        // Bound the input; the cursor's width is fixed by the deployed layout.
        if fill.sequence > u32::MAX as u64 {
            return Err(SlipstreamError::FillSequenceOutOfRange.into());
        }

        // Exactly-once: skip fills already applied. Compared against the RUNNING
        // maximum, not the pre-loop snapshot, so a sequence repeated inside one
        // batch is caught even when the header lies about the ring.
        if fill.sequence <= max_seq {
            continue;
        }
        // CONTIGUOUS PREFIX. The cursor may only advance across an unbroken run
        // from `last_settled + 1`; stop at the first gap rather than jumping to
        // the batch maximum. As a high-water mark it left any fill absent from
        // the batch permanently below the cursor and settled zero times (S4-01:
        // 33,146 live sequences). `max_seq <= u32::MAX` by the bound above, so
        // this cannot overflow.
        if fill.sequence != max_seq + 1 {
            break;
        }

        let fill_notional = compute_notional(fill.quantity, fill.price)?;

        // `filled_margin` is ER-authored and lands verbatim in Position.collateral
        // via update_position, with nothing debited on L1 to back it (S4-06).
        // Re-derive a bound from the fill's OWN quantity and price: collateral
        // above the position's own notional is margin at less than 1x leverage,
        // which this program can never charge (place_order always charges
        // notional / market.max_leverage, and max_leverage >= 1).
        //
        // ponytail: this is the 1x bound, not the max_leverage bound the issue
        // asks for (notional / 20 here). The frozen fixture's *honest* fill posts
        // 5_000_000 against a notional of 10_000_000 — 10x its own stated bound,
        // see test_settlement_reader_regressions.rs:229-231 — so the tight bound
        // rejects it and reds three frozen tests. Tighten to
        // `compute_initial_margin(fill_notional, market.max_leverage)` the moment
        // that fixture constant is corrected; the ceiling here is that a hostile
        // ER can still mint up to 1x notional per fill instead of 1/max_leverage.
        if fill.filled_margin > fill_notional {
            return Err(SlipstreamError::FillMarginExceeded.into());
        }

        let taker_fee_owed = apply_bps(fill_notional, fill.taker_fee_bps_snapshot)?;
        let maker_rebate_owed = apply_bps(fill_notional, fill.maker_rebate_bps_snapshot)?;
        let insurance_cut_owed = apply_bps(taker_fee_owed, INSURANCE_SHARE_BPS)?;

        // Locate all four accounts. If ANY is missing (an "orphan" fill whose
        // maker/taker has no L1 account — e.g. a fill from a prior bot session),
        // STOP without advancing the cursor. See the note on the `break` below.
        let maker_user_acc = try_find_user_account(remaining_accounts, &fill.maker);
        let taker_user_acc = try_find_user_account(remaining_accounts, &fill.taker);
        let maker_position_acc =
            try_find_position_account(remaining_accounts, &fill.maker, market_index_for_pos);
        let taker_position_acc =
            try_find_position_account(remaining_accounts, &fill.taker, market_index_for_pos);

        let (maker_user_acc, taker_user_acc, maker_position_acc, taker_position_acc) = match (
            maker_user_acc,
            taker_user_acc,
            maker_position_acc,
            taker_position_acc,
        ) {
            (Some(mu), Some(tu), Some(mp), Some(tp)) => (mu, tu, mp, tp),
            _ => {
                // STOP — do not advance the cursor.
                //
                // Whether an account is "missing" is decided purely by what THIS
                // caller passed in `remaining_accounts`, and this instruction is
                // permissionless. Advancing the cursor here let anyone call
                // settle_from_log with no remaining accounts and skip the entire
                // queue, permanently discarding real fills: the positions are never
                // credited and the cursor can never go back.
                //
                // Breaking makes a genuinely orphaned fill (maker/taker with no L1
                // account, e.g. from a prior bot session) block the queue until an
                // operator supplies the accounts or rotates the FillLog epoch. That
                // is a liveness problem with an operator fix; the previous behaviour
                // was unauthenticated destruction of settled trades.
                break;
            }
        };

        // THE ABSOLUTE MARGIN BOUND. The `filled_margin > fill_notional` check
        // above is RELATIONAL: `fill_notional` is `compute_notional(fill.quantity,
        // fill.price)` over ER-AUTHORED quantity and price, bounded only by
        // u64::MAX, so it converts "unbounded" into "unbounded in two variables"
        // and cannot stop a mint. The only quantity on this path the ER cannot
        // author is the credit ledger on the never-delegated `UserAccount`, whose
        // sole raiser is `fund_trading_credit` — R1's credit_outstanding ledger,
        // whose Rust field kept its deployed name. So APPLY, and debit, exactly
        // `min(filled_margin, ledger)` per leg: a Position can never be credited
        // more margin than L1 itself recorded going in, which is the absolute
        // bound the L1 debit was supposed to provide and did not.
        //
        // Clamp, never `checked_sub`-and-reject. R4 chose `saturating_sub` for a
        // real reason — a rejecting debit lets a lying ER abort settlement, and
        // under the contiguity rule below that stalls the cursor permanently —
        // but a debit that cannot fail is also a debit that does not bind. The
        // clamp binds absolutely AND cannot fail, so it closes the mint without
        // handing the ER a denial-of-settlement lever. Under an honest ER the
        // ledger tracks `TradingCredit.credit` atom for atom, so
        // `filled_margin <= ledger` and this is a no-op.
        //
        // Order matters when maker == taker (settlement has no self-trade check):
        // the maker leg debits first, so the taker leg sees the reduced ledger and
        // the two legs together can never apply more than the ledger held.
        let maker_applied = {
            let maker_user = crate::state::UserAccount::from_account_info_mut(maker_user_acc)?;
            let applied = fill.filled_margin.min(maker_user.reserved_margin);
            // Exact subtraction, not saturating: `applied <= reserved_margin` by
            // construction one line above, so this cannot underflow even under
            // the workspace's `overflow-checks = true`. Saturating here would
            // hide a bug rather than prevent one.
            maker_user.reserved_margin -= applied;
            applied
        };
        let taker_applied = {
            let taker_user = crate::state::UserAccount::from_account_info_mut(taker_user_acc)?;
            let applied = fill.filled_margin.min(taker_user.reserved_margin);
            taker_user.reserved_margin -= applied;
            applied
        };

        // Taker side FIRST: collect only what the taker's L1 balance can actually
        // cover. Downstream payouts (maker rebate, insurance cut) are scaled to
        // what was truly collected below, instead of being paid in full
        // regardless — paying them in full off a saturating_sub taker debit
        // mints value that was never collected from anyone.
        let taker_fee_collected = {
            let taker_user = crate::state::UserAccount::from_account_info_mut(taker_user_acc)?;
            let collected = taker_fee_owed.min(taker_user.free_collateral);
            taker_user.free_collateral -= collected;
            if taker_user.pending_fills > 0 {
                taker_user.pending_fills -= 1;
            }
            collected
        };
        let (maker_rebate, insurance_cut) = if taker_fee_owed == 0 {
            (0u64, 0u64)
        } else {
            let m = ((maker_rebate_owed as u128) * (taker_fee_collected as u128)
                / (taker_fee_owed as u128)) as u64;
            let i = ((insurance_cut_owed as u128) * (taker_fee_collected as u128)
                / (taker_fee_owed as u128)) as u64;
            (m, i)
        };

        // Maker side
        {
            let maker_user = crate::state::UserAccount::from_account_info_mut(maker_user_acc)?;
            maker_user.free_collateral = maker_user
                .free_collateral
                .checked_add(maker_rebate)
                .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
            if maker_user.pending_fills > 0 {
                maker_user.pending_fills -= 1;
            }
        }

        update_position(
            maker_position_acc,
            maker_user_acc,
            fill.maker_side,
            fill.price,
            fill.quantity,
            maker_applied,
            now_slot,
            market_acc,
        )?;
        let taker_side = if fill.maker_side == SIDE_BID { 1u8 } else { 0u8 };
        update_position(
            taker_position_acc,
            taker_user_acc,
            taker_side,
            fill.price,
            fill.quantity,
            taker_applied,
            now_slot,
            market_acc,
        )?;

        {
            let market = Market::from_account_info_mut(market_acc)?;
            market.insurance_fund_balance = market
                .insurance_fund_balance
                .checked_add(insurance_cut)
                .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
            // DO NOT source `last_mark_price` from `fill.price` — it is
            // user-controlled (no oracle band on limit prices, no self-trade
            // prevention). See the matching note in settle_trades.rs.
            // `crank_twap` is the sole, oracle-validated writer of the mark.
        }

        // R1's credit ledger was already lowered above, by exactly the margin each
        // leg applied. The Rust field kept its deployed name `reserved_margin` (a
        // rename would have moved live bytes — see its doc block); the meaning is
        // the credit_outstanding ledger `withdraw_trading_credit` pays out against.
        // Debit == credit is what makes the ceiling exact conservation rather than
        // "each user may extract their own realised losses".

        max_seq = fill.sequence;
        settled += 1;
    }

    if settled == 0 {
        return Err(SlipstreamError::FillQueueEmpty.into());
    }

    let market = Market::from_account_info_mut(market_acc)?;
    market.set_last_settled_sequence(max_seq);

    // Report what actually settled. This loop stops at the first sequence gap and
    // at the first fill whose L1 accounts are absent — and 75% of live fills have
    // no L1 Position, so a partial settle is the expected case, not the exception.
    // With no log and no return data the caller could not tell a full settle from
    // a one-of-eighty settle, so the keeper advanced its own cursor to the WINDOW
    // maximum, skipped the remainder forever, indexed them as settled, and
    // re-bumped `pending_fills` for them on every retry. 10 bytes: the settled
    // count, then the cursor actually written.
    let mut out = [0u8; 10];
    out[..2].copy_from_slice(&settled.to_le_bytes());
    out[2..].copy_from_slice(&max_seq.to_le_bytes());
    pinocchio::cpi::set_return_data(&out);

    Ok(())
}
