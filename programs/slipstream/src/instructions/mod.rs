pub mod initialize_global;
pub mod initialize_market;
pub mod initialize_user;
pub mod deposit_collateral;
pub mod withdraw_collateral;
pub mod place_order;
pub mod cancel_order;
pub mod settle_trades;
pub mod liquidate_position;
pub mod compute_funding;
pub mod claim_funding;
pub mod close_position;
pub mod delegate_orderbook;
pub mod undelegate_orderbook;
pub mod crank_twap;
pub mod initialize_trading_credit;
pub mod fund_trading_credit;
pub mod withdraw_trading_credit;
pub mod delegate_trading_credit;
pub mod undelegate_trading_credit;
pub mod record_pending_fill;
pub mod close_user_account;
pub mod emergency_undelegate;
pub mod grow_orderbook;
pub mod delegate_orderbook_prepare;
pub mod initialize_position;
pub mod commit_orderbook;
pub mod authorize_session;
pub mod close_trading_credit;
pub mod initialize_fill_log;
pub mod delegate_fill_log;
pub mod mirror_fills;
pub mod commit_fill_log;
pub mod settle_from_log;
pub mod place_trigger;
pub mod cancel_trigger;
pub mod execute_trigger;
pub mod set_market_oracle;
pub mod propose_authority;
pub mod accept_authority;

use pinocchio::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult};

// L1 admin + user lifecycle
pub const IX_INITIALIZE_MARKET: u8 = 0x00;
pub const IX_INITIALIZE_USER: u8 = 0x01;
pub const IX_DEPOSIT_COLLATERAL: u8 = 0x02;
pub const IX_WITHDRAW_COLLATERAL: u8 = 0x03;
pub const IX_SETTLE_TRADES: u8 = 0x04;
pub const IX_LIQUIDATE_POSITION: u8 = 0x05;
pub const IX_COMPUTE_FUNDING: u8 = 0x06;
pub const IX_CLAIM_FUNDING: u8 = 0x07;
pub const IX_CLOSE_POSITION: u8 = 0x08;
pub const IX_DELEGATE_ORDERBOOK: u8 = 0x09;
pub const IX_UNDELEGATE_ORDERBOOK: u8 = 0x0A;
pub const IX_CRANK_TWAP: u8 = 0x0B;
pub const IX_INITIALIZE_GLOBAL: u8 = 0x0C;

// Round 2 (implemented next) — TradingCredit lifecycle + ER-native ordering
pub const IX_INITIALIZE_TRADING_CREDIT: u8 = 0x0D;
pub const IX_FUND_TRADING_CREDIT: u8 = 0x0E;
pub const IX_DELEGATE_TRADING_CREDIT: u8 = 0x0F;
pub const IX_PLACE_ORDER: u8 = 0x10;
pub const IX_CANCEL_ORDER: u8 = 0x11;
pub const IX_UNDELEGATE_TRADING_CREDIT: u8 = 0x12;
pub const IX_WITHDRAW_TRADING_CREDIT: u8 = 0x13;
pub const IX_RECORD_PENDING_FILL: u8 = 0x14;

// Round 3
pub const IX_CLOSE_USER_ACCOUNT: u8 = 0x15;
pub const IX_EMERGENCY_UNDELEGATE: u8 = 0x16;
pub const IX_GROW_ORDERBOOK: u8 = 0x17;
pub const IX_DELEGATE_ORDERBOOK_PREPARE: u8 = 0x18;
pub const IX_INITIALIZE_POSITION: u8 = 0x19;
pub const IX_COMMIT_ORDERBOOK: u8 = 0x1A;

// Round 4 — session keys (one-signature authorize + safe migration close)
pub const IX_AUTHORIZE_SESSION: u8 = 0x1B;
pub const IX_CLOSE_TRADING_CREDIT: u8 = 0x1C;

// Round 5 — small FillLog settlement pipeline (decouples settlement from the
// 612 KB OrderBook so the oversized book is never committed; the small FillLog
// carries its own sponsored-commit budget and is epoch-rotatable).
pub const IX_INITIALIZE_FILL_LOG: u8 = 0x1D;
pub const IX_DELEGATE_FILL_LOG: u8 = 0x1E;
pub const IX_MIRROR_FILLS: u8 = 0x1F;
pub const IX_COMMIT_FILL_LOG: u8 = 0x20;
pub const IX_SETTLE_FROM_LOG: u8 = 0x21;

// Round 6 — keeper-executed SL/TP trigger orders
pub const IX_PLACE_TRIGGER: u8 = 0x22;
pub const IX_CANCEL_TRIGGER: u8 = 0x23;
pub const IX_EXECUTE_TRIGGER: u8 = 0x24;

