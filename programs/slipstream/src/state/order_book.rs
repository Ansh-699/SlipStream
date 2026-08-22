use bytemuck::{Pod, Zeroable};
use pinocchio::program_error::ProgramError;

use super::{FillEvent, OrderSlot, PriceLevel, DISC_ORDER_BOOK, SENTINEL};
use crate::error::SlipstreamError;

pub const DEFAULT_MAX_ORDER_SLOTS: u16 = 2048;
pub const DEFAULT_MAX_PRICE_LEVELS: u16 = 512;
pub const DEFAULT_MAX_FILL_EVENTS: u16 = 4096;
pub const DEFAULT_ORDERS_PER_USER: u8 = 20;

/// Fixed-size header at the start of the OrderBook account.
/// The arrays (order slots, price levels, fill events, free list)
/// follow immediately after this header in the account data.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct OrderBookHeader {
    pub discriminator: u8,
    pub bump: u8,
    pub market_index: u16,
    pub orders_per_user: u8,
    pub _pad1: [u8; 3],
    pub max_order_slots: u16,
    pub max_price_levels_per_side: u16,
    pub max_fill_events: u16,
    pub active_order_count: u16,
    pub bid_level_count: u16,
    pub ask_level_count: u16,
    pub fill_event_head: u16,
    pub fill_event_tail: u16,
    pub fill_event_count: u16,
    pub free_list_head: u16,
    pub free_slot_count: u16,
    pub _pad2: [u8; 2],
    pub next_order_id: u64,
    pub next_fill_sequence: u64,
}

impl OrderBookHeader {
    pub const LEN: usize = core::mem::size_of::<Self>();

    /// Compute total account size needed for given capacity parameters.
    pub fn compute_account_size(
        max_order_slots: u16,
        max_price_levels: u16,
        max_fill_events: u16,
    ) -> usize {
        Self::LEN
            + (max_order_slots as usize * OrderSlot::LEN)   // order slot pool
            + (max_price_levels as usize * PriceLevel::LEN)  // bid levels
            + (max_price_levels as usize * PriceLevel::LEN)  // ask levels
            + (max_fill_events as usize * FillEvent::LEN)    // fill event queue
            + (max_order_slots as usize * 2)                 // free list (u16 per slot)
    }

    pub fn default_account_size() -> usize {
        Self::compute_account_size(
            DEFAULT_MAX_ORDER_SLOTS,
            DEFAULT_MAX_PRICE_LEVELS,
            DEFAULT_MAX_FILL_EVENTS,
        )
    }
}

/// Runtime accessor for the order book's variable-length sections.
/// All access is zero-copy via byte slices from the account data.
pub struct OrderBookView<'a> {
    pub header: &'a mut OrderBookHeader,
    pub order_slots: &'a mut [OrderSlot],
    pub bid_levels: &'a mut [PriceLevel],
    pub ask_levels: &'a mut [PriceLevel],
    pub fill_events: &'a mut [FillEvent],
    pub free_list: &'a mut [u16],
}

impl<'a> OrderBookView<'a> {
    /// Parse an OrderBook account into its component slices.
    /// Safety: caller must ensure account data is large enough and properly initialized.
    pub fn from_account_data(data: &'a mut [u8]) -> Result<Self, ProgramError> {
        if data.len() < OrderBookHeader::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != DISC_ORDER_BOOK {
            return Err(ProgramError::InvalidAccountData);
        }

        let header: &OrderBookHeader = bytemuck::from_bytes(&data[..OrderBookHeader::LEN]);
        let max_slots = header.max_order_slots as usize;
        let max_levels = header.max_price_levels_per_side as usize;
        let max_fills = header.max_fill_events as usize;

        let expected_size =
            OrderBookHeader::compute_account_size(
                header.max_order_slots,
                header.max_price_levels_per_side,
                header.max_fill_events,
            );
        if data.len() < expected_size {
            return Err(ProgramError::InvalidAccountData);
        }

        let mut offset = OrderBookHeader::LEN;

        // Split the data into sections using raw pointer arithmetic.
        // This is safe because we verified the total size above,
        // and all types are Pod (plain-old-data, no padding UB).
        let ptr = data.as_mut_ptr();

        let header = unsafe { &mut *(ptr as *mut OrderBookHeader) };

        let order_slots = unsafe {
            core::slice::from_raw_parts_mut(
                ptr.add(offset) as *mut OrderSlot,
                max_slots,
            )
        };
        offset += max_slots * OrderSlot::LEN;

        let bid_levels = unsafe {
            core::slice::from_raw_parts_mut(
                ptr.add(offset) as *mut PriceLevel,
                max_levels,
            )
        };
        offset += max_levels * PriceLevel::LEN;

        let ask_levels = unsafe {
            core::slice::from_raw_parts_mut(
                ptr.add(offset) as *mut PriceLevel,
                max_levels,
            )
        };
        offset += max_levels * PriceLevel::LEN;

        let fill_events = unsafe {
            core::slice::from_raw_parts_mut(
                ptr.add(offset) as *mut FillEvent,
                max_fills,
            )
        };
        offset += max_fills * FillEvent::LEN;

        let free_list = unsafe {
            core::slice::from_raw_parts_mut(
                ptr.add(offset) as *mut u16,
                max_slots,
            )
        };

        Ok(Self {
            header,
            order_slots,
            bid_levels,
            ask_levels,
            fill_events,
            free_list,
        })
    }

