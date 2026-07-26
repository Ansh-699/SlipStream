import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PROGRAM_ID,
  IX_INITIALIZE_GLOBAL,
  IX_INITIALIZE_MARKET,
  IX_INITIALIZE_USER,
  IX_DEPOSIT_COLLATERAL,
  IX_WITHDRAW_COLLATERAL,
  IX_SETTLE_TRADES,
  IX_LIQUIDATE_POSITION,
  IX_COMPUTE_FUNDING,
  IX_CLAIM_FUNDING,
  IX_CLOSE_POSITION,
  IX_DELEGATE_ORDERBOOK,
  IX_UNDELEGATE_ORDERBOOK,
  IX_CRANK_TWAP,
  IX_PLACE_ORDER,
  IX_CANCEL_ORDER,
  IX_INITIALIZE_TRADING_CREDIT,
  IX_FUND_TRADING_CREDIT,
  IX_WITHDRAW_TRADING_CREDIT,
  IX_DELEGATE_TRADING_CREDIT,
  IX_UNDELEGATE_TRADING_CREDIT,
  IX_RECORD_PENDING_FILL,
  IX_CLOSE_USER_ACCOUNT,
  IX_EMERGENCY_UNDELEGATE,
  IX_GROW_ORDERBOOK,
  IX_DELEGATE_ORDERBOOK_PREPARE,
  IX_INITIALIZE_POSITION,
  IX_COMMIT_ORDERBOOK,
  IX_AUTHORIZE_SESSION,
  IX_CLOSE_TRADING_CREDIT,
  IX_INITIALIZE_FILL_LOG,
  IX_DELEGATE_FILL_LOG,
  IX_MIRROR_FILLS,
  IX_COMMIT_FILL_LOG,
  IX_SETTLE_FROM_LOG,
  IX_PLACE_TRIGGER,
  IX_CANCEL_TRIGGER,
  IX_EXECUTE_TRIGGER,
  DELEGATION_PROGRAM_ID,
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
} from "./constants";
import {
  findGlobalStatePda,
  findMarketPda,
  findUserAccountPda,
  findPositionPda,
  findOrderBookPda,
  findVaultAuthorityPda,
  findTradingCreditPda,
  findLiquidationIntentPda,
  findFillLogPda,
  findTriggerPda,
  findDelegateBufferPda,
  findDelegationRecordPda,
  findDelegationMetadataPda,
} from "./pda";

function writeU16LE(buf: Buffer, value: number, offset: number): void {
  buf.writeUInt16LE(value, offset);
}

function writeU64LE(buf: Buffer, value: bigint, offset: number): void {
  buf.writeBigUInt64LE(value, offset);
}

function writeI64LE(buf: Buffer, value: bigint, offset: number): void {
  buf.writeBigInt64LE(value, offset);
}

// ---- Initialize Global (admin-once bootstrap) ----

