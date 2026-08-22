use bytemuck::{Pod, Zeroable};
use pinocchio::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

use super::DISC_GLOBAL_STATE;

/// The keeper role lives PAST `GlobalState::LEN`, in the same lazily-grown region
/// `pending_authority` occupies at offset 104 (`propose_authority.rs:79-92`).
/// `LEN` stays 104 and no live account is bricked: the field is simply absent
/// until `set_keeper` extends the account.
pub const KEEPER_OFFSET: usize = 136;
pub const KEEPER_EXTENDED_LEN: usize = KEEPER_OFFSET + 32;

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
        if data[0] != DISC_GLOBAL_STATE {
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
        if data[0] != 0 && data[0] != DISC_GLOBAL_STATE {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(bytemuck::from_bytes_mut(&mut data[..Self::LEN]))
    }

    /// The installed keeper, or `None` when the account has not been extended
    /// yet or the field is still all-zero.
    pub fn keeper(account_data: &[u8]) -> Option<[u8; 32]> {
        let bytes: [u8; 32] = account_data
            .get(KEEPER_OFFSET..KEEPER_EXTENDED_LEN)?
            .try_into()
            .ok()?;
        (bytes != [0u8; 32]).then_some(bytes)
    }

    /// True for `authority`, and for a non-zero `keeper` on an extended account.
    ///
    /// S10-01: three fill-log instructions gated on `authority`, which is also
    /// the BPF upgrade authority and the USDC mint authority, so the keeper VM
    /// had to hold that key hot. This WIDENS the accepted set — a stranger is
    /// still refused — and falls back to `authority` alone whenever the account
    /// is short or the field is zero, so the live unextended `GlobalState` keeps
    /// working before `set_keeper` is ever called.
    pub fn is_authority_or_keeper(account_data: &[u8], signer: &Pubkey) -> bool {
        if account_data.len() < Self::LEN || account_data[0] != DISC_GLOBAL_STATE {
            return false;
        }
        let global: &Self = bytemuck::from_bytes(&account_data[..Self::LEN]);
        global.authority == *signer || Self::keeper(account_data) == Some(*signer)
    }
}
