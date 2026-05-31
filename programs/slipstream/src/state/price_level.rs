use bytemuck::{Pod, Zeroable};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PriceLevel {
    pub price: u64,
    pub head_slot: u16,
    pub tail_slot: u16,
    pub order_count: u16,
    pub _pad: [u8; 2],
}

impl PriceLevel {
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn is_empty(&self) -> bool {
        self.order_count == 0
    }

    pub fn is_active(&self) -> bool {
        self.price != 0 && self.order_count > 0
    }

    pub fn clear(&mut self) {
        *self = Self::zeroed();
    }

    pub fn init(&mut self, price: u64, slot_index: u16) {
        self.price = price;
        self.head_slot = slot_index;
        self.tail_slot = slot_index;
        self.order_count = 1;
    }

    pub fn append(&mut self, slot_index: u16) {
        self.tail_slot = slot_index;
        self.order_count += 1;
    }

    pub fn remove_head(&mut self, new_head: u16) {
        self.head_slot = new_head;
        self.order_count -= 1;
    }
}