// Round 7 — admin oracle-feed rotation. Needed because initialize_market was the
// only writer of Market.pyth_feed and the operational feed has since been migrated.
pub const IX_SET_MARKET_ORACLE: u8 = 0x25;

// Round 8 — two-step GlobalState.authority rotation.
pub const IX_PROPOSE_AUTHORITY: u8 = 0x26;
pub const IX_ACCEPT_AUTHORITY: u8 = 0x27;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let (discriminator, data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match *discriminator {
        IX_INITIALIZE_GLOBAL => initialize_global::process(program_id, accounts, data),
        IX_INITIALIZE_MARKET => initialize_market::process(program_id, accounts, data),
        IX_INITIALIZE_USER => initialize_user::process(program_id, accounts, data),
        IX_DEPOSIT_COLLATERAL => deposit_collateral::process(program_id, accounts, data),
        IX_WITHDRAW_COLLATERAL => withdraw_collateral::process(program_id, accounts, data),
        IX_SETTLE_TRADES => settle_trades::process(program_id, accounts, data),
        IX_LIQUIDATE_POSITION => liquidate_position::process(program_id, accounts, data),
        IX_COMPUTE_FUNDING => compute_funding::process(program_id, accounts, data),
        IX_CLAIM_FUNDING => claim_funding::process(program_id, accounts, data),
        IX_CLOSE_POSITION => close_position::process(program_id, accounts, data),
        IX_DELEGATE_ORDERBOOK => delegate_orderbook::process(program_id, accounts, data),
        IX_UNDELEGATE_ORDERBOOK => undelegate_orderbook::process(program_id, accounts, data),
        IX_CRANK_TWAP => crank_twap::process(program_id, accounts, data),
        IX_PLACE_ORDER => place_order::process(program_id, accounts, data),
        IX_CANCEL_ORDER => cancel_order::process(program_id, accounts, data),
        IX_INITIALIZE_TRADING_CREDIT => {
            initialize_trading_credit::process(program_id, accounts, data)
        }
        IX_FUND_TRADING_CREDIT => fund_trading_credit::process(program_id, accounts, data),
        IX_WITHDRAW_TRADING_CREDIT => {
            withdraw_trading_credit::process(program_id, accounts, data)
        }
        IX_DELEGATE_TRADING_CREDIT => {
            delegate_trading_credit::process(program_id, accounts, data)
        }
        IX_UNDELEGATE_TRADING_CREDIT => {
            undelegate_trading_credit::process(program_id, accounts, data)
        }
        IX_RECORD_PENDING_FILL => record_pending_fill::process(program_id, accounts, data),
        IX_CLOSE_USER_ACCOUNT => close_user_account::process(program_id, accounts, data),
        IX_EMERGENCY_UNDELEGATE => emergency_undelegate::process(program_id, accounts, data),
        IX_GROW_ORDERBOOK => grow_orderbook::process(program_id, accounts, data),
        IX_DELEGATE_ORDERBOOK_PREPARE => {
            delegate_orderbook_prepare::process(program_id, accounts, data)
        }
        IX_INITIALIZE_POSITION => initialize_position::process(program_id, accounts, data),
        IX_COMMIT_ORDERBOOK => commit_orderbook::process(program_id, accounts, data),
        IX_AUTHORIZE_SESSION => authorize_session::process(program_id, accounts, data),
        IX_CLOSE_TRADING_CREDIT => {
            close_trading_credit::process(program_id, accounts, data)
        }
        IX_INITIALIZE_FILL_LOG => initialize_fill_log::process(program_id, accounts, data),
        IX_DELEGATE_FILL_LOG => delegate_fill_log::process(program_id, accounts, data),
        IX_MIRROR_FILLS => mirror_fills::process(program_id, accounts, data),
        IX_COMMIT_FILL_LOG => commit_fill_log::process(program_id, accounts, data),
        IX_SETTLE_FROM_LOG => settle_from_log::process(program_id, accounts, data),
        IX_PLACE_TRIGGER => place_trigger::process(program_id, accounts, data),
        IX_CANCEL_TRIGGER => cancel_trigger::process(program_id, accounts, data),
        IX_EXECUTE_TRIGGER => execute_trigger::process(program_id, accounts, data),
        IX_SET_MARKET_ORACLE => set_market_oracle::process(program_id, accounts, data),
        IX_PROPOSE_AUTHORITY => propose_authority::process(program_id, accounts, data),
        IX_ACCEPT_AUTHORITY => accept_authority::process(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Revert if the global `paused` flag is set. Non-trivial trading instructions
/// (place/cancel/settle/liquidate/funding) call this before mutating state.
pub fn ensure_not_globally_paused(global: &crate::state::GlobalState) -> Result<(), ProgramError> {
    if global.paused != 0 {
        return Err(crate::error::SlipstreamError::GlobalPaused.into());
    }
    Ok(())
}
