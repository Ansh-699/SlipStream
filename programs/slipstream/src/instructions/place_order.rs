use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::math::fixed_point::{compute_initial_margin, compute_notional};
use crate::state::{
    reconcile_credit, FillEvent, Market, OrderBookView, TradingCredit,
    SENTINEL, SIDE_BID, SIDE_ASK,
    ORDER_TYPE_LIMIT, ORDER_TYPE_POST_ONLY, ORDER_TYPE_FOK, ORDER_TYPE_MARKET,
};

/// ER-native place_order.
///
/// Accounts (in order):
///   [0] market             (R, L1 snapshot; holds tick/lot/fees/leverage/mark)
///   [1] order_book         (W, delegated to ER)
///   [2] trading_credit     (W, delegated to ER — belongs to the caller)
///   [3] signer             (signer) — the credit OWNER or an authorized,
///                                     non-expired session key. The resulting
///                                     order is always attributed to credit.owner.
///
/// Instruction data (28 bytes):
///   side:             u8
///   order_type:       u8
///   price:            u64   (6-decimal; 0 = MARKET only)
///   size:             u64   (base atoms, must be multiple of market.lot_size)
///   expiry_ts:        i64   (0 = never)
///   max_slippage_bps: u16   (only enforced for MARKET orders; 0 = disabled)
///   reduce_only:      u8    (optional 29th byte; 1 = closing/reducing an existing
///                            position — skips the upfront margin gate, costs the
///                            taker zero new credit, and never rests a remainder.
///                            DEVNET NOTE: the ER cannot read the L1 Position, so
///                            this trusts the caller that it is a reduce. Before
///                            mainnet this MUST be gated by an on-chain position
///                            check; see the Trust Model.)
const IX_DATA_LEN: usize = 1 + 1 + 8 + 8 + 8 + 2;

