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

    // The unchecked borrow hands out &mut from &AccountInfo; sound because the
    // runtime guarantees each writable account's data is exclusively borrowed
    // per instruction.
    #[allow(clippy::mut_from_ref)]
    pub fn from_account_info_mut(account: &AccountInfo) -> Result<&mut Self, ProgramError> {
        let data = unsafe { account.borrow_mut_data_unchecked() };
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        // Type check on the WRITE path. Without it, any program-owned account of a
        // compatible size can be cast to this type and overwritten field-by-field
        // (Position and TradingCredit are both 96 bytes with `owner` at offset 8,
        // so authorize_session could rewrite a Position's collateral).
        if data[0] != DISC_USER_ACCOUNT {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(bytemuck::from_bytes_mut(&mut data[..Self::LEN]))
    }

    /// As `from_account_info_mut`, but also accepts a freshly created account whose
    /// discriminator is still zero. Initialize/upsert paths only.
    #[allow(clippy::mut_from_ref)]
    pub fn from_account_info_mut_or_init(account: &AccountInfo) -> Result<&mut Self, ProgramError> {
        let data = unsafe { account.borrow_mut_data_unchecked() };
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != 0 && data[0] != DISC_USER_ACCOUNT {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(bytemuck::from_bytes_mut(&mut data[..Self::LEN]))
    }
}
