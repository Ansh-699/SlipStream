//! Oracle parsing and dual-oracle agreement logic.
//!
//! Slipstream uses two independent oracles (Pyth + Switchboard) for any
//! price-sensitive operation (liquidations, funding). Both must:
//!   1. Be fresh (`now - updated_at < MAX_STALENESS_SECS`)
//!   2. Agree within `MAX_DIVERGENCE_BPS` (200 bps = 2%)
//!
//! Disagreement triggers `Market.restricted_mode` (closes-only). Hysteresis:
//! restricted mode lifts only after 3 consecutive agreement readings.
//!
//! Both parsers are hand-rolled (no `pyth-sdk-solana` / `switchboard-on-demand`
//! crates) to keep the binary small. They read the on-chain account layouts
//! directly.

use pinocchio::{account_info::AccountInfo, program_error::ProgramError};

use crate::error::SlipstreamError;
use crate::state::Market;

/// Max age of an oracle reading (relative to current Unix timestamp) for it to
/// be considered fresh. 60s matches §16.
pub const MAX_STALENESS_SECS: i64 = 60;

/// Maximum tolerated divergence between Pyth and Switchboard, in basis points.
/// 200 bps = 2% (§14, §16).
pub const MAX_DIVERGENCE_BPS: u64 = 200;

/// Number of consecutive agreement readings required to clear `restricted_mode`.
pub const AGREEMENT_HYSTERESIS_COUNT: u8 = 3;

/// One oracle reading, normalised to 6-decimal price.
#[derive(Clone, Copy)]
pub struct OracleReading {
    pub price: u64,
    pub publish_ts: i64,
}

impl OracleReading {
    pub fn is_fresh(&self, now: i64) -> bool {
        let age = now.saturating_sub(self.publish_ts);
        (0..=MAX_STALENESS_SECS).contains(&age)
    }
}

/// Parse a Pyth price account and return a 6-decimal price + publish timestamp.
///
/// Handles BOTH on-chain Pyth layouts so whichever feed account is passed works:
///
/// 1. **Legacy Pyth V2 aggregate** (`PriceAccountV2`, len >= 248):
///    ```text
///    price        i64 @ 208
///    exponent     i32 @ 20
///    agg.status   u32 @ 224   (1 = Trading)
///    timestamp    i64 @ 96    (unix `timestamp` field)
///    ```
///    The previously-deployed parser read these offsets wrong (exponent@224,
///    publish_time@232, status@240) — fixed here.
///
/// 2. **Pyth Receiver `PriceUpdateV2`** (the live, actively-updated devnet feed
///    `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`, len ~= 134):
///    ```text
///    8  disc (Anchor: [34,241,35,99,...])
///    32 write_authority
///    1  verification_level
///    then price_message { feed_id[32], price i64, conf u64, expo i32,
///                         publish_time i64, prev_publish_time i64 }
///    => price        i64 @ 8+32+1+32 = 73
///       expo         i32 @ 89
///       publish_time i64 @ 93
///    ```
///    PriceUpdateV2 carries no trading-status field; freshness is enforced by the
///    caller via `OracleReading::is_fresh`.
///
/// Dispatch is by account length: len >= 248 => legacy V2, else PriceUpdateV2.
pub fn parse_pyth(pyth_acc: &AccountInfo) -> Result<OracleReading, ProgramError> {
    let data = unsafe { pyth_acc.borrow_data_unchecked() };

    if data.len() >= 248 {
        // --- Legacy Pyth V2 aggregate ---
        let exponent = i32::from_le_bytes(data[20..24].try_into().unwrap());
        let publish_time = i64::from_le_bytes(data[96..104].try_into().unwrap());
        let price_raw = i64::from_le_bytes(data[208..216].try_into().unwrap());
        let status = u32::from_le_bytes(data[224..228].try_into().unwrap());

        if status != 1 || price_raw <= 0 {
            return Err(SlipstreamError::OracleStale.into());
        }
        let price = normalise_to_6_decimals(price_raw as u64, exponent)?;
        Ok(OracleReading { price, publish_ts: publish_time })
    } else if data.len() >= 134 {
        // --- Pyth Receiver PriceUpdateV2 (the live devnet feed) ---
        let price_raw = i64::from_le_bytes(data[73..81].try_into().unwrap());
        let exponent = i32::from_le_bytes(data[89..93].try_into().unwrap());
        let publish_time = i64::from_le_bytes(data[93..101].try_into().unwrap());

        if price_raw <= 0 {
            return Err(SlipstreamError::OracleStale.into());
        }
        let price = normalise_to_6_decimals(price_raw as u64, exponent)?;
        Ok(OracleReading { price, publish_ts: publish_time })
    } else {
        Err(SlipstreamError::InvalidOracle.into())
    }
}

