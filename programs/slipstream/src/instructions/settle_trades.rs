use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::math::fixed_point::{apply_bps, compute_notional, compute_unrealized_pnl, compute_vwap_entry};
use crate::state::{
    FillEvent, Market, OrderBookHeader, OrderSlot, Position, PriceLevel, UserAccount,
    DISC_ORDER_BOOK, DISC_POSITION, DISC_USER_ACCOUNT, SIDE_BID,
};

/// settle_trades instruction data (2 bytes):
///   num_fills: u16  (max NEW fills to settle this call)
///
/// Accounts:
///   [0] market
///   [1] order_book (READ-ONLY — it is delegated to the ER)
///   [2..] remaining — UserAccount and Position accounts for all makers/takers in the batch
const IX_DATA_LEN: usize = 2;

/// Fraction of taker_fee that goes to per-market insurance fund (§17).
const INSURANCE_SHARE_BPS: u16 = 1000; // 10%
/// Fraction of taker_fee paid to the settling keeper (settlement bounty).
const SETTLEMENT_BOUNTY_BPS: u16 = 50; // 0.5%

/// Settle fills produced by the ER matching engine onto L1 state.
///
/// ## Why this reads the OrderBook READ-ONLY
///
/// The OrderBook is delegated to the MagicBlock ER, so on the base layer it is
/// owned by the delegation program — L1 instructions CANNOT mutate it (doing so
/// fails with "instruction modified data of an account it does not own"). The
/// previous implementation called `pop_fill_event`, which advances the queue
/// head/count in the OrderBook header, and therefore reverted on every live
/// settlement after the book was delegated.
///
/// Instead, the keeper commits the ER OrderBook back to L1 (see `commit_orderbook`),
/// and this instruction reads the committed fill queue READ-ONLY. Settlement
/// progress is tracked in a program-OWNED cursor on the Market
/// (`last_settled_sequence`), so each fill is applied to Positions/Users/Market
/// exactly once across repeated keeper calls. The ER side only ever pushes fills
/// (it never pops), so the committed queue holds every fill in ascending
/// `sequence` order from `fill_event_head`.
pub fn process(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [market_acc, order_book_acc, remaining_accounts @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let num_fills = u16::from_le_bytes([data[0], data[1]]);
    if num_fills == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let clock = Clock::get()?;
    let now_slot = clock.slot;

    // Settlement cursor: the highest fill sequence already applied on L1.
    let last_settled = {
        let market = Market::from_account_info(market_acc)?;
        market.last_settled_sequence()
    };

    // --- Read the committed fill queue READ-ONLY (no mutation of the delegated book) ---
    let ob_data = unsafe { order_book_acc.borrow_data_unchecked() };
    if ob_data.len() < OrderBookHeader::LEN || ob_data[0] != DISC_ORDER_BOOK {
        return Err(ProgramError::InvalidAccountData);
    }
    let (head, count, max_fills, fills_base) = {
        let header: &OrderBookHeader = bytemuck::from_bytes(&ob_data[..OrderBookHeader::LEN]);
        let max_slots = header.max_order_slots as usize;
        let max_levels = header.max_price_levels_per_side as usize;
        let fills_base = OrderBookHeader::LEN
            + max_slots * OrderSlot::LEN
            + max_levels * PriceLevel::LEN * 2;
        (
            header.fill_event_head as usize,
            header.fill_event_count as usize,
            header.max_fill_events as usize,
            fills_base,
        )
    };
    if count == 0 || max_fills == 0 {
        return Err(SlipstreamError::FillQueueEmpty.into());
    }
    // Bounds-check the fills region.
    if fills_base + max_fills * FillEvent::LEN > ob_data.len() {
        return Err(ProgramError::InvalidAccountData);
    }

    let mut settled: u16 = 0;
    let mut max_seq: u64 = last_settled;

    let mut processed = 0usize;
    while processed < count && settled < num_fills {
        let idx = (head + processed) % max_fills;
        processed += 1;

        let off = fills_base + idx * FillEvent::LEN;
        // Copy the fill out of the read-only account data (FillEvent is Pod+Copy).
        let fill: FillEvent = *bytemuck::from_bytes(&ob_data[off..off + FillEvent::LEN]);

        // Skip fills already settled on a prior keeper call (exactly-once).
        if fill.sequence <= last_settled {
            continue;
        }

        let fill_notional = compute_notional(fill.quantity, fill.price)?;

        // Fee calculation — all from snapshots captured at match time.
        let taker_fee = apply_bps(fill_notional, fill.taker_fee_bps_snapshot)?;
        let maker_rebate = apply_bps(fill_notional, fill.maker_rebate_bps_snapshot)?;
        let insurance_cut = apply_bps(taker_fee, INSURANCE_SHARE_BPS)?;
        let settlement_bounty = apply_bps(taker_fee, SETTLEMENT_BOUNTY_BPS)?;
        let _treasury_share = taker_fee
            .saturating_sub(maker_rebate)
            .saturating_sub(insurance_cut)
            .saturating_sub(settlement_bounty);

        // Locate accounts for both sides (program-owned; mutable).
        let maker_user_acc = find_user_account(remaining_accounts, &fill.maker)?;
        let taker_user_acc = find_user_account(remaining_accounts, &fill.taker)?;
        let maker_position_acc =
            find_position_account(remaining_accounts, &fill.maker, market_acc)?;
        let taker_position_acc =
            find_position_account(remaining_accounts, &fill.taker, market_acc)?;

        // --- Maker side ---
        {
            let maker_user = UserAccount::from_account_info_mut(maker_user_acc)?;
            maker_user.free_collateral = maker_user
                .free_collateral
                .checked_add(maker_rebate)
                .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
            if maker_user.pending_fills > 0 {
                maker_user.pending_fills -= 1;
            }
        }

        // --- Taker side ---
        {
            let taker_user = UserAccount::from_account_info_mut(taker_user_acc)?;
            taker_user.free_collateral = taker_user.free_collateral.saturating_sub(taker_fee);
            if taker_user.pending_fills > 0 {
                taker_user.pending_fills -= 1;
            }
        }

        // --- Position updates: credit Position.collateral with filled_margin ---
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
            fill.filled_margin, // same-leverage MVP: taker_margin == maker_filled_margin
            now_slot,
            market_acc,
        )?;

        // --- Market-level bookkeeping ---
        {
            let market = Market::from_account_info_mut(market_acc)?;
            market.insurance_fund_balance = market
                .insurance_fund_balance
                .checked_add(insurance_cut)
                .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
            market.last_mark_price = fill.price;
        }

        if fill.sequence > max_seq {
            max_seq = fill.sequence;
        }
        settled += 1;
    }

    // Nothing new to settle: every fill in the queue was already applied. Treat as
    // an empty queue (idempotent no-op signal for keepers).
    if settled == 0 {
        return Err(SlipstreamError::FillQueueEmpty.into());
    }

    // Advance the owned settlement cursor so these fills are never re-applied.
    let market = Market::from_account_info_mut(market_acc)?;
    market.set_last_settled_sequence(max_seq);

    Ok(())
}