export function createInitializeGlobalInstruction(
  authority: PublicKey,
  treasury: PublicKey,
  insuranceVault: PublicKey,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [globalState] = findGlobalStatePda(programId);

  // 1 (disc) + 32 + 32 = 65 bytes
  const data = Buffer.alloc(65);
  data[0] = IX_INITIALIZE_GLOBAL;
  treasury.toBuffer().copy(data, 1);
  insuranceVault.toBuffer().copy(data, 33);

  return new TransactionInstruction({
    keys: [
      { pubkey: globalState, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- Initialize Market ----

export interface InitializeMarketParams {
  marketIndex: number;
  tickSize: bigint;
  lotSize: bigint;
  maxLeverage: number;
  takerFeeBps: number;
  makerRebateBps: number;
  fundingInterval: bigint;
  maxOrderSlots?: number;
  maxPriceLevels?: number;
  maxFillEvents?: number;
}

export function createInitializeMarketInstruction(
  authority: PublicKey,
  quoteVault: PublicKey,
  pythFeed: PublicKey,
  switchboardFeed: PublicKey,
  params: InitializeMarketParams,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [globalState] = findGlobalStatePda(programId);
  const [market] = findMarketPda(params.marketIndex, programId);
  const [orderBook] = findOrderBookPda(params.marketIndex, programId);

  // 1 (disc) + 2+8+8+1+2+2+8+2+2+2 = 38 bytes
  const data = Buffer.alloc(38);
  data[0] = IX_INITIALIZE_MARKET;
  writeU16LE(data, params.marketIndex, 1);
  writeU64LE(data, params.tickSize, 3);
  writeU64LE(data, params.lotSize, 11);
  data[19] = params.maxLeverage;
  writeU16LE(data, params.takerFeeBps, 20);
  writeU16LE(data, params.makerRebateBps, 22);
  writeU64LE(data, params.fundingInterval, 24);
  writeU16LE(data, params.maxOrderSlots ?? 0, 32);
  writeU16LE(data, params.maxPriceLevels ?? 0, 34);
  writeU16LE(data, params.maxFillEvents ?? 0, 36);

  return new TransactionInstruction({
    keys: [
      { pubkey: globalState, isSigner: false, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: orderBook, isSigner: false, isWritable: true },
      { pubkey: quoteVault, isSigner: false, isWritable: true },
      { pubkey: pythFeed, isSigner: false, isWritable: false },
      { pubkey: switchboardFeed, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- Grow Orderbook ----

/**
 * Grow the OrderBook PDA toward its full target size by one CPI-cap-sized chunk
 * (<= 10,240 bytes) per call. `initialize_market` pre-funds the full rent but
 * only allocates an initial chunk because Solana caps account-data growth inside
 * a CPI; this instruction resizes the account upward until it reaches the full
 * size, then initializes the free list. Idempotent: a no-op once fully grown.
 *
 * Must run BEFORE delegating the orderbook (once the delegation program owns the
 * account it can no longer be resized).
 *
 * Accounts:
 *   [0] order_book   (writable)
 *   [1] global_state (read)
 *   [2] authority    (signer) — must equal GlobalState.authority
 */
export function createGrowOrderbookInstruction(
  authority: PublicKey,
  marketIndex: number,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [globalState] = findGlobalStatePda(programId);
  const [orderBook] = findOrderBookPda(marketIndex, programId);

  // disc(1) + market_index(2) = 3 bytes
  const data = Buffer.alloc(3);
  data[0] = IX_GROW_ORDERBOOK;
  writeU16LE(data, marketIndex, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: orderBook, isSigner: false, isWritable: true },
      { pubkey: globalState, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: true },
    ],
    programId,
    data,
  });
}

// ---- Initialize User ----

export function createInitializeUserInstruction(
  owner: PublicKey,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [userAccount] = findUserAccountPda(owner, programId);

  const data = Buffer.alloc(1);
  data[0] = IX_INITIALIZE_USER;

  return new TransactionInstruction({
    keys: [
      { pubkey: userAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- Initialize Position ----

/**
 * initialize_position (disc 0x19): allocate an empty Position PDA for `owner`
 * in the given market so settle_trades can open into it. Nothing else in the
 * program creates a Position. Numeric fields are left zero so the first settled
 * fill opens the position.
 *
 * Accounts:
 *   [0] position       (writable, PDA)
 *   [1] owner          (signer, payer, writable)
 *   [2] system_program
 */
export function createInitializePositionInstruction(
  owner: PublicKey,
  marketIndex: number,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [position] = findPositionPda(owner, marketIndex, programId);
  const data = Buffer.alloc(3);
  data[0] = IX_INITIALIZE_POSITION;
  writeU16LE(data, marketIndex, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- Deposit Collateral ----
export function createDepositCollateralInstruction(
  owner: PublicKey,
  userTokenAccount: PublicKey,
  quoteVault: PublicKey,
  amount: bigint,
  programId: PublicKey = PROGRAM_ID,
  marketIndex = 0
): TransactionInstruction {
  const [userAccount] = findUserAccountPda(owner, programId);
  // The program pins quoteVault to market.quote_vault, so the market must be passed.
  const [market] = findMarketPda(marketIndex, programId);

  const data = Buffer.alloc(9);
  data[0] = IX_DEPOSIT_COLLATERAL;
  writeU64LE(data, amount, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: userAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: quoteVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- Withdraw Collateral (optional open-position check for same-slot guard) ----

export interface WithdrawCollateralParams {
  owner: PublicKey;
  userTokenAccount: PublicKey;
  quoteVault: PublicKey;
  amount: bigint;
  /** Optional: any open Position accounts for this owner to check same-slot guard. */
  positions?: PublicKey[];
}

export function createWithdrawCollateralInstruction(
  params: WithdrawCollateralParams,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [userAccount] = findUserAccountPda(params.owner, programId);
  const [vaultAuthority] = findVaultAuthorityPda(programId);

  const data = Buffer.alloc(9);
  data[0] = IX_WITHDRAW_COLLATERAL;
  writeU64LE(data, params.amount, 1);

  const keys = [
    { pubkey: userAccount, isSigner: false, isWritable: true },
    { pubkey: params.owner, isSigner: true, isWritable: false },
    { pubkey: params.quoteVault, isSigner: false, isWritable: true },
    { pubkey: params.userTokenAccount, isSigner: false, isWritable: true },
    { pubkey: vaultAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  if (params.positions) {
    for (const pos of params.positions) {
      keys.push({ pubkey: pos, isSigner: false, isWritable: false });
    }
  }

  return new TransactionInstruction({ keys, programId, data });
}

// ---- Place Order (ER-native; uses TradingCredit, not UserAccount) ----

export interface PlaceOrderParams {
  side: number; // 0=bid, 1=ask
  orderType: number; // 0=limit, 1=post_only, 2=ioc, 3=fok, 4=market
  price: bigint;
  size: bigint;
  expiryTs?: bigint;
  /** Only enforced for MARKET orders. 0 = disabled. */
  maxSlippageBps?: number;
  /** When true, marks the order as position-reducing (a close/flatten): the
   *  program skips the upfront margin gate, charges the taker zero new credit,
   *  and never rests a remainder. Used by the Close button. */
  reduceOnly?: boolean;
}

export function createPlaceOrderInstruction(
  owner: PublicKey,
  marketIndex: number,
  params: PlaceOrderParams,
  programId: PublicKey = PROGRAM_ID,
  signer: PublicKey = owner
): TransactionInstruction {
  const [market] = findMarketPda(marketIndex, programId);
  const [orderBook] = findOrderBookPda(marketIndex, programId);
  // NOTE: the trading_credit PDA always derives from the OWNER, never the
  // session signer — the session key is only an authorized SIGNER (account [3]).
  const [tradingCredit] = findTradingCreditPda(owner, marketIndex, programId);

  // disc(1)+side(1)+type(1)+price(8)+size(8)+expiry(8)+slippage(2)+reduce_only(1) = 30
  const data = Buffer.alloc(30);
  data[0] = IX_PLACE_ORDER;
  data[1] = params.side;
  data[2] = params.orderType;
  writeU64LE(data, params.price, 3);
  writeU64LE(data, params.size, 11);
  writeI64LE(data, params.expiryTs ?? 0n, 19);
  writeU16LE(data, params.maxSlippageBps ?? 0, 27);
  data[29] = params.reduceOnly ? 1 : 0;

  return new TransactionInstruction({
    keys: [
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: orderBook, isSigner: false, isWritable: true },
      { pubkey: tradingCredit, isSigner: false, isWritable: true },
      // [3] signer: owner OR an authorized, non-expired session key.
      { pubkey: signer, isSigner: true, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- Cancel Order (ER-native) ----

export function createCancelOrderInstruction(
  owner: PublicKey,
  marketIndex: number,
  orderId: bigint,
  programId: PublicKey = PROGRAM_ID,
  signer: PublicKey = owner
): TransactionInstruction {
  const [orderBook] = findOrderBookPda(marketIndex, programId);
  // The trading_credit PDA derives from the OWNER; the session key only signs.
  const [tradingCredit] = findTradingCreditPda(owner, marketIndex, programId);

  // disc(1) + order_id(8) = 9
  const data = Buffer.alloc(9);
  data[0] = IX_CANCEL_ORDER;
  writeU64LE(data, orderId, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: orderBook, isSigner: false, isWritable: true },
      { pubkey: tradingCredit, isSigner: false, isWritable: true },
      // [2] signer: owner OR an authorized, non-expired session key.
      { pubkey: signer, isSigner: true, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- TradingCredit lifecycle ----

export function createInitializeTradingCreditInstruction(
  owner: PublicKey,
  marketIndex: number,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [tradingCredit] = findTradingCreditPda(owner, marketIndex, programId);
  const data = Buffer.alloc(3);
  data[0] = IX_INITIALIZE_TRADING_CREDIT;
  writeU16LE(data, marketIndex, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: tradingCredit, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

export function createFundTradingCreditInstruction(
  owner: PublicKey,
  marketIndex: number,
  amount: bigint,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [userAccount] = findUserAccountPda(owner, programId);
  const [tradingCredit] = findTradingCreditPda(owner, marketIndex, programId);
  const data = Buffer.alloc(9);
  data[0] = IX_FUND_TRADING_CREDIT;
  writeU64LE(data, amount, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: userAccount, isSigner: false, isWritable: true },
      { pubkey: tradingCredit, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId,
    data,
  });
}

export function createWithdrawTradingCreditInstruction(
  owner: PublicKey,
  marketIndex: number,
  amount: bigint,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [userAccount] = findUserAccountPda(owner, programId);
  const [tradingCredit] = findTradingCreditPda(owner, marketIndex, programId);
  const data = Buffer.alloc(9);
  data[0] = IX_WITHDRAW_TRADING_CREDIT;
  writeU64LE(data, amount, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: userAccount, isSigner: false, isWritable: true },
      { pubkey: tradingCredit, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * Finalize delegation of a user's TradingCredit PDA to the MagicBlock ER.
 *
 * The TradingCredit is tiny (96 bytes), so — unlike the OrderBook — the delegate
 * buffer is created and consumed inline by the on-chain instruction in a single
 * CPI (no separate prepare step). The account layout MUST match
 * delegate_trading_credit::process (9 accounts) and the MagicBlock delegate ABI.
 *
 * This builder ALSO carries an optional SESSION authority + expiry in its data
 * (disc + session_authority[32] + session_expiry i64), so "delegate + authorize
 * the browser session key" is ONE signature / one transaction. Pass
 * `sessionAuthority = null` to delegate with no session.
 *   [0] payer (signer, writable)        — = owner; funds the buffer rent
 *   [1] trading_credit (writable)       — the delegated PDA (program signs)
 *   [2] owner (signer)                  — credit owner; authority gate
 *   [3] owner_program (read)            — PROGRAM_ID itself (delegation reads it)
 *   [4] delegate_buffer (writable)      — [b"buffer", trading_credit] under PROGRAM_ID
 *   [5] delegation_record (writable)    — [b"delegation", trading_credit] under DELEGATION_PROGRAM_ID
 *   [6] delegation_metadata (writable)  — [b"delegation-metadata", trading_credit] under DELEGATION_PROGRAM_ID
 *   [7] delegation_program (read)
 *   [8] system_program (read)
 */
export function createDelegateTradingCreditInstruction(
  owner: PublicKey,
  marketIndex: number,
  sessionAuthority: PublicKey | null = null,
  sessionExpiry: bigint = 0n,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [tradingCredit] = findTradingCreditPda(owner, marketIndex, programId);
  const [delegateBuffer] = findDelegateBufferPda(tradingCredit, programId);
  const [delegationRecord] = findDelegationRecordPda(tradingCredit);
  const [delegationMetadata] = findDelegationMetadataPda(tradingCredit);

  // data = disc(1) + session_authority(32) + session_expiry i64(8) = 41 bytes.
  // When no session is requested the authority is left all-zero and the expiry 0,
  // so the on-chain handler records "no session" (and stays backward compatible).
  const data = Buffer.alloc(41);
  data[0] = IX_DELEGATE_TRADING_CREDIT;
  (sessionAuthority ?? PublicKey.default).toBuffer().copy(data, 1);
  writeI64LE(data, sessionExpiry, 33);

  return new TransactionInstruction({
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true }, // payer
      { pubkey: tradingCredit, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false }, // owner (signer)
      { pubkey: programId, isSigner: false, isWritable: false }, // owner_program
      { pubkey: delegateBuffer, isSigner: false, isWritable: true },
      { pubkey: delegationRecord, isSigner: false, isWritable: true },
      { pubkey: delegationMetadata, isSigner: false, isWritable: true },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * authorize_session (0x1B) — owner-signed set/rotate/clear of the SESSION
 * authority on a TradingCredit WITHOUT re-delegating. Run on whichever layer
 * owns the credit (base for non-delegated, ER for delegated). Pass
 * `sessionAuthority = null` (all-zero) to CLEAR the session.
 *
 * Accounts:
 *   [0] trading_credit (writable)
 *   [1] owner (signer)
 * Data: disc(1) + session_authority(32) + session_expiry i64(8) = 41 bytes
 */
export function createAuthorizeSessionInstruction(
  owner: PublicKey,
  marketIndex: number,
  sessionAuthority: PublicKey | null,
  sessionExpiry: bigint,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [tradingCredit] = findTradingCreditPda(owner, marketIndex, programId);
  const data = Buffer.alloc(41);
  data[0] = IX_AUTHORIZE_SESSION;
  (sessionAuthority ?? PublicKey.default).toBuffer().copy(data, 1);
  writeI64LE(data, sessionExpiry, 33);

  return new TransactionInstruction({
    keys: [
      { pubkey: tradingCredit, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * close_trading_credit (0x1C) — safe owner-signed close of a NON-delegated,
 * zero-committed TradingCredit, refunding rent to the owner. Used to migrate a
 * legacy-size credit before re-initializing at the new layout. Refuses to act
 * on a delegated credit (it would not be program-owned).
 *
 * Accounts:
 *   [0] trading_credit (writable)
 *   [1] owner (signer, writable) — receives rent refund
 */
export function createCloseTradingCreditInstruction(
  owner: PublicKey,
  marketIndex: number,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [tradingCredit] = findTradingCreditPda(owner, marketIndex, programId);
  const data = Buffer.alloc(1);
  data[0] = IX_CLOSE_TRADING_CREDIT;

  return new TransactionInstruction({
    keys: [
      { pubkey: tradingCredit, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
    ],
    programId,
    data,
  });
}

export function createUndelegateTradingCreditInstruction(
  owner: PublicKey,
  marketIndex: number,
  magicContext: PublicKey,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [tradingCredit] = findTradingCreditPda(owner, marketIndex, programId);
  const data = Buffer.alloc(3);
  data[0] = IX_UNDELEGATE_TRADING_CREDIT;
  writeU16LE(data, marketIndex, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true }, // payer
      { pubkey: tradingCredit, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false }, // owner
      { pubkey: magicContext, isSigner: false, isWritable: false },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- Record Pending Fill (keeper; permissionless) ----

export function createRecordPendingFillInstruction(
  userAccounts: PublicKey[],
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const data = Buffer.alloc(3);
  data[0] = IX_RECORD_PENDING_FILL;
  writeU16LE(data, userAccounts.length, 1);

  return new TransactionInstruction({
    keys: userAccounts.map((pk) => ({
      pubkey: pk,
      isSigner: false,
      isWritable: true,
    })),
    programId,
    data,
  });
}

// ---- Settle Trades (keeper) ----

export function createSettleTradesInstruction(
  marketIndex: number,
  numFills: number,
  remainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [market] = findMarketPda(marketIndex, programId);
  const [orderBook] = findOrderBookPda(marketIndex, programId);

  const data = Buffer.alloc(3);
  data[0] = IX_SETTLE_TRADES;
  writeU16LE(data, numFills, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: orderBook, isSigner: false, isWritable: true },
      ...remainingAccounts,
    ],
    programId,
    data,
  });
}

// ---- Liquidate Position (dual-oracle + grace window) ----

export function createLiquidatePositionInstruction(
  liquidator: PublicKey,
  positionOwner: PublicKey,
  marketIndex: number,
  pythFeed: PublicKey,
  switchboardFeed: PublicKey,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [market] = findMarketPda(marketIndex, programId);
  const [position] = findPositionPda(positionOwner, marketIndex, programId);
  const [userAccount] = findUserAccountPda(positionOwner, programId);
  const [liquidationIntent] = findLiquidationIntentPda(position, programId);

  // No instruction data — oracle prices come from accounts
  const data = Buffer.alloc(1);
  data[0] = IX_LIQUIDATE_POSITION;

  return new TransactionInstruction({
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: userAccount, isSigner: false, isWritable: true },
      { pubkey: pythFeed, isSigner: false, isWritable: false },
      { pubkey: switchboardFeed, isSigner: false, isWritable: false },
      { pubkey: liquidationIntent, isSigner: false, isWritable: true },
      { pubkey: liquidator, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- Compute Funding (dual-oracle) ----

export function createComputeFundingInstruction(
  marketIndex: number,
  pythFeed: PublicKey,
  switchboardFeed: PublicKey,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [market] = findMarketPda(marketIndex, programId);

  const data = Buffer.alloc(1);
  data[0] = IX_COMPUTE_FUNDING;

  return new TransactionInstruction({
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: pythFeed, isSigner: false, isWritable: false },
      { pubkey: switchboardFeed, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- Claim Funding ----

export function createClaimFundingInstruction(
  owner: PublicKey,
  marketIndex: number,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [market] = findMarketPda(marketIndex, programId);
  const [position] = findPositionPda(owner, marketIndex, programId);
  const [userAccount] = findUserAccountPda(owner, programId);

  const data = Buffer.alloc(1);
  data[0] = IX_CLAIM_FUNDING;

  return new TransactionInstruction({
    keys: [
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: userAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- Close Position ----

/**
 * Close a settled L1 position at the mark price.
 *
 * Optional `opts` appends `close_size: u64` (base atoms; 0 = full close) and
 * `limit_price: u64` (slippage bound on the settle price; 0 = unbounded —
 * closing a long requires mark >= limit, closing a short requires mark <= limit).
 * Omitting `opts` keeps the original 1-byte wire format (full close, no bound).
 */
export function createClosePositionInstruction(
  owner: PublicKey,
  marketIndex: number,
  programId: PublicKey = PROGRAM_ID,
  opts?: { closeSize?: bigint; limitPrice?: bigint }
): TransactionInstruction {
  const [market] = findMarketPda(marketIndex, programId);
  const [position] = findPositionPda(owner, marketIndex, programId);
  const [userAccount] = findUserAccountPda(owner, programId);

  let data: Buffer;
  if (opts && (opts.closeSize !== undefined || opts.limitPrice !== undefined)) {
    data = Buffer.alloc(17);
    data[0] = IX_CLOSE_POSITION;
    data.writeBigUInt64LE(opts.closeSize ?? 0n, 1);
    data.writeBigUInt64LE(opts.limitPrice ?? 0n, 9);
  } else {
    data = Buffer.alloc(1);
    data[0] = IX_CLOSE_POSITION;
  }

  return new TransactionInstruction({
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: userAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- SL/TP trigger orders ----

/**
 * place_trigger (0x22): create or replace the owner's SL/TP trigger for a
 * market. `triggerAbove` = true fires when mark >= price (e.g. long TP /
 * short SL), false when mark <= price (long SL / short TP).
 */
export function createPlaceTriggerInstruction(
  owner: PublicKey,
  marketIndex: number,
  kind: number,
  triggerAbove: boolean,
  triggerPrice: bigint,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [trigger] = findTriggerPda(owner, marketIndex, kind, programId);
  const [position] = findPositionPda(owner, marketIndex, programId);

  const data = Buffer.alloc(13);
  data[0] = IX_PLACE_TRIGGER;
  data.writeUInt16LE(marketIndex, 1);
  data[3] = kind;
  data[4] = triggerAbove ? 1 : 0;
  data.writeBigUInt64LE(triggerPrice, 5);

  return new TransactionInstruction({
    keys: [
      { pubkey: trigger, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/** cancel_trigger (0x23): owner removes a trigger; rent returns to the owner. */
export function createCancelTriggerInstruction(
  owner: PublicKey,
  marketIndex: number,
  kind: number,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [trigger] = findTriggerPda(owner, marketIndex, kind, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: trigger, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
    ],
    programId,
    data: Buffer.from([IX_CANCEL_TRIGGER]),
  });
}

/**
 * execute_trigger (0x24): permissionless SL/TP execution once the mark price
 * satisfies the trigger; the trigger account's rent pays the executor.
 */
export function createExecuteTriggerInstruction(
  owner: PublicKey,
  marketIndex: number,
  kind: number,
  executor: PublicKey,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [market] = findMarketPda(marketIndex, programId);
  const [position] = findPositionPda(owner, marketIndex, programId);
  const [userAccount] = findUserAccountPda(owner, programId);
  const [trigger] = findTriggerPda(owner, marketIndex, kind, programId);

  return new TransactionInstruction({
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: userAccount, isSigner: false, isWritable: true },
      { pubkey: trigger, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: executor, isSigner: true, isWritable: true },
    ],
    programId,
    data: Buffer.from([IX_EXECUTE_TRIGGER]),
  });
}

// ---- Delegate Orderbook ----

/**
 * Stage one chunk of the OrderBook's data into the MagicBlock delegate buffer PDA.
 *
 * The OrderBook is ~612 KB and the MagicBlock delegation flow requires a same-size
 * "buffer" PDA holding a copy of the account data across the owner change. Solana
 * caps account-data growth at 10,240 bytes inside a CPI (the same limit that forces
 * `grow_orderbook`), so the buffer cannot be created full-size in one instruction.
 * This builder issues `delegate_orderbook_prepare`, which creates/grows the buffer by
 * up to one 10,240-byte chunk per call and copies the matching OrderBook prefix into
 * it. Call repeatedly (see `scripts/deploy.ts`) until the buffer equals the OrderBook
 * size, then call `createDelegateOrderbookInstruction` to finalize.
 *
 * Accounts MUST match `delegate_orderbook_prepare::process`:
 *   [0] payer (signer, writable) — must equal GlobalState.authority
 *   [1] order_book (read)
 *   [2] delegate_buffer (writable) — [b"buffer", order_book] under PROGRAM_ID
 *   [3] global_state (read)
 *   [4] system_program (read)
 */
export function createDelegateOrderbookPrepareInstruction(
  authority: PublicKey,
  marketIndex: number,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [globalState] = findGlobalStatePda(programId);
  const [orderBook] = findOrderBookPda(marketIndex, programId);
  const [delegateBuffer] = findDelegateBufferPda(orderBook, programId);

  const data = Buffer.alloc(3);
  data[0] = IX_DELEGATE_ORDERBOOK_PREPARE;
  writeU16LE(data, marketIndex, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: orderBook, isSigner: false, isWritable: false },
      { pubkey: delegateBuffer, isSigner: false, isWritable: true },
      { pubkey: globalState, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * Finalize delegation of the OrderBook to the MagicBlock ER. Requires the delegate
 * buffer PDA to have been fully staged via `createDelegateOrderbookPrepareInstruction`.
 *
 * Account layout MUST match delegate_orderbook::process (9 accounts):
 *   [0] payer (signer, writable) — must equal GlobalState.authority
 *   [1] order_book (writable)    — the delegated PDA (program signs via invoke_signed)
 *   [2] global_state (read)      — authority gate
 *   [3] owner_program (read)     — PROGRAM_ID itself (delegation reads it)
 *   [4] delegate_buffer (writable)     — [b"buffer", order_book] under PROGRAM_ID
 *   [5] delegation_record (writable)   — [b"delegation", order_book] under DELEGATION_PROGRAM_ID
 *   [6] delegation_metadata (writable) — [b"delegation-metadata", order_book] under DELEGATION_PROGRAM_ID
 *   [7] delegation_program (read)
 *   [8] system_program (read)
 */
export function createDelegateOrderbookInstruction(
  authority: PublicKey,
  marketIndex: number,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [globalState] = findGlobalStatePda(programId);
  const [orderBook] = findOrderBookPda(marketIndex, programId);
  const [delegateBuffer] = findDelegateBufferPda(orderBook, programId);
  const [delegationRecord] = findDelegationRecordPda(orderBook);
  const [delegationMetadata] = findDelegationMetadataPda(orderBook);

  const data = Buffer.alloc(3);
  data[0] = IX_DELEGATE_ORDERBOOK;
  writeU16LE(data, marketIndex, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: orderBook, isSigner: false, isWritable: true },
      { pubkey: globalState, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: delegateBuffer, isSigner: false, isWritable: true },
      { pubkey: delegationRecord, isSigner: false, isWritable: true },
      { pubkey: delegationMetadata, isSigner: false, isWritable: true },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- Undelegate Orderbook ----

export function createUndelegateOrderbookInstruction(
  authority: PublicKey,
  marketIndex: number,
  magicContext: PublicKey,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [globalState] = findGlobalStatePda(programId);
  const [orderBook] = findOrderBookPda(marketIndex, programId);

  const data = Buffer.alloc(3);
  data[0] = IX_UNDELEGATE_ORDERBOOK;
  writeU16LE(data, marketIndex, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: orderBook, isSigner: false, isWritable: true },
      { pubkey: globalState, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: magicContext, isSigner: false, isWritable: false },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- Commit Orderbook (ER -> L1, keep delegated) ----

/**
 * Schedule a commit of the (still-delegated) OrderBook's ER state back to L1
 * WITHOUT undelegating. Run this ON THE ER. The on-chain commit_orderbook (0x1A)
 * CPIs the magic program's ScheduleCommit so the owner program is resolved from
 * the call stack — the SDK's top-level createCommitInstruction fails on the ER
 * with "failed to find parent program id".
 *
 * Accounts MUST match commit_orderbook::process:
 *   [0] payer (signer, writable)
 *   [1] order_book (writable)
 *   [2] magic_context (writable) — MagicContext111…
 *   [3] magic_program (read)     — Magic111…
 */
export function createCommitOrderbookInstruction(
  payer: PublicKey,
  marketIndex: number,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [orderBook] = findOrderBookPda(marketIndex, programId);

  const data = Buffer.alloc(3);
  data[0] = IX_COMMIT_ORDERBOOK;
  writeU16LE(data, marketIndex, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: orderBook, isSigner: false, isWritable: true },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- Crank TWAP ----
export function createCrankTwapInstruction(
  marketIndex: number,
  pythFeed: PublicKey,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [market] = findMarketPda(marketIndex, programId);

  const data = Buffer.alloc(1);
  data[0] = IX_CRANK_TWAP;

  return new TransactionInstruction({
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: pythFeed, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- Close User Account ----

export function createCloseUserAccountInstruction(
  owner: PublicKey,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [userAccount] = findUserAccountPda(owner, programId);
  const data = Buffer.alloc(1);
  data[0] = IX_CLOSE_USER_ACCOUNT;
  return new TransactionInstruction({
    keys: [
      { pubkey: userAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
    ],
    programId,
    data,
  });
}

// ---- Emergency Undelegate (authority-gated) ----

export function createEmergencyUndelegateInstruction(
  authority: PublicKey,
  marketIndex: number,
  magicContext: PublicKey,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [globalState] = findGlobalStatePda(programId);
  const [orderBook] = findOrderBookPda(marketIndex, programId);
  const data = Buffer.alloc(3);
  data[0] = IX_EMERGENCY_UNDELEGATE;
  data.writeUInt16LE(marketIndex, 1);
  return new TransactionInstruction({
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true }, // payer
      { pubkey: orderBook, isSigner: false, isWritable: true },
      { pubkey: globalState, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false }, // authority signer
      { pubkey: magicContext, isSigner: false, isWritable: false },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// ---- FillLog settlement pipeline (small, epoch-rotatable settlement source) ----

/**
 * initialize_fill_log (0x1D): create the small FillLog PDA for a market+epoch.
 * Accounts: [0] global_state (r), [1] fill_log (w, PDA), [2] authority (signer, payer, w),
 *           [3] system_program (r).
 * Data: market_index u16, epoch u32.
 */
export function createInitializeFillLogInstruction(
  authority: PublicKey,
  marketIndex: number,
  epoch: number,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [globalState] = findGlobalStatePda(programId);
  const [fillLog] = findFillLogPda(marketIndex, epoch, programId);

  const data = Buffer.alloc(7);
  data[0] = IX_INITIALIZE_FILL_LOG;
  writeU16LE(data, marketIndex, 1);
  data.writeUInt32LE(epoch, 3);

  return new TransactionInstruction({
    keys: [
      { pubkey: globalState, isSigner: false, isWritable: false },
      { pubkey: fillLog, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * delegate_fill_log (0x1E): delegate the FillLog PDA to the ER (small-account
 * single-CPI buffer flow). Account layout MUST match delegate_fill_log::process.
 * Data: market_index u16, epoch u32.
 */
export function createDelegateFillLogInstruction(
  authority: PublicKey,
  marketIndex: number,
  epoch: number,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [globalState] = findGlobalStatePda(programId);
  const [fillLog] = findFillLogPda(marketIndex, epoch, programId);
  const [delegateBuffer] = findDelegateBufferPda(fillLog, programId);
  const [delegationRecord] = findDelegationRecordPda(fillLog);
  const [delegationMetadata] = findDelegationMetadataPda(fillLog);

  const data = Buffer.alloc(7);
  data[0] = IX_DELEGATE_FILL_LOG;
  writeU16LE(data, marketIndex, 1);
  data.writeUInt32LE(epoch, 3);

  return new TransactionInstruction({
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: fillLog, isSigner: false, isWritable: true },
      { pubkey: globalState, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: delegateBuffer, isSigner: false, isWritable: true },
      { pubkey: delegationRecord, isSigner: false, isWritable: true },
      { pubkey: delegationMetadata, isSigner: false, isWritable: true },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * mirror_fills (0x1F): copy new OrderBook fills into the FillLog. Runs ON THE ER
 * (both accounts delegated). Permissionless.
 * Accounts: [0] order_book (r), [1] fill_log (w).
 * Data: market_index u16, epoch u32, max_fills u16 (0 = no cap).
 */
export function createMirrorFillsInstruction(
  marketIndex: number,
  epoch: number,
  maxFills: number,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [orderBook] = findOrderBookPda(marketIndex, programId);
  const [fillLog] = findFillLogPda(marketIndex, epoch, programId);

  const data = Buffer.alloc(9);
  data[0] = IX_MIRROR_FILLS;
  writeU16LE(data, marketIndex, 1);
  data.writeUInt32LE(epoch, 3);
  writeU16LE(data, maxFills, 7);

  return new TransactionInstruction({
    keys: [
      { pubkey: orderBook, isSigner: false, isWritable: false },
      { pubkey: fillLog, isSigner: false, isWritable: true },
    ],
    programId,
    data,
  });
}

/**
 * commit_fill_log (0x20): schedule a commit of the (still-delegated) FillLog to
 * L1. Run ON THE ER. Accounts MUST match commit_fill_log::process.
 * Data: market_index u16, epoch u32.
 */
export function createCommitFillLogInstruction(
  payer: PublicKey,
  marketIndex: number,
  epoch: number,
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [fillLog] = findFillLogPda(marketIndex, epoch, programId);

  const data = Buffer.alloc(7);
  data[0] = IX_COMMIT_FILL_LOG;
  writeU16LE(data, marketIndex, 1);
  data.writeUInt32LE(epoch, 3);

  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: fillLog, isSigner: false, isWritable: true },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * settle_from_log (0x21): settle fills onto L1 by reading the committed FillLog
 * (read-only) instead of the 612 KB OrderBook.
 * Accounts: [0] market (w), [1] fill_log (r), [2..] user + position accounts.
 * Data: market_index u16, epoch u32, num_fills u16.
 */
export function createSettleFromLogInstruction(
  marketIndex: number,
  epoch: number,
  numFills: number,
  remainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
  programId: PublicKey = PROGRAM_ID
): TransactionInstruction {
  const [market] = findMarketPda(marketIndex, programId);
  const [fillLog] = findFillLogPda(marketIndex, epoch, programId);

  const data = Buffer.alloc(9);
  data[0] = IX_SETTLE_FROM_LOG;
  writeU16LE(data, marketIndex, 1);
  data.writeUInt32LE(epoch, 3);
  writeU16LE(data, numFills, 7);

  return new TransactionInstruction({
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: fillLog, isSigner: false, isWritable: false },
      ...remainingAccounts,
    ],
    programId,
    data,
  });
}
