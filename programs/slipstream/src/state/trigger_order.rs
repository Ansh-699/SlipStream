use bytemuck::{Pod, Zeroable};
use pinocchio::{account_info::AccountInfo, program_error::ProgramError};

use super::DISC_TRIGGER_ORDER;

/// `kind` values (also the last PDA seed byte — one SL and one TP per
/// owner+market, matching the per-(owner, market) Position).
pub const TRIGGER_KIND_STOP_LOSS: u8 = 0;
pub const TRIGGER_KIND_TAKE_PROFIT: u8 = 1;

/// PDA seeded by `["trigger", owner, market_index_le, [kind]]`.
///
/// A keeper-executed close-at-market order: when the mark price crosses
/// `trigger_price` in the stored direction, any executor may fire
/// `execute_trigger`, which closes the owner's position via the same settlement
/// path as `close_position` and pays the account's rent to the executor.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct TriggerOrder {
    pub discriminator: u8,
    pub bump: u8,
    /// TRIGGER_KIND_STOP_LOSS | TRIGGER_KIND_TAKE_PROFIT (informational; the
    /// executable condition is `trigger_above`).
    pub kind: u8,
    /// 1 = execute when mark >= trigger_price, 0 = execute when mark <= it.
    /// Set client-side from position side + kind (e.g. long SL = below).
    pub trigger_above: u8,
    pub market_index: u16,
    pub _padding: [u8; 2],
    pub owner: [u8; 32],
    pub trigger_price: u64,
    pub created_ts: i64,
}

impl TriggerOrder {
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn from_account_info(account: &AccountInfo) -> Result<&Self, ProgramError> {
        let data = unsafe { account.borrow_data_unchecked() };
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != DISC_TRIGGER_ORDER {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(bytemuck::from_bytes(&data[..Self::LEN]))
    }

    // The unchecked borrow hands out &mut from &AccountInfo; sound here because
    // the runtime guarantees each writable account's data is exclusively borrowed
    // per instruction (same pattern as every state struct in this program).
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
        if data[0] != DISC_TRIGGER_ORDER {
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
        if data[0] != 0 && data[0] != DISC_TRIGGER_ORDER {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(bytemuck::from_bytes_mut(&mut data[..Self::LEN]))
    }

    /// True when `mark` satisfies the stored trigger condition.
    pub fn is_met(&self, mark: u64) -> bool {
        if self.trigger_above != 0 {
            mark >= self.trigger_price
        } else {
            mark <= self.trigger_price
        }
    }
}