pub(crate) fn update_position(
    position_acc: &AccountInfo,
    side: u8,
    fill_price: u64,
    fill_qty: u64,
    fill_margin: u64,
    current_slot: u64,
    market_acc: &AccountInfo,
) -> Result<(), ProgramError> {
    let market = Market::from_account_info(market_acc)?;
    let cumulative_funding = market.get_cumulative_funding_index();

    let pos = Position::from_account_info_mut(position_acc)?;

    let signed_qty = if side == SIDE_BID {
        fill_qty as i64
    } else {
        -(fill_qty as i64)
    };

    // Fund the position's collateral with the slot's drained margin
    // (this is the money that flowed from TradingCredit.credit on ER → here).
    pos.collateral = pos
        .collateral
        .checked_add(fill_margin)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;

    // Track first-time opening slot for same-slot guard on withdrawals
    if pos.size == 0 && pos.open_slot == 0 {
        pos.open_slot = current_slot;
    }

    if pos.size == 0 {
        pos.size = signed_qty;
        pos.entry_price = fill_price;
        let market_mut = Market::from_account_info_mut(market_acc)?;
        if side == SIDE_BID {
            market_mut.open_interest_long = market_mut
                .open_interest_long
                .checked_add(fill_qty)
                .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
        } else {
            market_mut.open_interest_short = market_mut
                .open_interest_short
                .checked_add(fill_qty)
                .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
        }
    } else if (pos.size > 0 && side == SIDE_BID) || (pos.size < 0 && side != SIDE_BID) {
        // Add to position in same direction — VWAP blend
        let old_abs = pos.abs_size();
        pos.entry_price = compute_vwap_entry(old_abs, pos.entry_price, fill_qty, fill_price)?;
        pos.size += signed_qty;
        let market_mut = Market::from_account_info_mut(market_acc)?;
        if side == SIDE_BID {
            market_mut.open_interest_long = market_mut.open_interest_long.saturating_add(fill_qty);
        } else {
            market_mut.open_interest_short = market_mut.open_interest_short.saturating_add(fill_qty);
        }
    } else {
        // Reducing or flipping
        let old_abs = pos.abs_size();
        let reduce_qty = fill_qty.min(old_abs);

        let pnl = compute_unrealized_pnl(
            if pos.size > 0 {
                reduce_qty as i64
            } else {
                -(reduce_qty as i64)
            },
            pos.entry_price,
            fill_price,
        )?;
        pos.realized_pnl = pos.realized_pnl.saturating_add(pnl);

        let market_mut = Market::from_account_info_mut(market_acc)?;
        if pos.is_long() {
            market_mut.open_interest_long = market_mut.open_interest_long.saturating_sub(reduce_qty);
        } else {
            market_mut.open_interest_short =
                market_mut.open_interest_short.saturating_sub(reduce_qty);
        }

        if fill_qty >= old_abs {
            // Flipped through zero
            let flip_qty = fill_qty - old_abs;
            if flip_qty > 0 {
                pos.size = if side == SIDE_BID {
                    flip_qty as i64
                } else {
                    -(flip_qty as i64)
                };
                pos.entry_price = fill_price;
                pos.open_slot = current_slot;
                if side == SIDE_BID {
                    market_mut.open_interest_long =
                        market_mut.open_interest_long.saturating_add(flip_qty);
                } else {
                    market_mut.open_interest_short =
                        market_mut.open_interest_short.saturating_add(flip_qty);
                }
            } else {
                pos.size = 0;
                pos.entry_price = 0;
            }
        } else {
            pos.size += signed_qty;
        }
    }

    pos.set_funding_index_snapshot(cumulative_funding);
    Ok(())
}

