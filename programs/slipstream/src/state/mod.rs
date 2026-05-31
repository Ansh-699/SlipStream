pub mod fill_event;
pub mod fill_log;
pub mod global_state;
pub mod liquidation_intent;
pub mod market;
pub mod order_book;
pub mod order_slot;
pub mod position;
pub mod price_level;
pub mod trading_credit;
pub mod user_account;

pub use fill_event::*;
pub use fill_log::*;
pub use global_state::*;
pub use liquidation_intent::*;
pub use market::*;
pub use order_book::*;
pub use order_slot::*;
pub use position::*;
pub use price_level::*;
pub use trading_credit::*;
pub use user_account::*;

pub const DISC_GLOBAL_STATE: u8 = 1;
pub const DISC_MARKET: u8 = 2;
pub const DISC_USER_ACCOUNT: u8 = 3;
pub const DISC_POSITION: u8 = 4;
pub const DISC_ORDER_BOOK: u8 = 5;
pub const DISC_TRADING_CREDIT: u8 = 6;
pub const DISC_LIQUIDATION_INTENT: u8 = 7;
pub const DISC_FILL_LOG: u8 = 8;

pub const SEED_GLOBAL: &[u8] = b"global";
pub const SEED_MARKET: &[u8] = b"market";
pub const SEED_USER: &[u8] = b"user";
pub const SEED_POSITION: &[u8] = b"position";
pub const SEED_ORDERBOOK: &[u8] = b"orderbook";
pub const SEED_VAULT_AUTHORITY: &[u8] = b"vault_authority";
pub const SEED_CREDIT: &[u8] = b"credit";
pub const SEED_LIQ_INTENT: &[u8] = b"liq_intent";
/// Seed tag for the FillLog PDA: [b"fill_log", market_index_le, epoch_le].
/// Including the epoch lets the keeper rotate to a fresh delegated account
/// (with a fresh sponsored-commit budget) without touching the orderbook.
pub const SEED_FILL_LOG: &[u8] = b"fill_log";

/// Seed tag for the MagicBlock delegation **buffer** PDA. The delegation program
/// derives this buffer as `[b"buffer", delegated_account]` under the OWNER (this)
/// program — see the MagicBlock SDK `delegateBufferPdaFromDelegatedAccountAndOwnerProgram`.
/// It is used to stage the delegated account's data across the owner change.
pub const SEED_DELEGATE_BUFFER: &[u8] = b"buffer";

pub const SENTINEL: u16 = u16::MAX;
