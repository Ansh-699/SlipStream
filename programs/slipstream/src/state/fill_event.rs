use bytemuck::{Pod, Zeroable};

/// Emitted by the ER matching engine for every fill. Consumed by `settle_trades`
/// on L1 to update `Position.collateral`, fees, OI, and insurance fund.
///
/// 104 bytes (was 96). The extra fields `filled_margin` and `taker_fee_bps_snapshot`
/// are snapshots from match time so the settlement path cannot race the market's
/// live parameter values.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct FillEvent {
    pub sequence: u64,
    pub maker: [u8; 32],
    pub taker: [u8; 32],
    pub price: u64,
    pub quantity: u64,
    /// Share of the maker's slot `margin_reserved` that's been drained by this fill.
    /// This is the amount that flows from `TradingCredit.credit` (on ER, already
    /// decremented) into `Position.collateral` (on L1) at settlement.
    pub filled_margin: u64,
    pub taker_fee_bps_snapshot: u16,
    pub maker_rebate_bps_snapshot: u16,
    pub maker_side: u8,
    pub _pad: [u8; 3],
}

impl FillEvent {
    pub const LEN: usize = core::mem::size_of::<Self>();
}
