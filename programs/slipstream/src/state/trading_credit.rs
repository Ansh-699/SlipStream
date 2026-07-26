use bytemuck::{Pod, Zeroable};
use pinocchio::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

use super::{DISC_TRADING_CREDIT, OrderBookView};

/// Per-(user, market) account that holds margin delegated to the ER.
///
/// Split of responsibility relative to `UserAccount`:
///   - `UserAccount` (L1, never delegated) — holds `free_collateral`, pending_fills,
///     owner, long-lived lifecycle state.
///   - `TradingCredit` (delegated to ER during an active session) — holds the margin
///     the user has allocated to a specific market. The ER uses it to enforce that
///     orders only reserve margin the user actually posted.
///
/// Invariants at rest (after `reconcile`):
///   - `committed == Σ margin_reserved over active slots owned by this user`
///   - `active_orders == count of active slots owned by this user`
///   - `committed <= credit`
///
/// During ER matching, the maker's `TradingCredit` cannot be touched (only one
/// credit — the taker's — is passed as a tx account). Fills drain the slot's
/// `margin_reserved` and stamp `filled_margin` on the FillEvent. The maker's
/// `committed` therefore becomes stale until their next operation, which calls
/// `reconcile_credit` to catch up: the difference between old `committed` and the
/// current sum of active slot margins is the amount that flowed to Position.collateral
/// via settlement, so `credit -= delta`.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct TradingCredit {
    pub discriminator: u8,
    pub bump: u8,
    pub market_index: u16,
    pub active_orders: u16,
    pub _padding: [u8; 2],
    pub owner: [u8; 32],
    pub credit: u64,
    pub committed: u64,
    /// An optional browser/bot SESSION key authorized to sign place_order /
    /// cancel_order on the OWNER's behalf. All-zero means "no active session".
    /// The session key is only an authorized SIGNER — order attribution always
    /// stays with `owner` (see place_order / cancel_order / reconcile_credit).
    pub session_authority: [u8; 32],
    /// Unix timestamp (secs) after which `session_authority` is no longer
    /// accepted. 0 (or any past value) means "expired / none".
    pub session_expiry: i64,
}

impl TradingCredit {
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn from_account_info(account: &AccountInfo) -> Result<&Self, ProgramError> {
        let data = unsafe { account.borrow_data_unchecked() };
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != DISC_TRADING_CREDIT {
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
        if data[0] != DISC_TRADING_CREDIT {
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
        if data[0] != 0 && data[0] != DISC_TRADING_CREDIT {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(bytemuck::from_bytes_mut(&mut data[..Self::LEN]))
    }

    /// Credit available to reserve for new orders (credit minus already-committed).
    pub fn available(&self) -> u64 {
        self.credit.saturating_sub(self.committed)
    }

    pub fn is_idle(&self) -> bool {
        self.active_orders == 0 && self.committed == 0
    }

    /// Whether `signer` is authorized to place/cancel orders for this credit at
    /// time `now` (unix secs). The owner is always authorized. A non-zero
    /// `session_authority` is authorized only while `now < session_expiry`.
    ///
    /// Note: authorization is about who may SIGN — the order/position is always
    /// attributed to `owner`, never to the session key.
    pub fn is_authorized_signer(&self, signer: &Pubkey, now: i64) -> bool {
        if signer == &self.owner {
            return true;
        }
        let session_active =
            self.session_authority != [0u8; 32] && now < self.session_expiry;
        session_active && signer == &self.session_authority
    }
}

/// Scan the order book for `owner`'s active slots, recompute actual committed margin
/// and active order count, and reconcile `credit` accordingly.
///
/// Returns the amount of margin that was "drained by fills" since the last
/// reconciliation (this is the amount that flowed out to settlement).
pub fn reconcile_credit(ob: &OrderBookView, credit: &mut TradingCredit) -> u64 {
    let mut actual_committed: u64 = 0;
    let mut actual_active: u16 = 0;
    let owner = credit.owner;
    let max = ob.header.max_order_slots as usize;
    for i in 0..max {
        let slot = &ob.order_slots[i];
        if slot.is_active() && slot.owner == owner {
            actual_committed = actual_committed.saturating_add(slot.margin_reserved);
            actual_active = actual_active.saturating_add(1);
        }
    }
    let drained = credit.committed.saturating_sub(actual_committed);
    if drained > 0 {
        credit.credit = credit.credit.saturating_sub(drained);
    }
    credit.committed = actual_committed;
    credit.active_orders = actual_active;
    drained
}
