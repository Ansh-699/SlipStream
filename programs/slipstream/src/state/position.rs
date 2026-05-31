use bytemuck::{Pod, Zeroable};
use pinocchio::{account_info::AccountInfo, program_error::ProgramError};

use super::DISC_POSITION;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Position {
    pub discriminator: u8,
    pub bump: u8,
    pub market_index: u16,
    pub _padding1: [u8; 4],
    pub owner: [u8; 32],
    pub size: i64,
    pub entry_price: u64,
    pub collateral: u64,
    pub realized_pnl: i64,
    pub open_slot: u64,
    // i128 split into two i64s for cross-platform Pod compatibility
    pub funding_index_snapshot_lo: i64,
    pub funding_index_snapshot_hi: i64,
}

impl Position {
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn get_funding_index_snapshot(&self) -> i128 {
        ((self.funding_index_snapshot_hi as i128) << 64)
            | (self.funding_index_snapshot_lo as u64 as i128)
    }

    pub fn set_funding_index_snapshot(&mut self, value: i128) {
        self.funding_index_snapshot_lo = value as i64;
        self.funding_index_snapshot_hi = (value >> 64) as i64;
    }

    pub fn from_account_info(account: &AccountInfo) -> Result<&Self, ProgramError> {
        let data = unsafe { account.borrow_data_unchecked() };
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != DISC_POSITION {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(bytemuck::from_bytes(&data[..Self::LEN]))
    }

    pub fn from_account_info_mut(account: &AccountInfo) -> Result<&mut Self, ProgramError> {
        let data = unsafe { account.borrow_mut_data_unchecked() };
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(bytemuck::from_bytes_mut(&mut data[..Self::LEN]))
    }

    pub fn is_long(&self) -> bool {
        self.size > 0
    }

    pub fn is_short(&self) -> bool {
        self.size < 0
    }

    pub fn abs_size(&self) -> u64 {
        self.size.unsigned_abs()
    }

    pub fn is_empty(&self) -> bool {
        self.size == 0
    }
}
