use bytemuck::{Pod, Zeroable};
use pinocchio::{account_info::AccountInfo, program_error::ProgramError};

use super::DISC_USER_ACCOUNT;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct UserAccount {
    pub discriminator: u8,
    pub bump: u8,
    pub pending_fills: u16,
    pub _padding1: [u8; 4],
    pub owner: [u8; 32],
    pub free_collateral: u64,
    pub reserved_margin: u64,
}

impl UserAccount {
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn from_account_info(account: &AccountInfo) -> Result<&Self, ProgramError> {
        let data = unsafe { account.borrow_data_unchecked() };
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != DISC_USER_ACCOUNT {
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
}
