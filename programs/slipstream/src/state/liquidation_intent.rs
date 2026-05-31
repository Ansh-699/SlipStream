use bytemuck::{Pod, Zeroable};
use pinocchio::{account_info::AccountInfo, program_error::ProgramError};

use super::DISC_LIQUIDATION_INTENT;

/// PDA seeded by `["liq_intent", position_pubkey]`.
///
/// Written by `liquidate_position` when a candidate position has pending fills
/// (per §11). Records a 60-second deadline; a second `liquidate_position` call
/// after the deadline (with health factor still below 1.0) executes the liquidation,
/// while a call with health factor restored deletes the intent.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct LiquidationIntent {
    pub discriminator: u8,
    pub bump: u8,
    pub _padding: [u8; 6],
    pub position: [u8; 32],
    pub created_ts: i64,
    pub deadline_ts: i64,
    pub initial_health_factor: u64, // 6-decimal at time of intent creation
}

impl LiquidationIntent {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub const GRACE_WINDOW_SECS: i64 = 60;

    pub fn from_account_info(account: &AccountInfo) -> Result<&Self, ProgramError> {
        let data = unsafe { account.borrow_data_unchecked() };
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != DISC_LIQUIDATION_INTENT {
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

    pub fn is_expired(&self, now: i64) -> bool {
        now >= self.deadline_ts
    }
}