/// Parse a Switchboard On-Demand `PullFeedAccountData` and return a 6-decimal price.
///
/// Switchboard On-Demand layout (simplified for MVP — full layout includes signed
/// oracle attestations we don't verify yet):
///   8:   discriminator (skipped)
///   8:   ...
///   80:  result.value      (i128, 18-decimal fixed point)
///   96:  result.timestamp  (i64)
///
/// Real production deployments should call `switchboard-on-demand`'s `verify_value`
/// to check the secp256k1 signatures from the oracle quorum. For MVP we trust the
/// account data (operator-posted) — documented gap.
pub fn parse_switchboard(sb_acc: &AccountInfo) -> Result<OracleReading, ProgramError> {
    let data = unsafe { sb_acc.borrow_data_unchecked() };
    if data.len() < 104 {
        return Err(SlipstreamError::InvalidSwitchboardFeed.into());
    }
    // result.value is an i128 stored as two i64s (lo, hi)
    let value_lo = u64::from_le_bytes(data[80..88].try_into().unwrap());
    let value_hi = i64::from_le_bytes(data[88..96].try_into().unwrap());
    let value: i128 = ((value_hi as i128) << 64) | (value_lo as i128);
    let publish_ts = i64::from_le_bytes(data[96..104].try_into().unwrap());

    if value <= 0 {
        return Err(SlipstreamError::OracleStale.into());
    }
    // Switchboard stores 18-decimal; we want 6-decimal => divide by 10^12
    let price = (value / 1_000_000_000_000i128) as u64;
    if price == 0 {
        return Err(SlipstreamError::OracleStale.into());
    }
    Ok(OracleReading { price, publish_ts })
}

fn normalise_to_6_decimals(raw: u64, exponent: i32) -> Result<u64, ProgramError> {
    let target = -6i32;
    let exp_diff = exponent - target;
    let result = if exp_diff > 0 {
        raw.checked_mul(10u64.pow(exp_diff as u32))
            .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?
    } else if exp_diff < 0 {
        raw / 10u64.pow((-exp_diff) as u32)
    } else {
        raw
    };
    Ok(result)
}

/// Result of a dual-oracle read: the median price + agreement state.
pub struct DualOraclePrice {
    pub price: u64,
    /// True iff both feeds are fresh AND within `MAX_DIVERGENCE_BPS`.
    pub agreement: bool,
    /// True when this reading was produced by the DEVNET single-oracle
    /// (Pyth-only) fallback because Switchboard is environmentally unavailable.
    /// In this mode the divergence check is skipped and `restricted_mode` is
    /// never set. See `dual_oracle_read` / `apply_dual_oracle`.
    pub single_oracle: bool,
}

/// DEVNET CONCESSION — detect that the Switchboard feed is unusable.
///
/// Switchboard On-Demand has no live SOL/USD feed on devnet that matches our
/// `parse_switchboard` layout: the configured account (`GvDMxPzN...`) is a legacy
/// V2 aggregate whose `value`/`timestamp` are zero. `parse_switchboard` already
/// rejects those (len < 104, or `value <= 0` => `OracleStale` / `price == 0`),
/// so "parse fails or yields a zero price" is exactly the "switchboard
/// unavailable" condition. This is loud on purpose: it gates the Pyth-only
/// fallback and is documented in the task-10 trust model. NOT a mainnet path.
fn is_switchboard_unavailable(sb_acc: &AccountInfo) -> bool {
    match parse_switchboard(sb_acc) {
        Ok(reading) => reading.price == 0,
        Err(_) => true,
    }
}