pub(crate) fn find_user_account<'a>(
    accounts: &'a [AccountInfo],
    owner: &[u8; 32],
) -> Result<&'a AccountInfo, ProgramError> {
    for acc in accounts {
        let data = unsafe { acc.borrow_data_unchecked() };
        if data.len() >= UserAccount::LEN && data[0] == DISC_USER_ACCOUNT {
            let user: &UserAccount = bytemuck::from_bytes(&data[..UserAccount::LEN]);
            if user.owner == *owner {
                return Ok(acc);
            }
        }
    }
    Err(SlipstreamError::AccountNotInitialized.into())
}

/// Like `find_user_account` but returns None instead of erroring when the
/// account is absent. Used by `settle_from_log` to SKIP orphan fills (fills whose
/// maker/taker has no L1 account, e.g. from a prior bot session) and advance the
/// settlement cursor past them, rather than blocking the whole queue forever.
pub(crate) fn try_find_user_account<'a>(
    accounts: &'a [AccountInfo],
    owner: &[u8; 32],
) -> Option<&'a AccountInfo> {
    for acc in accounts {
        let data = unsafe { acc.borrow_data_unchecked() };
        if data.len() >= UserAccount::LEN && data[0] == DISC_USER_ACCOUNT {
            let user: &UserAccount = bytemuck::from_bytes(&data[..UserAccount::LEN]);
            if user.owner == *owner {
                return Some(acc);
            }
        }
    }
    None
}

pub(crate) fn find_position_account<'a>(
    accounts: &'a [AccountInfo],
    owner: &[u8; 32],
    market_acc: &AccountInfo,
) -> Result<&'a AccountInfo, ProgramError> {
    let market = Market::from_account_info(market_acc)?;
    let market_index = market.market_index;
    for acc in accounts {
        let data = unsafe { acc.borrow_data_unchecked() };
        if data.len() >= Position::LEN && data[0] == DISC_POSITION {
            let pos: &Position = bytemuck::from_bytes(&data[..Position::LEN]);
            if pos.owner == *owner && pos.market_index == market_index {
                return Ok(acc);
            }
        }
    }
    Err(SlipstreamError::PositionNotFound.into())
}

/// Option-returning variant of `find_position_account` for orphan-skipping.
pub(crate) fn try_find_position_account<'a>(
    accounts: &'a [AccountInfo],
    owner: &[u8; 32],
    market_index: u16,
) -> Option<&'a AccountInfo> {
    for acc in accounts {
        let data = unsafe { acc.borrow_data_unchecked() };
        if data.len() >= Position::LEN && data[0] == DISC_POSITION {
            let pos: &Position = bytemuck::from_bytes(&data[..Position::LEN]);
            if pos.owner == *owner && pos.market_index == market_index {
                return Some(acc);
            }
        }
    }
    None
}
