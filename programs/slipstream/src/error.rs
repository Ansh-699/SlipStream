use pinocchio::program_error::ProgramError;

#[repr(u32)]
pub enum SlipstreamError {
    InvalidDiscriminator = 0x100,
    InvalidAuthority,
    InvalidPda,
    InvalidOracle,
    OracleStale,
    MarketPaused,
    CircuitBreakerTripped,
    InsufficientCollateral,
    InsufficientMargin,
    WithdrawalGateFailed,
    PendingFillsExist,
    ReservedMarginExists,
    SameSlotWithdrawal,
    OrderBookFull,
    PriceLevelsFull,
    InvalidOrderPrice,
    InvalidOrderSize,
    InvalidOrderSide,
    InvalidOrderType,
    OrderNotFound,
    NotOrderOwner,
    PostOnlyWouldCross,
    FokCannotFill,
    SlippageExceeded,
    PositionNotFound,
    PositionNotLiquidatable,
    HealthFactorAboveThreshold,
    InsuranceFundInsufficient,
    InvalidFillSequence,
    FillQueueEmpty,
    FillQueueFull,
    MathOverflow,
    MathUnderflow,
    DivisionByZero,
    InvalidMarketIndex,
    MaxOrdersPerUser,
    InvalidExpiryTimestamp,
    AccountAlreadyInitialized,
    AccountNotInitialized,
    InvalidTokenMint,
    InvalidVault,
    InvalidProgramId,
    // Round 0+: Option B (TradingCredit) errors
    InsufficientCredit,
    CreditStillActive,        // tried to undelegate/close with active orders or committed margin
    TickSizeViolation,
    LotSizeViolation,
    // Round 3: oracle + grace window errors
    OracleDisagreement,
    RestrictedMode,
    InvalidSwitchboardFeed,
    GracePeriodActive,
    LiquidationIntentNotReady,
    GlobalPaused,
    // Round 2: settlement
    FillMarginExceeded,
    // Round 6: SL/TP trigger orders
    TriggerConditionNotMet,
    // Appended at the END so existing `e as u32` codes do not shift.
    SelfTrade,
    PositionStillOpen,
}

impl From<SlipstreamError> for ProgramError {
    fn from(e: SlipstreamError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
