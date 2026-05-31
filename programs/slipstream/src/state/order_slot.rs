use bytemuck::{Pod, Zeroable};

use super::SENTINEL;

pub const SIDE_BID: u8 = 0;
pub const SIDE_ASK: u8 = 1;

pub const ORDER_TYPE_LIMIT: u8 = 0;
pub const ORDER_TYPE_POST_ONLY: u8 = 1;
pub const ORDER_TYPE_IOC: u8 = 2;
pub const ORDER_TYPE_FOK: u8 = 3;
pub const ORDER_TYPE_MARKET: u8 = 4;

/// One order resting in the book or being matched.
///
/// 88 bytes (was 80). The extra `margin_reserved` is the quote-asset margin this
/// slot is holding against a user's `TradingCredit.committed`. Drains proportionally
/// as the order fills. On full cancel or full fill, the remainder returns to
/// `TradingCredit.committed -> credit`.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct OrderSlot {
    pub active: u8,
    pub side: u8,
    pub order_type: u8,
    pub _pad1: u8,
    pub next_at_level: u16,
    pub prev_at_level: u16,
    pub order_id: u64,
    pub owner: [u8; 32],
    pub price: u64,
    pub size: u64,
    pub remaining_size: u64,
    pub expiry_ts: i64,
    pub margin_reserved: u64,
}

impl OrderSlot {
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn is_active(&self) -> bool {
        self.active != 0
    }

    pub fn is_bid(&self) -> bool {
        self.side == SIDE_BID
    }

    pub fn clear(&mut self) {
        *self = Self::zeroed();
    }

    pub fn init(
        &mut self,
        order_id: u64,
        owner: [u8; 32],
        side: u8,
        order_type: u8,
        price: u64,
        size: u64,
        expiry_ts: i64,
        margin_reserved: u64,
    ) {
        self.active = 1;
        self.side = side;
        self.order_type = order_type;
        self._pad1 = 0;
        self.next_at_level = SENTINEL;
        self.prev_at_level = SENTINEL;
        self.order_id = order_id;
        self.owner = owner;
        self.price = price;
        self.size = size;
        self.remaining_size = size;
        self.expiry_ts = expiry_ts;
        self.margin_reserved = margin_reserved;
    }

    /// Compute margin to release for a partial fill proportional to `filled_size`.
    /// Returns `filled_margin` and leaves `margin_reserved` reduced by that amount.
    /// Also decrements `remaining_size` by `filled_size` so the caller does not have
    /// to track the two counters separately.
    pub fn drain_margin_for_fill(&mut self, filled_size: u64) -> u64 {
        if self.remaining_size == 0 || self.margin_reserved == 0 || filled_size == 0 {
            return 0;
        }
        let clamped = filled_size.min(self.remaining_size);
        // Proportional share: clamped / remaining. Use u128 to avoid overflow.
        let share = (self.margin_reserved as u128)
            .saturating_mul(clamped as u128)
            / (self.remaining_size as u128);
        let filled_margin = share.min(self.margin_reserved as u128) as u64;
        self.margin_reserved -= filled_margin;
        self.remaining_size -= clamped;
        filled_margin
    }
}