    /// Allocate a free order slot. Returns the slot index.
    pub fn alloc_slot(&mut self) -> Result<u16, ProgramError> {
        if self.header.free_slot_count == 0 {
            return Err(SlipstreamError::OrderBookFull.into());
        }
        let head = self.header.free_list_head;
        self.header.free_list_head = self.free_list[head as usize];
        self.header.free_slot_count -= 1;
        self.header.active_order_count += 1;
        Ok(head)
    }

    /// Return a slot to the free list.
    pub fn free_slot(&mut self, slot_index: u16) {
        self.order_slots[slot_index as usize].clear();
        self.free_list[slot_index as usize] = self.header.free_list_head;
        self.header.free_list_head = slot_index;
        self.header.free_slot_count += 1;
        self.header.active_order_count -= 1;
    }

    /// Initialize the free list: all slots are free, chained 0->1->2->...->SENTINEL
    pub fn init_free_list(&mut self) {
        let max = self.header.max_order_slots;
        for i in 0..max {
            self.free_list[i as usize] = if i + 1 < max { i + 1 } else { SENTINEL };
        }
        self.header.free_list_head = 0;
        self.header.free_slot_count = max;
    }

    /// Push a fill event to the ring buffer queue.
    ///
    /// LOSSLESS: refuses with `FillQueueFull` once full instead of overwriting
    /// the oldest entry. The previous behaviour advanced `fill_event_head` over
    /// an entry `mirror_fills` had not taken yet and returned `Ok(())`, so the
    /// fill was destroyed with no on-chain signal while `reconcile_credit` had
    /// already debited the maker's credit for it (`S2-01` / `S4-03`).
    ///
    /// Refusing is only safe because there is now a drain:
    /// `mirror_fills` calls [`Self::drain_through_sequence`] to release every
    /// entry the FillLog has already mirrored. Without that drain this is the
    /// hard wall that bricked trading after `max_fill_events` cumulative fills.
    /// A full ring therefore means "full of fills the mirror has not taken",
    /// and halting matching is the correct response — a halt is recoverable,
    /// a destroyed fill is not.
    pub fn push_fill_event(&mut self, event: FillEvent) -> Result<(), ProgramError> {
        let max = self.header.max_fill_events;
        if max == 0 || self.header.fill_event_count >= max {
            return Err(SlipstreamError::FillQueueFull.into());
        }
        let tail = self.header.fill_event_tail;
        self.fill_events[tail as usize] = event;
        self.header.fill_event_tail = (tail + 1) % max;
        self.header.fill_event_count += 1;
        Ok(())
    }

    /// The lowest sequence still present in the ring. Anything below it has
    /// left the ring (drained, popped, or destroyed by the pre-fix overwrite).
    ///
    /// Derived rather than stored: `OrderBookHeader` sits before four
    /// variable-length arrays whose offsets are computed from
    /// `OrderBookHeader::LEN`, so adding a field would misread every live book.
    ///
    /// `saturating_sub`: on an honest book `next_fill_sequence` is incremented
    /// once per push before `fill_event_count` is, so it is always >= the count
    /// and the subtraction cannot underflow. On a header corrupt enough to
    /// break that, saturating to 0 makes the caller's gap check pass, i.e. it
    /// degrades to the pre-fix behaviour rather than erroring out of a getter.
    pub fn oldest_surviving_sequence(&self) -> u64 {
        self.header
            .next_fill_sequence
            .saturating_sub(self.header.fill_event_count as u64)
    }

    /// Release every entry at the head of the ring whose sequence is at or
    /// below `through`, advancing `fill_event_head` and lowering
    /// `fill_event_count`. Returns how many entries were released.
    ///
    /// Sequences are assigned monotonically by `next_fill_sequence`, so the
    /// entries at or below `through` are exactly a prefix of the ring and the
    /// scan stops at the first entry above it.
    pub fn drain_through_sequence(&mut self, through: u64) -> u16 {
        let max = self.header.max_fill_events;
        if max == 0 {
            return 0;
        }
        let mut drained: u16 = 0;
        while self.header.fill_event_count > 0 {
            // `% max` so a header carrying an out-of-range head cannot panic.
            let head = self.header.fill_event_head % max;
            if self.fill_events[head as usize].sequence > through {
                break;
            }
            self.header.fill_event_head = (head + 1) % max;
            self.header.fill_event_count -= 1;
            drained += 1;
        }
        drained
    }

