use bytemuck::{Pod, Zeroable};
use pinocchio::{account_info::AccountInfo, program_error::ProgramError};

use super::DISC_MARKET;

pub const TWAP_BUFFER_SIZE: usize = 225;

/// `restricted_mode` values
pub const RESTRICTED_MODE_OFF: u8 = 0;
pub const RESTRICTED_MODE_ON: u8 = 1;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Market {
    pub discriminator: u8,
    pub bump: u8,
    pub market_index: u16,
    pub max_leverage: u8,
    pub circuit_breaker_active: u8,
    pub taker_fee_bps: u16,
    pub maker_rebate_bps: u16,
    pub twap_write_index: u16,
    pub twap_count: u16,
    pub _padding1: [u8; 2],
    pub base_mint: [u8; 32],
    pub quote_mint: [u8; 32],
    pub pyth_feed: [u8; 32],
    pub quote_vault: [u8; 32],
    pub tick_size: u64,
    pub lot_size: u64,
    pub funding_interval_secs: u64,
    pub last_funding_ts: i64,
    pub open_interest_long: u64,
    pub open_interest_short: u64,
    pub insurance_fund_balance: u64,
    pub last_mark_price: u64,
    pub cumulative_funding_index_lo: i64,
    pub cumulative_funding_index_hi: i64,
    pub twap_prices: [u64; TWAP_BUFFER_SIZE],
    // --- Round 3 additions (appended; keeps existing field offsets stable) ---
    pub switchboard_feed: [u8; 32],
    /// 0 = normal trading, 1 = restricted (closes only, no liquidations).
    /// Set on dual-oracle disagreement; cleared after 3 consecutive agreement readings.
    pub restricted_mode: u8,
    /// Number of consecutive agreement readings since restricted_mode was set.
    /// Used for hysteresis when exiting restricted mode.
    pub agreement_streak: u8,
    pub _padding2: [u8; 6],
}

impl Market {
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn get_cumulative_funding_index(&self) -> i128 {
        ((self.cumulative_funding_index_hi as i128) << 64)
            | (self.cumulative_funding_index_lo as u64 as i128)
    }

    pub fn set_cumulative_funding_index(&mut self, value: i128) {
        self.cumulative_funding_index_lo = value as i64;
        self.cumulative_funding_index_hi = (value >> 64) as i64;
    }

    pub fn from_account_info(account: &AccountInfo) -> Result<&Self, ProgramError> {
        let data = unsafe { account.borrow_data_unchecked() };
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != DISC_MARKET {
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

    pub fn push_twap_price(&mut self, price: u64) {
        let idx = self.twap_write_index as usize;
        self.twap_prices[idx] = price;
        self.twap_write_index = ((idx + 1) % TWAP_BUFFER_SIZE) as u16;
        if (self.twap_count as usize) < TWAP_BUFFER_SIZE {
            self.twap_count += 1;
        }
    }

    pub fn get_twap(&self) -> Option<u64> {
        let count = self.twap_count as usize;
        if count == 0 {
            return None;
        }
        let sum: u128 = if count == TWAP_BUFFER_SIZE {
            self.twap_prices.iter().map(|&p| p as u128).sum()
        } else {
            self.twap_prices[..count].iter().map(|&p| p as u128).sum()
        };
        Some((sum / count as u128) as u64)
    }

    /// Mark price used to settle a close-at-market: prefer `last_mark_price`
    /// (refreshed every `crank_twap`, the same cadence liquidation's live-oracle
    /// read effectively tracks) over the lagging 30-min TWAP, which would let a
    /// losing trader close at a stale, more favorable price during a fast move.
    /// Falls back to the TWAP only before the market has ever been cranked.
    pub fn mark_price_for_close(&self) -> Option<u64> {
        if self.last_mark_price > 0 {
            Some(self.last_mark_price)
        } else {
            self.get_twap()
        }
    }

    pub fn is_restricted(&self) -> bool {
        self.restricted_mode != 0
    }

    /// Settlement cursor: the highest FillEvent.sequence already settled on L1.
    ///
    /// Stored in the first 4 bytes of the trailing `_padding2` (interpreted as a
    /// little-endian u32) so that `Market::LEN` is byte-identical to the deployed
    /// layout — no market re-init is required. A u32 supports ~4.29B fills, far
    /// beyond the devnet MVP. Because the OrderBook is delegated to the ER, L1
    /// `settle_trades` reads its committed fill queue READ-ONLY and cannot mutate
    /// the book's head/count; this owned cursor records settlement progress
    /// instead, so fills are settled exactly once across repeated keeper calls.
    pub fn last_settled_sequence(&self) -> u64 {
        u32::from_le_bytes([
            self._padding2[0],
            self._padding2[1],
            self._padding2[2],
            self._padding2[3],
        ]) as u64
    }

    pub fn set_last_settled_sequence(&mut self, seq: u64) {
        let bytes = (seq as u32).to_le_bytes();
        self._padding2[0] = bytes[0];
        self._padding2[1] = bytes[1];
        self._padding2[2] = bytes[2];
        self._padding2[3] = bytes[3];
    }
}
