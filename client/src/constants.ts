import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  "7qujfsb4ZPbQHYVZdqiXq1r8tVAMyyukX94obPqXbVwz"
);

export const DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
);

export const MAGIC_PROGRAM_ID = new PublicKey(
  "Magic11111111111111111111111111111111111111"
);

export const MAGIC_CONTEXT_ID = new PublicKey(
  "MagicContext1111111111111111111111111111111"
);

export const BASE_LAYER_RPC = "https://api.devnet.solana.com";
export const ER_RPC = "https://devnet.magicblock.app";
export const ER_ROUTER = "https://devnet-router.magicblock.app";

export const PYTH_SOL_USD_DEVNET = new PublicKey(
  "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"
);

// Seeds
export const SEED_GLOBAL = Buffer.from("global");
export const SEED_MARKET = Buffer.from("market");
export const SEED_USER = Buffer.from("user");
export const SEED_POSITION = Buffer.from("position");
export const SEED_ORDERBOOK = Buffer.from("orderbook");
export const SEED_VAULT_AUTHORITY = Buffer.from("vault_authority");
export const SEED_CREDIT = Buffer.from("credit");
export const SEED_LIQ_INTENT = Buffer.from("liq_intent");
export const SEED_FILL_LOG = Buffer.from("fill_log");

// MagicBlock delegation PDA seed tags (match the on-chain delegation program +
// @magicblock-labs/ephemeral-rollups-sdk). The delegate buffer is derived under
// the OWNER program (PROGRAM_ID); the record + metadata under DELEGATION_PROGRAM_ID.
export const SEED_DELEGATE_BUFFER = Buffer.from("buffer");
export const SEED_DELEGATION_RECORD = Buffer.from("delegation");
export const SEED_DELEGATION_METADATA = Buffer.from("delegation-metadata");

// Account discriminators
export const DISC_GLOBAL_STATE = 1;
export const DISC_MARKET = 2;
export const DISC_USER_ACCOUNT = 3;
export const DISC_POSITION = 4;
export const DISC_ORDER_BOOK = 5;
export const DISC_TRADING_CREDIT = 6;
export const DISC_LIQUIDATION_INTENT = 7;
export const DISC_FILL_LOG = 8;

// Instruction discriminators
export const IX_INITIALIZE_MARKET = 0x00;
export const IX_INITIALIZE_USER = 0x01;
export const IX_DEPOSIT_COLLATERAL = 0x02;
export const IX_WITHDRAW_COLLATERAL = 0x03;
export const IX_SETTLE_TRADES = 0x04;
export const IX_LIQUIDATE_POSITION = 0x05;
export const IX_COMPUTE_FUNDING = 0x06;
export const IX_CLAIM_FUNDING = 0x07;
export const IX_CLOSE_POSITION = 0x08;
export const IX_DELEGATE_ORDERBOOK = 0x09;
export const IX_UNDELEGATE_ORDERBOOK = 0x0a;
export const IX_CRANK_TWAP = 0x0b;
export const IX_INITIALIZE_GLOBAL = 0x0c;
export const IX_INITIALIZE_TRADING_CREDIT = 0x0d;
export const IX_FUND_TRADING_CREDIT = 0x0e;
export const IX_DELEGATE_TRADING_CREDIT = 0x0f;
export const IX_PLACE_ORDER = 0x10;
export const IX_CANCEL_ORDER = 0x11;
export const IX_UNDELEGATE_TRADING_CREDIT = 0x12;
export const IX_WITHDRAW_TRADING_CREDIT = 0x13;
export const IX_RECORD_PENDING_FILL = 0x14;
export const IX_CLOSE_USER_ACCOUNT = 0x15;
export const IX_EMERGENCY_UNDELEGATE = 0x16;
export const IX_GROW_ORDERBOOK = 0x17;
export const IX_DELEGATE_ORDERBOOK_PREPARE = 0x18;
export const IX_INITIALIZE_POSITION = 0x19;
export const IX_COMMIT_ORDERBOOK = 0x1a;
export const IX_AUTHORIZE_SESSION = 0x1b;
export const IX_CLOSE_TRADING_CREDIT = 0x1c;
export const IX_INITIALIZE_FILL_LOG = 0x1d;
export const IX_DELEGATE_FILL_LOG = 0x1e;
export const IX_MIRROR_FILLS = 0x1f;
export const IX_COMMIT_FILL_LOG = 0x20;
export const IX_SETTLE_FROM_LOG = 0x21;

// Order sides
export const SIDE_BID = 0;
export const SIDE_ASK = 1;

// Order types
export const ORDER_TYPE_LIMIT = 0;
export const ORDER_TYPE_POST_ONLY = 1;
export const ORDER_TYPE_IOC = 2;
export const ORDER_TYPE_FOK = 3;
export const ORDER_TYPE_MARKET = 4;

// Price scale (6 decimals)
export const PRICE_SCALE = 1_000_000;
export const FUNDING_SCALE = BigInt("1000000000000000000"); // 18 decimals

// Layout sizes (must match Rust counterparts)
export const GLOBAL_STATE_SIZE = 104;
export const USER_ACCOUNT_SIZE = 56;
export const POSITION_SIZE = 96;
export const ORDER_BOOK_HEADER_SIZE = 48;
export const ORDER_SLOT_SIZE = 88;
export const PRICE_LEVEL_SIZE = 16;
export const FILL_EVENT_SIZE = 104;
export const TRADING_CREDIT_SIZE = 96;
export const LIQUIDATION_INTENT_SIZE = 64;
export const FILL_LOG_HEADER_SIZE = 24;
export const FILL_LOG_CAPACITY = 80;