    /// Pop a fill event from the head of the queue.
    pub fn pop_fill_event(&mut self) -> Result<FillEvent, ProgramError> {
        if self.header.fill_event_count == 0 {
            return Err(SlipstreamError::FillQueueEmpty.into());
        }
        let head = self.header.fill_event_head;
        let event = self.fill_events[head as usize];
        self.header.fill_event_head = (head + 1) % self.header.max_fill_events;
        self.header.fill_event_count -= 1;
        Ok(event)
    }

    /// Peek at the next fill event without removing it.
    pub fn peek_fill_event(&self) -> Option<&FillEvent> {
        if self.header.fill_event_count == 0 {
            return None;
        }
        Some(&self.fill_events[self.header.fill_event_head as usize])
    }

    /// Find the index of the best bid level (highest price, index 0).
    /// Bid levels are kept sorted descending by price.
    pub fn best_bid_level(&self) -> Option<&PriceLevel> {
        if self.header.bid_level_count == 0 {
            return None;
        }
        let level = &self.bid_levels[0];
        if level.is_active() { Some(level) } else { None }
    }

    /// Find the index of the best ask level (lowest price, index 0).
    /// Ask levels are kept sorted ascending by price.
    pub fn best_ask_level(&self) -> Option<&PriceLevel> {
        if self.header.ask_level_count == 0 {
            return None;
        }
        let level = &self.ask_levels[0];
        if level.is_active() { Some(level) } else { None }
    }

    /// Find a bid price level by price. Returns the index into bid_levels.
    pub fn find_bid_level(&self, price: u64) -> Option<usize> {
        let count = self.header.bid_level_count as usize;
        // Binary search in descending order
        self.bid_levels[..count]
            .binary_search_by(|level| price.cmp(&level.price))
            .ok()
    }

    /// Find an ask price level by price. Returns the index into ask_levels.
    pub fn find_ask_level(&self, price: u64) -> Option<usize> {
        let count = self.header.ask_level_count as usize;
        // Binary search in ascending order
        self.ask_levels[..count]
            .binary_search_by(|level| level.price.cmp(&price))
            .ok()
    }

    /// Insert a new bid price level at the correct sorted position (descending).
    pub fn insert_bid_level(&mut self, price: u64, slot_index: u16) -> Result<usize, ProgramError> {
        let count = self.header.bid_level_count as usize;
        if count >= self.header.max_price_levels_per_side as usize {
            return Err(SlipstreamError::PriceLevelsFull.into());
        }
        // Find insertion point: first level with price < new price
        let pos = self.bid_levels[..count]
            .iter()
            .position(|l| l.price < price)
            .unwrap_or(count);
        // Shift levels right
        if pos < count {
            self.bid_levels.copy_within(pos..count, pos + 1);
        }
        self.bid_levels[pos].init(price, slot_index);
        self.header.bid_level_count += 1;
        Ok(pos)
    }

    /// Insert a new ask price level at the correct sorted position (ascending).
    pub fn insert_ask_level(&mut self, price: u64, slot_index: u16) -> Result<usize, ProgramError> {
        let count = self.header.ask_level_count as usize;
        if count >= self.header.max_price_levels_per_side as usize {
            return Err(SlipstreamError::PriceLevelsFull.into());
        }
        // Find insertion point: first level with price > new price
        let pos = self.ask_levels[..count]
            .iter()
            .position(|l| l.price > price)
            .unwrap_or(count);
        // Shift levels right
        if pos < count {
            self.ask_levels.copy_within(pos..count, pos + 1);
        }
        self.ask_levels[pos].init(price, slot_index);
        self.header.ask_level_count += 1;
        Ok(pos)
    }

    /// Remove a bid price level at the given index.
    pub fn remove_bid_level(&mut self, level_index: usize) {
        let count = self.header.bid_level_count as usize;
        if level_index + 1 < count {
            self.bid_levels.copy_within(level_index + 1..count, level_index);
        }
        self.bid_levels[count - 1].clear();
        self.header.bid_level_count -= 1;
    }

    /// Remove an ask price level at the given index.
    pub fn remove_ask_level(&mut self, level_index: usize) {
        let count = self.header.ask_level_count as usize;
        if level_index + 1 < count {
            self.ask_levels.copy_within(level_index + 1..count, level_index);
        }
        self.ask_levels[count - 1].clear();
        self.header.ask_level_count -= 1;
    }

    /// Get the next order ID and increment the counter.
    pub fn next_order_id(&mut self) -> u64 {
        let id = self.header.next_order_id;
        self.header.next_order_id += 1;
        id
    }

    /// Get the next fill sequence number and increment.
    pub fn next_fill_sequence(&mut self) -> u64 {
        let seq = self.header.next_fill_sequence;
        self.header.next_fill_sequence += 1;
        seq
    }
}