pub fn process(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [
        market_acc,
        order_book_acc,
        trading_credit_acc,
        signer,
        _remaining @ ..
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !signer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let side = data[0];
    let order_type = data[1];
    let price = u64::from_le_bytes(data[2..10].try_into().unwrap());
    let size = u64::from_le_bytes(data[10..18].try_into().unwrap());
    let expiry_ts = i64::from_le_bytes(data[18..26].try_into().unwrap());
    let max_slippage_bps = u16::from_le_bytes([data[26], data[27]]);
    // Optional 29th byte: reduce_only flag (backward compatible — absent => 0).
    let reduce_only = data.get(28).copied().unwrap_or(0) != 0;

    if side != SIDE_BID && side != SIDE_ASK {
        return Err(SlipstreamError::InvalidOrderSide.into());
    }
    if order_type > ORDER_TYPE_MARKET {
        return Err(SlipstreamError::InvalidOrderType.into());
    }
    if size == 0 {
        return Err(SlipstreamError::InvalidOrderSize.into());
    }
    if order_type != ORDER_TYPE_MARKET && price == 0 {
        return Err(SlipstreamError::InvalidOrderPrice.into());
    }

    let market = Market::from_account_info(market_acc)?;
    if market.circuit_breaker_active != 0 {
        return Err(SlipstreamError::MarketPaused.into());
    }
    // Note: a stricter version of restricted_mode would only allow position-reducing
    // orders. For MVP we block all new orders during restricted mode — closes can
    // still happen via close_position (TWAP-based safety hatch).
    if market.is_restricted() {
        return Err(SlipstreamError::RestrictedMode.into());
    }

    // tick_size / lot_size enforcement
    if market.lot_size == 0 || size % market.lot_size != 0 {
        return Err(SlipstreamError::LotSizeViolation.into());
    }
    if order_type != ORDER_TYPE_MARKET {
        if market.tick_size == 0 || price % market.tick_size != 0 {
            return Err(SlipstreamError::TickSizeViolation.into());
        }
    }

    // Validate trading credit authorization & market. The signer must be the
    // credit OWNER or a non-expired authorized SESSION key — but the order is
    // always attributed to credit.owner below (owner_bytes), never the signer,
    // so reconcile_credit / settlement / liquidation stay correct.
    let owner_bytes;
    {
        let now = Clock::get()?.unix_timestamp;
        let credit = TradingCredit::from_account_info(trading_credit_acc)?;
        if !credit.is_authorized_signer(signer.key(), now) {
            return Err(SlipstreamError::InvalidAuthority.into());
        }
        if credit.market_index != market.market_index {
            return Err(SlipstreamError::InvalidMarketIndex.into());
        }
        owner_bytes = credit.owner;
    }

    // Reference price for notional computation (MARKET uses mark price)
    let reference_price = if order_type == ORDER_TYPE_MARKET {
        if market.last_mark_price == 0 {
            return Err(SlipstreamError::OracleStale.into());
        }
        market.last_mark_price
    } else {
        price
    };

    let max_leverage = market.max_leverage;
    let notional = compute_notional(size, reference_price)?;
    let margin_required = compute_initial_margin(notional, max_leverage)?;

    let taker_fee_bps = market.taker_fee_bps;
    let maker_rebate_bps = market.maker_rebate_bps;

    // Take a mutable view of the book + credit
    let ob_data = unsafe { order_book_acc.borrow_mut_data_unchecked() };
    let mut ob = OrderBookView::from_account_data(ob_data)?;
    let orders_per_user = ob.header.orders_per_user;

    // Reconcile the caller's own credit first (catches any fills against their resting orders).
    {
        let credit = TradingCredit::from_account_info_mut(trading_credit_acc)?;
        reconcile_credit(&ob, credit);
    }

    // Check credit availability before any side effects.
    // reduce_only orders SKIP the margin gate: a position-reducing order should
    // not have to reserve fresh margin (settlement realizes PnL and releases the
    // original collateral). They also cost the taker zero new credit below and
    // never rest a remainder, so they cannot over-reserve credit.
    {
        let credit = TradingCredit::from_account_info(trading_credit_acc)?;
        if !reduce_only && credit.available() < margin_required {
            return Err(SlipstreamError::InsufficientCredit.into());
        }
        if (credit.active_orders as u8) >= orders_per_user {
            return Err(SlipstreamError::MaxOrdersPerUser.into());
        }
    }

    let mut remaining_size = size;

    // Slippage bounds
    let (slippage_lo, slippage_hi) = if order_type == ORDER_TYPE_MARKET && max_slippage_bps > 0 {
        let window = apply_bps_u64(market.last_mark_price, max_slippage_bps);
        (
            market.last_mark_price.saturating_sub(window),
            market.last_mark_price.saturating_add(window),
        )
    } else {
        (0u64, u64::MAX)
    };

    // Matching phase (taker drains maker slots; filled_margin stamped on FillEvent).
    // Returns the total margin the taker consumed (sum of proportional slot margins drained).
    let mut taker_margin_spent: u64 = 0;
    if order_type != ORDER_TYPE_POST_ONLY {
        remaining_size = match_order(
            &mut ob,
            side,
            price,
            remaining_size,
            order_type,
            &owner_bytes,
            taker_fee_bps,
            maker_rebate_bps,
            slippage_lo,
            slippage_hi,
            max_leverage,
            &mut taker_margin_spent,
        )?;
    } else {
        let would_cross = if side == SIDE_BID {
            ob.best_ask_level().map_or(false, |ask| price >= ask.price)
        } else {
            ob.best_bid_level().map_or(false, |bid| price <= bid.price)
        };
        if would_cross {
            return Err(SlipstreamError::PostOnlyWouldCross.into());
        }
    }

    if order_type == ORDER_TYPE_FOK && remaining_size > 0 {
        return Err(SlipstreamError::FokCannotFill.into());
    }

    // Rest any remainder as a resting order.
    // reduce_only never rests (IOC-like): a close should flatten, not leave a new
    // resting order that would reserve margin.
    let mut rest_margin: u64 = 0;
    if remaining_size > 0
        && !reduce_only
        && (order_type == ORDER_TYPE_LIMIT || order_type == ORDER_TYPE_POST_ONLY)
    {
        let rest_notional = compute_notional(remaining_size, price)?;
        rest_margin = compute_initial_margin(rest_notional, max_leverage)?;

        let order_id = ob.next_order_id();
        let slot_idx = ob.alloc_slot()?;
        ob.order_slots[slot_idx as usize].init(
            order_id,
            owner_bytes,
            side,
            order_type,
            price,
            remaining_size,
            expiry_ts,
            rest_margin,
        );

        if side == SIDE_BID {
            match ob.find_bid_level(price) {
                Some(level_idx) => {
                    let tail = ob.bid_levels[level_idx].tail_slot;
                    ob.order_slots[tail as usize].next_at_level = slot_idx;
                    ob.order_slots[slot_idx as usize].prev_at_level = tail;
                    ob.bid_levels[level_idx].append(slot_idx);
                }
                None => {
                    ob.insert_bid_level(price, slot_idx)?;
                }
            }
        } else {
            match ob.find_ask_level(price) {
                Some(level_idx) => {
                    let tail = ob.ask_levels[level_idx].tail_slot;
                    ob.order_slots[tail as usize].next_at_level = slot_idx;
                    ob.order_slots[slot_idx as usize].prev_at_level = tail;
                    ob.ask_levels[level_idx].append(slot_idx);
                }
                None => {
                    ob.insert_ask_level(price, slot_idx)?;
                }
            }
        }
    }

    // Apply the taker-side credit accounting:
    //   - taker_margin_spent: drained from credit (this money flows to position.collateral
    //     via settlement).
    //   - rest_margin: committed (held against the new resting slot).
    let credit = TradingCredit::from_account_info_mut(trading_credit_acc)?;
    if taker_margin_spent > 0 && !reduce_only {
        // reduce_only closes do NOT spend new credit — the position's original
        // collateral is released at settlement, so charging fresh margin here
        // would double-count and re-trigger InsufficientCredit.
        credit.credit = credit
            .credit
            .checked_sub(taker_margin_spent)
            .ok_or(ProgramError::from(SlipstreamError::InsufficientCredit))?;
    }
    if rest_margin > 0 {
        credit.committed = credit
            .committed
            .checked_add(rest_margin)
            .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
        credit.active_orders = credit
            .active_orders
            .checked_add(1)
            .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
    }

    Ok(())
}

fn apply_bps_u64(amount: u64, bps: u16) -> u64 {
    ((amount as u128) * (bps as u128) / 10_000u128) as u64
}

#[allow(clippy::too_many_arguments)]
fn match_order(
    ob: &mut OrderBookView,
    taker_side: u8,
    limit_price: u64,
    mut remaining: u64,
    order_type: u8,
    taker: &[u8; 32],
    taker_fee_bps: u16,
    maker_rebate_bps: u16,
    slippage_lo: u64,
    slippage_hi: u64,
    leverage: u8,
    taker_margin_spent: &mut u64,
) -> Result<u64, ProgramError> {
    while remaining > 0 {
        let (level_price, head_slot) = if taker_side == SIDE_BID {
            match ob.best_ask_level() {
                Some(level) if order_type == ORDER_TYPE_MARKET || level.price <= limit_price => {
                    (level.price, level.head_slot)
                }
                _ => break,
            }
        } else {
            match ob.best_bid_level() {
                Some(level) if order_type == ORDER_TYPE_MARKET || level.price >= limit_price => {
                    (level.price, level.head_slot)
                }
                _ => break,
            }
        };

        if order_type == ORDER_TYPE_MARKET
            && (level_price < slippage_lo || level_price > slippage_hi)
        {
            return Err(SlipstreamError::SlippageExceeded.into());
        }

        if head_slot == SENTINEL {
            break;
        }

        // Capture maker info from an immutable borrow first
        let (maker_remaining, maker_owner, maker_side) = {
            let maker_slot = &ob.order_slots[head_slot as usize];
            (maker_slot.remaining_size, maker_slot.owner, maker_slot.side)
        };
        let fill_qty = remaining.min(maker_remaining);

        // Drain maker slot's margin proportionally — this amount is what Position.collateral
        // will be credited with on L1 settlement for the maker.
        let filled_margin = ob.order_slots[head_slot as usize].drain_margin_for_fill(fill_qty);

        // Compute taker's margin for this fill (same-leverage MVP => taker_margin == filled_margin)
        let taker_fill_notional = compute_notional(fill_qty, level_price)?;
        let taker_fill_margin = compute_initial_margin(taker_fill_notional, leverage)?;
        *taker_margin_spent = taker_margin_spent.saturating_add(taker_fill_margin);

        let seq = ob.next_fill_sequence();
        let fill = FillEvent {
            sequence: seq,
            maker: maker_owner,
            taker: *taker,
            price: level_price,
            quantity: fill_qty,
            filled_margin,
            taker_fee_bps_snapshot: taker_fee_bps,
            maker_rebate_bps_snapshot: maker_rebate_bps,
            maker_side,
            _pad: [0u8; 3],
        };
        ob.push_fill_event(fill)?;

        remaining -= fill_qty;

        if fill_qty == maker_remaining {
            let next = ob.order_slots[head_slot as usize].next_at_level;

            if taker_side == SIDE_BID {
                if next == SENTINEL {
                    ob.remove_ask_level(0);
                } else {
                    ob.ask_levels[0].remove_head(next);
                    ob.order_slots[next as usize].prev_at_level = SENTINEL;
                }
            } else {
                if next == SENTINEL {
                    ob.remove_bid_level(0);
                } else {
                    ob.bid_levels[0].remove_head(next);
                    ob.order_slots[next as usize].prev_at_level = SENTINEL;
                }
            }

            ob.free_slot(head_slot);
        }
        // Partial fill path: drain_margin_for_fill already decremented remaining_size.
    }

    Ok(remaining)
}
