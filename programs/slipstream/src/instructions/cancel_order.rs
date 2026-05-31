use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::{
    reconcile_credit, OrderBookView, TradingCredit, SENTINEL, SIDE_BID,
};

/// ER-native cancel_order.
///
/// Accounts:
///   [0] order_book       (W, delegated to ER)
///   [1] trading_credit   (W, delegated to ER)
///   [2] signer           (signer) — the credit OWNER or a non-expired session key
///
/// Instruction data (8 bytes): order_id: u64
const IX_DATA_LEN: usize = 8;

pub fn process(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [order_book_acc, trading_credit_acc, signer, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !signer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let order_id = u64::from_le_bytes(data[..8].try_into().unwrap());

    // Validate credit authorization (owner or non-expired session key). Order
    // attribution stays with credit.owner (checked against slot.owner below).
    let credit_owner;
    {
        let now = Clock::get()?.unix_timestamp;
        let credit = TradingCredit::from_account_info(trading_credit_acc)?;
        if !credit.is_authorized_signer(signer.key(), now) {
            return Err(SlipstreamError::InvalidAuthority.into());
        }
        credit_owner = credit.owner;
    }

    let ob_data = unsafe { order_book_acc.borrow_mut_data_unchecked() };
    let mut ob = OrderBookView::from_account_data(ob_data)?;

    // Reconcile before computing returns — covers fills against this slot that happened
    // since the user's last interaction.
    {
        let credit = TradingCredit::from_account_info_mut(trading_credit_acc)?;
        reconcile_credit(&ob, credit);
    }

    let slot_idx = find_order_by_id(&ob, order_id)?;

    // Capture slot info, including post-reconcile margin (reconcile already reflects
    // any earlier partial fills on this slot).
    let (slot_side, slot_price, slot_margin, prev, next) = {
        let slot = &ob.order_slots[slot_idx as usize];
        if slot.owner != credit_owner {
            return Err(SlipstreamError::NotOrderOwner.into());
        }
        (
            slot.side,
            slot.price,
            slot.margin_reserved,
            slot.prev_at_level,
            slot.next_at_level,
        )
    };

    // Unlink from price-level FIFO
    if prev != SENTINEL {
        ob.order_slots[prev as usize].next_at_level = next;
    }
    if next != SENTINEL {
        ob.order_slots[next as usize].prev_at_level = prev;
    }

    if slot_side == SIDE_BID {
        if let Some(level_idx) = ob.find_bid_level(slot_price) {
            let level = &ob.bid_levels[level_idx];
            if level.order_count == 1 {
                ob.remove_bid_level(level_idx);
            } else if level.head_slot == slot_idx {
                ob.bid_levels[level_idx].remove_head(next);
            } else if level.tail_slot == slot_idx {
                ob.bid_levels[level_idx].tail_slot = prev;
                ob.bid_levels[level_idx].order_count -= 1;
            } else {
                ob.bid_levels[level_idx].order_count -= 1;
            }
        }
    } else {
        if let Some(level_idx) = ob.find_ask_level(slot_price) {
            let level = &ob.ask_levels[level_idx];
            if level.order_count == 1 {
                ob.remove_ask_level(level_idx);
            } else if level.head_slot == slot_idx {
                ob.ask_levels[level_idx].remove_head(next);
            } else if level.tail_slot == slot_idx {
                ob.ask_levels[level_idx].tail_slot = prev;
                ob.ask_levels[level_idx].order_count -= 1;
            } else {
                ob.ask_levels[level_idx].order_count -= 1;
            }
        }
    }

    ob.free_slot(slot_idx);

    // Return the slot's remaining margin to the credit's available pool
    let credit = TradingCredit::from_account_info_mut(trading_credit_acc)?;
    credit.committed = credit.committed.saturating_sub(slot_margin);
    credit.active_orders = credit.active_orders.saturating_sub(1);

    Ok(())
}

fn find_order_by_id(ob: &OrderBookView, order_id: u64) -> Result<u16, ProgramError> {
    let max = ob.header.max_order_slots as usize;
    for i in 0..max {
        if ob.order_slots[i].is_active() && ob.order_slots[i].order_id == order_id {
            return Ok(i as u16);
        }
    }
    Err(SlipstreamError::OrderNotFound.into())
}