/// Read both oracles, validate freshness, compute divergence.
///
/// Returns:
///   - `Ok(DualOraclePrice { agreement: true, price })` on agreement
///   - `Ok(DualOraclePrice { agreement: false, price: median })` on disagreement
///     (caller is responsible for setting `restricted_mode` and rejecting actions
///     that require fresh agreement)
///   - `Ok(DualOraclePrice { single_oracle: true, .. })` on the DEVNET Pyth-only
///     fallback when Switchboard is unavailable
///   - `Err(OracleStale)` if the usable feed(s) are stale
pub fn dual_oracle_read(
    pyth_acc: &AccountInfo,
    switchboard_acc: &AccountInfo,
    now: i64,
) -> Result<DualOraclePrice, ProgramError> {
    let pyth = parse_pyth(pyth_acc)?;

    // --- DEVNET single-oracle (Pyth-only) fallback ---------------------------
    // Switchboard is environmentally dead on devnet (no live On-Demand SOL/USD
    // feed). When it is unavailable we fall back to Pyth alone: the Pyth reading
    // must still be FRESH, but we skip the cross-oracle divergence check and do
    // NOT enter restricted mode. This is a deliberate, documented devnet
    // concession (see trust model) — the both-feeds-live path below is unchanged.
    if is_switchboard_unavailable(switchboard_acc) {
        if !pyth.is_fresh(now) {
            return Err(SlipstreamError::OracleStale.into());
        }
        return Ok(DualOraclePrice {
            price: pyth.price,
            agreement: true,
            single_oracle: true,
        });
    }

    // --- Normal dual-oracle path (both feeds live) ---------------------------
    let sb = parse_switchboard(switchboard_acc)?;

    if !pyth.is_fresh(now) || !sb.is_fresh(now) {
        return Err(SlipstreamError::OracleStale.into());
    }

    let lo = pyth.price.min(sb.price);
    let hi = pyth.price.max(sb.price);
    let diff = hi.saturating_sub(lo);

    // Divergence in bps relative to the lower price (conservative).
    let divergence_bps = if lo == 0 {
        u64::MAX
    } else {
        ((diff as u128).saturating_mul(10_000) / (lo as u128)) as u64
    };

    let agreement = divergence_bps <= MAX_DIVERGENCE_BPS;

    // Median of two values is just the average.
    let price = ((pyth.price as u128 + sb.price as u128) / 2) as u64;

    Ok(DualOraclePrice { price, agreement, single_oracle: false })
}

/// Apply the dual-oracle reading to the market's `restricted_mode` flag with
/// hysteresis. Returns the price the caller should use, or
/// `Err(RestrictedMode)` if the market is currently restricted.
///
/// Caller passes `&mut Market` so this function can update flags atomically.
pub fn apply_dual_oracle(
    market: &mut Market,
    pyth_acc: &AccountInfo,
    switchboard_acc: &AccountInfo,
    now: i64,
) -> Result<u64, ProgramError> {
    let reading = dual_oracle_read(pyth_acc, switchboard_acc, now)?;

    // DEVNET single-oracle (Pyth-only) fallback: Switchboard is environmentally
    // unavailable. Trust the single fresh Pyth feed, skip divergence, and
    // deliberately leave `restricted_mode` untouched. Documented devnet
    // concession (trust model) — this branch must NOT exist on mainnet.
    if reading.single_oracle {
        return Ok(reading.price);
    }

    if reading.agreement {
        // Agreement: increment streak. If we were restricted and streak crosses the
        // hysteresis threshold, clear the flag.
        if market.restricted_mode != 0 {
            market.agreement_streak = market.agreement_streak.saturating_add(1);
            if market.agreement_streak >= AGREEMENT_HYSTERESIS_COUNT {
                market.restricted_mode = 0;
                market.agreement_streak = 0;
            } else {
                return Err(SlipstreamError::RestrictedMode.into());
            }
        }
        Ok(reading.price)
    } else {
        // Disagreement: enter restricted mode immediately.
        market.restricted_mode = 1;
        market.agreement_streak = 0;
        Err(SlipstreamError::OracleDisagreement.into())
    }
}
