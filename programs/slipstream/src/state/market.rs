use bytemuck::{Pod, Zeroable};
use pinocchio::{account_info::AccountInfo, program_error::ProgramError};

use super::DISC_MARKET;

pub const TWAP_BUFFER_SIZE: usize = 225;

/// `restricted_mode` values
pub const RESTRICTED_MODE_OFF: u8 = 0;
pub const RESTRICTED_MODE_ON: u8 = 1;

/// Max age (minutes) of `last_mark_price` before close-at-market refuses to
/// settle. The crank refreshes it every ~8s and every settled fill also
/// refreshes it, so exceeding this means the price feed is effectively dead.
/// Generous (225 missed cranks) to avoid false positives on transient RPC gaps.
pub const MARK_PRICE_MAX_STALENESS_MINS: u16 = 30;

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
        if data[0] != DISC_MARKET {
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
        if data[0] != 0 && data[0] != DISC_MARKET {
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

    /// Freshness stamp for `last_mark_price`: `(unix_ts / 60) mod 2^16`, stored
    /// as a little-endian u16 in `_padding1` so `Market::LEN` is byte-identical
    /// to the deployed layout (same trick as `last_settled_sequence`). 0 means
    /// "never stamped" (a pre-upgrade market or the ~1-in-45-days minute that
    /// hashes to 0) and is treated as fresh so closes never break in the window
    /// between the program upgrade and the next crank.
    pub fn mark_price_minute(&self) -> u16 {
        u16::from_le_bytes([self._padding1[0], self._padding1[1]])
    }

    pub fn set_mark_price_minute(&mut self, minute: u16) {
        let b = minute.to_le_bytes();
        self._padding1[0] = b[0];
        self._padding1[1] = b[1];
    }

    /// True if `last_mark_price` was refreshed within the staleness window.
    /// Uses modular minute arithmetic (correct for any real age < ~22 days).
    pub fn is_mark_price_fresh(&self, now_ts: i64) -> bool {
        let stamp = self.mark_price_minute();
        if stamp == 0 {
            return true; // unstamped: preserve pre-upgrade behavior
        }
        let now_min = ((now_ts / 60) as u64 % 65536) as u16;
        now_min.wrapping_sub(stamp) <= MARK_PRICE_MAX_STALENESS_MINS
    }

    /// Mark price used to settle a close-at-market (and keeper SL/TP triggers):
    /// prefer `last_mark_price` (refreshed every `crank_twap`) over the lagging
    /// 30-min TWAP, which would let a losing trader close at a stale, more
    /// favorable price during a fast move.
    ///
    /// If `last_mark_price` is set but STALE — the crank (and settlement, which
    /// also refreshes it) has been dead past the staleness window — return None
    /// so the caller errors with OracleStale rather than SILENTLY settling at an
    /// arbitrarily old price. Falls back to the TWAP only before the market has
    /// ever been cranked (`last_mark_price == 0`, e.g. a brand-new market).
    pub fn mark_price_for_close(&self, now_ts: i64) -> Option<u64> {
        if self.last_mark_price > 0 {
            if self.is_mark_price_fresh(now_ts) {
                Some(self.last_mark_price)
            } else {
                None
            }
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
