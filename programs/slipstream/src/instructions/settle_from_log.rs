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
use crate::math::fixed_point::{apply_bps, compute_notional};
use crate::state::{
    FillEvent, FillLogHeader, Market, DISC_FILL_LOG, SEED_FILL_LOG, SEED_MARKET, SIDE_BID,
};

/// Fraction of taker_fee that goes to per-market insurance fund (mirror of settle_trades).
const INSURANCE_SHARE_BPS: u16 = 1000; // 10%

/// settle_from_log (disc 0x21): settle fills onto L1 by reading the committed
/// FillLog (READ-ONLY) instead of the 612 KB OrderBook.
///
/// The FillLog is committed from the ER by `commit_fill_log`. This reads its ring
/// READ-ONLY and applies each NEW fill (sequence > Market.last_settled_sequence)
/// to the maker/taker Positions + UserAccounts + market bookkeeping, then advances
/// the owned settlement cursor — identical accounting to `settle_trades`, but the
/// fill source is the small log, so the oversized OrderBook is never committed.
///
/// Instruction data:
///   market_index: u16
///   epoch:        u32
///   num_fills:    u16   (max NEW fills to settle this call)
///
/// Accounts:
///   [0] market    (W)
///   [1] fill_log  (R, committed L1 copy)
///   [2..] remaining — UserAccount + Position accounts for all makers/takers in the batch
const IX_DATA_LEN: usize = 2 + 4 + 2;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [market_acc, fill_log_acc, remaining_accounts @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

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

    let last_settled = {
        let market = Market::from_account_info(market_acc)?;
        market.last_settled_sequence()
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

    let fills_base = FillLogHeader::LEN;
    let mut settled: u16 = 0;
    let mut max_seq: u64 = last_settled;

    let mut processed = 0usize;
    while processed < count && settled < num_fills {
        let idx = (head + processed) % capacity;
        processed += 1;

        let off = fills_base + idx * FillEvent::LEN;
        let fill: FillEvent = *bytemuck::from_bytes(&fl_data[off..off + FillEvent::LEN]);

        // Exactly-once: skip fills already applied (cursor on the Market).
        if fill.sequence <= last_settled {
            continue;
        }

        let fill_notional = compute_notional(fill.quantity, fill.price)?;
        let taker_fee = apply_bps(fill_notional, fill.taker_fee_bps_snapshot)?;
        let maker_rebate = apply_bps(fill_notional, fill.maker_rebate_bps_snapshot)?;
        let insurance_cut = apply_bps(taker_fee, INSURANCE_SHARE_BPS)?;

        // Locate all four accounts. If ANY is missing (an "orphan" fill whose
        // maker/taker has no L1 account — e.g. a fill from a prior bot session),
        // SKIP this fill but STILL advance the cursor past it, so one orphan can
        // never block the whole queue forever. This makes settlement robust to
        // mixed-provenance fill logs.
        let market_index_for_pos = {
            let market = Market::from_account_info(market_acc)?;
            market.market_index
        };
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
        // Taker side
        {
            let taker_user = crate::state::UserAccount::from_account_info_mut(taker_user_acc)?;
            taker_user.free_collateral = taker_user.free_collateral.saturating_sub(taker_fee);
            if taker_user.pending_fills > 0 {
                taker_user.pending_fills -= 1;
            }
        }

        update_position(
            maker_position_acc,
            fill.maker_side,
            fill.price,
            fill.quantity,
            fill.filled_margin,
            now_slot,
            market_acc,
        )?;
        let taker_side = if fill.maker_side == SIDE_BID { 1u8 } else { 0u8 };
        update_position(
            taker_position_acc,
            taker_side,
            fill.price,
            fill.quantity,
            fill.filled_margin,
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

        if fill.sequence > max_seq {
            max_seq = fill.sequence;
        }
        settled += 1;
    }

    if settled == 0 {
        return Err(SlipstreamError::FillQueueEmpty.into());
    }

    let market = Market::from_account_info_mut(market_acc)?;
    market.set_last_settled_sequence(max_seq);

    Ok(())
}
