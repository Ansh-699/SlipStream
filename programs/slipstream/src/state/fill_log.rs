use bytemuck::{Pod, Zeroable};
use pinocchio::program_error::ProgramError;

use super::{FillEvent, DISC_FILL_LOG};

/// Capacity of a FillLog's ring (number of FillEvents it can hold).
///
/// Sized so the WHOLE account stays well under Solana's 10,240-byte per-CPI
/// account-growth cap: `FillLogHeader::LEN (32) + 80 * FillEvent::LEN (104)
/// = 8352 bytes`. That cap is exactly why the 612 KB OrderBook can never be
/// (re)delegated — the FillLog is deliberately small enough that it can be
/// created in ONE CreateAccount CPI and, when its sponsored-commit budget nears
/// the limit, rotated to a fresh epoch PDA (which gets its own fresh budget).
pub const FILL_LOG_CAPACITY: u16 = 80;

/// Fixed header at the start of the FillLog account; the FillEvent ring follows.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct FillLogHeader {
    pub discriminator: u8,
    pub bump: u8,
    pub market_index: u16,
    /// Rotation epoch. The FillLog PDA is derived from this, so bumping the epoch
    /// yields a brand-new delegated account with a fresh sponsored-commit budget.
    pub epoch: u32,
    /// Ring capacity (== FILL_LOG_CAPACITY at init; stored for forward-compat).
    pub capacity: u16,
    /// Number of valid fills currently stored (0..=capacity).
    pub count: u16,
    /// Ring head index (oldest stored fill).
    pub head: u16,
    pub _pad: [u8; 2],
    /// Highest OrderBook fill `sequence` already mirrored into this log. The
    /// mirror keeper resumes from here so each orderbook fill is appended once.
    pub last_mirrored_sequence: u64,
}

impl FillLogHeader {
    pub const LEN: usize = core::mem::size_of::<Self>();
}

/// Total account size for a FillLog with the default capacity.
pub fn fill_log_account_size(capacity: u16) -> usize {
    FillLogHeader::LEN + (capacity as usize) * FillEvent::LEN
}

/// Zero-copy mutable view over a FillLog account's header + ring.
pub struct FillLogView<'a> {
    pub header: &'a mut FillLogHeader,
    pub fills: &'a mut [FillEvent],
}

impl<'a> FillLogView<'a> {
    pub fn from_account_data(data: &'a mut [u8]) -> Result<Self, ProgramError> {
        if data.len() < FillLogHeader::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != DISC_FILL_LOG {
            return Err(ProgramError::InvalidAccountData);
        }
        let capacity = {
            let header: &FillLogHeader = bytemuck::from_bytes(&data[..FillLogHeader::LEN]);
            header.capacity as usize
        };
        if data.len() < FillLogHeader::LEN + capacity * FillEvent::LEN {
            return Err(ProgramError::InvalidAccountData);
        }

        let ptr = data.as_mut_ptr();
        let header = unsafe { &mut *(ptr as *mut FillLogHeader) };
        let fills = unsafe {
            core::slice::from_raw_parts_mut(
                ptr.add(FillLogHeader::LEN) as *mut FillEvent,
                capacity,
            )
        };
        Ok(Self { header, fills })
    }

    /// Append a fill to the ring. When full, the oldest entry is overwritten
    /// (head advances). In normal operation the keeper commits + settles faster
    /// than `capacity` new fills accrue, so live fills are never lost; the
    /// overwrite is only a safety valve, never the steady state.
    pub fn push(&mut self, fill: FillEvent) {
        let cap = self.header.capacity;
        if cap == 0 {
            return;
        }
        let tail = (self.header.head + self.header.count) % cap;
        self.fills[tail as usize] = fill;
        if self.header.count < cap {
            self.header.count += 1;
        } else {
            // Full: overwrite oldest, advance head.
            self.header.head = (self.header.head + 1) % cap;
        }
    }
}
