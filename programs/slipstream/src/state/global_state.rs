use bytemuck::{Pod, Zeroable};
use pinocchio::{account_info::AccountInfo, program_error::ProgramError};

use super::DISC_GLOBAL_STATE;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct GlobalState {
    pub discriminator: u8,
    pub bump: u8,
    pub market_count: u16,
    pub paused: u8,
    pub _padding1: [u8; 3],
    pub authority: [u8; 32],
    pub treasury: [u8; 32],
    pub insurance_vault: [u8; 32],
}

impl GlobalState {
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn from_account_info(account: &AccountInfo) -> Result<&Self, ProgramError> {
        let data = unsafe { account.borrow_data_unchecked() };
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != DISC_GLOBAL_STATE {
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
