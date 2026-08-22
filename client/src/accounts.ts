import { PublicKey } from "@solana/web3.js";
import {
  DISC_GLOBAL_STATE,
  DISC_MARKET,
  DISC_USER_ACCOUNT,
  DISC_POSITION,
  DISC_ORDER_BOOK,
  DISC_TRADING_CREDIT,
  DISC_LIQUIDATION_INTENT,
  DISC_FILL_LOG,
  DISC_TRIGGER_ORDER,
  PRICE_SCALE,
  GLOBAL_STATE_SIZE,
  USER_ACCOUNT_SIZE,
  POSITION_SIZE,
  ORDER_BOOK_HEADER_SIZE,
  ORDER_SLOT_SIZE,
  PRICE_LEVEL_SIZE,
  FILL_EVENT_SIZE,
  TRADING_CREDIT_SIZE,
  LIQUIDATION_INTENT_SIZE,
  FILL_LOG_HEADER_SIZE,
  FILL_LOG_CAPACITY,
} from "./constants";

// Re-export the on-chain account size constants so consumers that import them
// from this module (alongside the decoders that use them) resolve correctly.
export {
  ORDER_BOOK_HEADER_SIZE,
  ORDER_SLOT_SIZE,
  PRICE_LEVEL_SIZE,
  FILL_EVENT_SIZE,
};

// ---- Helpers ----

function readU8(buf: Buffer, offset: number): number {
  return buf.readUInt8(offset);
}
function readU16LE(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}
function readI64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigInt64LE(offset);
}
function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}
function readPubkey(buf: Buffer, offset: number): PublicKey {
  return new PublicKey(buf.subarray(offset, offset + 32));
}
function readI128FromSplitI64(buf: Buffer, loOffset: number): bigint {
  const lo = buf.readBigUInt64LE(loOffset);
  const hi = buf.readBigInt64LE(loOffset + 8);
  return (hi << 64n) | lo;
}

// ---- GlobalState ----
export interface GlobalState {
  discriminator: number;
  bump: number;
  marketCount: number;
  paused: boolean;
  authority: PublicKey;
  treasury: PublicKey;
  insuranceVault: PublicKey;
}

export function decodeGlobalState(data: Buffer): GlobalState {
  if (data.length < GLOBAL_STATE_SIZE)
    throw new Error("GlobalState buffer too small");
  if (data[0] !== DISC_GLOBAL_STATE)
    throw new Error("Invalid GlobalState discriminator");
  return {
    discriminator: readU8(data, 0),
    bump: readU8(data, 1),
    marketCount: readU16LE(data, 2),
    paused: readU8(data, 4) !== 0,
    authority: readPubkey(data, 8),
    treasury: readPubkey(data, 40),
    insuranceVault: readPubkey(data, 72),
  };
}

// ---- Market ----
export const TWAP_BUFFER_SIZE = 225;

export interface Market {
  discriminator: number;
  bump: number;
  marketIndex: number;
  maxLeverage: number;
  circuitBreakerActive: boolean;
  takerFeeBps: number;
  makerRebateBps: number;
  twapWriteIndex: number;
  twapCount: number;
  /** S6-01. The mark-price freshness stamp: minutes-since-epoch mod 65536,
   *  written by crank_twap and read by the program's own `is_mark_price_fresh`.
   *  It lives in `Market._padding1` (byte 14), so both vendored decoders used to
   *  skip it as padding -- which left every client structurally unable to tell a
   *  live mark from a 16-day-old one, while rendering it as live.
   *  0 means "never stamped", which the program treats as fresh. */
  markPriceMinute: number;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  pythFeed: PublicKey;
  quoteVault: PublicKey;
  tickSize: bigint;
  lotSize: bigint;
  fundingIntervalSecs: bigint;
  lastFundingTs: bigint;
  openInterestLong: bigint;
  openInterestShort: bigint;
  insuranceFundBalance: bigint;
  lastMarkPrice: bigint;
  cumulativeFundingIndex: bigint;
  twapPrices: bigint[];
  /** L1 settlement cursor (highest settled FillEvent.sequence) — LE u32 stored
   *  in the Round-3 trailing padding at byte 2058; 0 on pre-Round-3 layouts. */
  lastSettledSequence: number;
  /** Round-3 addition (byte 2024). All-zero if never configured. */
  switchboardFeed: PublicKey;
  /** 0 = normal trading, 1 = restricted (closes-only) — set on dual-oracle
   *  disagreement, cleared after 3 consecutive agreement readings. false on
   *  pre-Round-3 layouts (byte 2056 doesn't exist yet). */
  restrictedMode: boolean;
}

/** Full Market account size, including the Round-3 tail (switchboard_feed,
 *  restricted_mode, agreement_streak, and the last_settled_sequence padding). */
export const MARKET_SIZE = 224 + TWAP_BUFFER_SIZE * 8 + 40;

export function decodeMarket(data: Buffer): Market {
  if (data.length < 224 + TWAP_BUFFER_SIZE * 8)
    throw new Error("Market buffer too small");
  if (data[0] !== DISC_MARKET) throw new Error("Invalid Market discriminator");

  const twapPrices: bigint[] = [];
  for (let i = 0; i < TWAP_BUFFER_SIZE; i++) {
    twapPrices.push(readU64LE(data, 224 + i * 8));
  }

  return {
    discriminator: readU8(data, 0),
    bump: readU8(data, 1),
    marketIndex: readU16LE(data, 2),
    maxLeverage: readU8(data, 4),
    circuitBreakerActive: readU8(data, 5) !== 0,
    takerFeeBps: readU16LE(data, 6),
    makerRebateBps: readU16LE(data, 8),
    twapWriteIndex: readU16LE(data, 10),
    twapCount: readU16LE(data, 12),
    markPriceMinute: readU16LE(data, 14),
    baseMint: readPubkey(data, 16),
    quoteMint: readPubkey(data, 48),
    pythFeed: readPubkey(data, 80),
    quoteVault: readPubkey(data, 112),
    tickSize: readU64LE(data, 144),
    lotSize: readU64LE(data, 152),
    fundingIntervalSecs: readU64LE(data, 160),
    lastFundingTs: readI64LE(data, 168),
    openInterestLong: readU64LE(data, 176),
    openInterestShort: readU64LE(data, 184),
    insuranceFundBalance: readU64LE(data, 192),
    lastMarkPrice: readU64LE(data, 200),
    cumulativeFundingIndex: readI128FromSplitI64(data, 208),
    twapPrices,
    lastSettledSequence: data.length >= 2062 ? data.readUInt32LE(2058) : 0,
    switchboardFeed: data.length >= 2056 ? readPubkey(data, 2024) : ZERO_PUBKEY,
    restrictedMode: data.length >= 2057 ? readU8(data, 2056) !== 0 : false,
  };
}

// ---- UserAccount (56 bytes) ----
export interface UserAccount {
  discriminator: number;
  bump: number;
  pendingFills: number;
  owner: PublicKey;
  freeCollateral: bigint;
  creditOutstanding: bigint;
}

export function decodeUserAccount(data: Buffer): UserAccount {
  if (data.length < USER_ACCOUNT_SIZE)
    throw new Error("UserAccount buffer too small");
  if (data[0] !== DISC_USER_ACCOUNT)
    throw new Error("Invalid UserAccount discriminator");
  return {
    discriminator: readU8(data, 0),
    bump: readU8(data, 1),
    pendingFills: readU16LE(data, 2),
    owner: readPubkey(data, 8),
    freeCollateral: readU64LE(data, 40),
    creditOutstanding: readU64LE(data, 48),
  };
}

// ---- Position (96 bytes) ----
export interface Position {
  discriminator: number;
  bump: number;
  marketIndex: number;
  owner: PublicKey;
  size: bigint;
  entryPrice: bigint;
  collateral: bigint;
  realizedPnl: bigint;
  openSlot: bigint;
  fundingIndexSnapshot: bigint;
}

export function decodePosition(data: Buffer): Position {
  if (data.length < POSITION_SIZE)
    throw new Error("Position buffer too small");
  if (data[0] !== DISC_POSITION)
    throw new Error("Invalid Position discriminator");
  return {
    discriminator: readU8(data, 0),
    bump: readU8(data, 1),
    marketIndex: readU16LE(data, 2),
    owner: readPubkey(data, 8),
    size: readI64LE(data, 40),
    entryPrice: readU64LE(data, 48),
    collateral: readU64LE(data, 56),
    realizedPnl: readI64LE(data, 64),
    openSlot: readU64LE(data, 72),
    fundingIndexSnapshot: readI128FromSplitI64(data, 80),
  };
}

// ---- TradingCredit (96 bytes) ----
export interface TradingCredit {
  discriminator: number;
  bump: number;
  marketIndex: number;
  activeOrders: number;
  owner: PublicKey;
  credit: bigint;
  committed: bigint;
  /** Authorized session signer (all-zero PublicKey = no active session). */
  sessionAuthority: PublicKey;
  /** Unix secs after which the session key is no longer accepted (0 = none). */
  sessionExpiry: bigint;
  /** Derived: credit - committed */
  available: bigint;
}

/** The all-zero pubkey used on-chain to mean "no session authority". */
const ZERO_PUBKEY = new PublicKey(new Uint8Array(32));

export function decodeTradingCredit(data: Buffer): TradingCredit {
  // Accept the legacy 56-byte layout the program still supports
  // (trading_credit.rs:48-54). See the frontend twin for the full note.
  if (data.length < 56) throw new Error("TradingCredit buffer too small");
  if (data[0] !== DISC_TRADING_CREDIT)
    throw new Error("Invalid TradingCredit discriminator");
  const credit = readU64LE(data, 40);
  const committed = readU64LE(data, 48);
  return {
    discriminator: readU8(data, 0),
    bump: readU8(data, 1),
    marketIndex: readU16LE(data, 2),
    activeOrders: readU16LE(data, 4),
    owner: readPubkey(data, 8),
    credit,
    committed,
    // New session fields: session_authority [u8;32] @ 56, session_expiry i64 @ 88.
    sessionAuthority: readPubkey(data, 56),
    sessionExpiry: readI64LE(data, 88),
    available: credit > committed ? credit - committed : 0n,
  };
}

/** True iff the credit has a non-zero session authority that is not yet expired
 *  at `nowSecs` (defaults to the current wall-clock time). */
export function isSessionActive(
  tc: TradingCredit,
  nowSecs: number = Math.floor(Date.now() / 1000)
): boolean {
  return !tc.sessionAuthority.equals(ZERO_PUBKEY) && BigInt(nowSecs) < tc.sessionExpiry;
}

// ---- LiquidationIntent (64 bytes) ----
export interface LiquidationIntent {
  discriminator: number;
  bump: number;
  position: PublicKey;
  createdTs: bigint;
  deadlineTs: bigint;
  initialHealthFactor: bigint;
}

export function decodeLiquidationIntent(data: Buffer): LiquidationIntent {
  if (data.length < LIQUIDATION_INTENT_SIZE)
    throw new Error("LiquidationIntent buffer too small");
  if (data[0] !== DISC_LIQUIDATION_INTENT)
    throw new Error("Invalid LiquidationIntent discriminator");
  return {
    discriminator: readU8(data, 0),
    bump: readU8(data, 1),
    position: readPubkey(data, 8),
    createdTs: readI64LE(data, 40),
    deadlineTs: readI64LE(data, 48),
    initialHealthFactor: readU64LE(data, 56),
  };
}

// ---- TriggerOrder (56 bytes) ----
export interface TriggerOrder {
  discriminator: number;
  bump: number;
  /** 0 = stop-loss, 1 = take-profit */
  kind: number;
  /** true: fire when mark >= triggerPrice; false: when mark <= it */
  triggerAbove: boolean;
  marketIndex: number;
  owner: PublicKey;
  triggerPrice: bigint;
  createdTs: bigint;
}

export const TRIGGER_ORDER_SIZE = 56;

export function decodeTriggerOrder(data: Buffer): TriggerOrder {
  if (data.length < TRIGGER_ORDER_SIZE)
    throw new Error("TriggerOrder buffer too small");
  if (data[0] !== DISC_TRIGGER_ORDER)
    throw new Error("Invalid TriggerOrder discriminator");
  return {
    discriminator: readU8(data, 0),
    bump: readU8(data, 1),
    kind: readU8(data, 2),
    triggerAbove: readU8(data, 3) !== 0,
    marketIndex: readU16LE(data, 4),
    owner: readPubkey(data, 8),
    triggerPrice: readU64LE(data, 40),
    createdTs: readI64LE(data, 48),
  };
}

/**
 * Compute the full OrderBook account size for the given capacities. Mirrors
 * `OrderBookHeader::compute_account_size` in the Rust program:
 *   header + order slots + bid levels + ask levels + fill events + free list.
 * Used by the deploy script's grow loop to know the target size.
 */
export function computeOrderBookAccountSize(
  maxOrderSlots: number,
  maxPriceLevels: number,
  maxFillEvents: number
): number {
  return (
    ORDER_BOOK_HEADER_SIZE +
    maxOrderSlots * ORDER_SLOT_SIZE +
    maxPriceLevels * PRICE_LEVEL_SIZE +
    maxPriceLevels * PRICE_LEVEL_SIZE +
    maxFillEvents * FILL_EVENT_SIZE +
    maxOrderSlots * 2
  );
}

// ---- OrderBookHeader (48 bytes) ----
export interface OrderBookHeader {
  discriminator: number;
  bump: number;
  marketIndex: number;
  ordersPerUser: number;
  maxOrderSlots: number;
  maxPriceLevelsPerSide: number;
  maxFillEvents: number;
  activeOrderCount: number;
  bidLevelCount: number;
  askLevelCount: number;
  fillEventHead: number;
  fillEventTail: number;
  fillEventCount: number;
  freeListHead: number;
  freeSlotCount: number;
  nextOrderId: bigint;
  nextFillSequence: bigint;
}

export function decodeOrderBookHeader(data: Buffer): OrderBookHeader {
  if (data.length < ORDER_BOOK_HEADER_SIZE)
    throw new Error("OrderBookHeader buffer too small");
  if (data[0] !== DISC_ORDER_BOOK)
    throw new Error("Invalid OrderBook discriminator");
  return {
    discriminator: readU8(data, 0),
    bump: readU8(data, 1),
    marketIndex: readU16LE(data, 2),
    ordersPerUser: readU8(data, 4),
    maxOrderSlots: readU16LE(data, 8),
    maxPriceLevelsPerSide: readU16LE(data, 10),
    maxFillEvents: readU16LE(data, 12),
    activeOrderCount: readU16LE(data, 14),
    bidLevelCount: readU16LE(data, 16),
    askLevelCount: readU16LE(data, 18),
    fillEventHead: readU16LE(data, 20),
    fillEventTail: readU16LE(data, 22),
    fillEventCount: readU16LE(data, 24),
    freeListHead: readU16LE(data, 26),
    freeSlotCount: readU16LE(data, 28),
    nextOrderId: readU64LE(data, 32),
    nextFillSequence: readU64LE(data, 40),
  };
}

// ---- OrderSlot (88 bytes — includes margin_reserved at offset 80) ----
export interface OrderSlot {
  active: boolean;
  side: number;
  orderType: number;
  nextAtLevel: number;
  prevAtLevel: number;
  orderId: bigint;
  owner: PublicKey;
  price: bigint;
  size: bigint;
  remainingSize: bigint;
  expiryTs: bigint;
  marginReserved: bigint;
}

export function decodeOrderSlot(data: Buffer, offset: number = 0): OrderSlot {
  return {
    active: readU8(data, offset + 0) !== 0,
    side: readU8(data, offset + 1),
    orderType: readU8(data, offset + 2),
    nextAtLevel: readU16LE(data, offset + 4),
    prevAtLevel: readU16LE(data, offset + 6),
    orderId: readU64LE(data, offset + 8),
    owner: readPubkey(data, offset + 16),
    price: readU64LE(data, offset + 48),
    size: readU64LE(data, offset + 56),
    remainingSize: readU64LE(data, offset + 64),
    expiryTs: readI64LE(data, offset + 72),
    marginReserved: readU64LE(data, offset + 80),
  };
}

// ---- PriceLevel (16 bytes) ----
export interface PriceLevel {
  price: bigint;
  headSlot: number;
  tailSlot: number;
  orderCount: number;
}

export function decodePriceLevel(data: Buffer, offset: number = 0): PriceLevel {
  return {
    price: readU64LE(data, offset + 0),
    headSlot: readU16LE(data, offset + 8),
    tailSlot: readU16LE(data, offset + 10),
    orderCount: readU16LE(data, offset + 12),
  };
}

// ---- FillEvent (104 bytes — new layout includes filled_margin and fee snapshots) ----
export interface FillEvent {
  sequence: bigint;
  maker: PublicKey;
  taker: PublicKey;
  price: bigint;
  quantity: bigint;
  filledMargin: bigint;
  takerFeeBpsSnapshot: number;
  makerRebateBpsSnapshot: number;
  makerSide: number;
}

export function decodeFillEvent(data: Buffer, offset: number = 0): FillEvent {
  return {
    sequence: readU64LE(data, offset + 0),
    maker: readPubkey(data, offset + 8),
    taker: readPubkey(data, offset + 40),
    price: readU64LE(data, offset + 72),
    quantity: readU64LE(data, offset + 80),
    filledMargin: readU64LE(data, offset + 88),
    takerFeeBpsSnapshot: readU16LE(data, offset + 96),
    makerRebateBpsSnapshot: readU16LE(data, offset + 98),
    makerSide: readU8(data, offset + 100),
  };
}

// ---- Full OrderBook decoder ----
export interface OrderBookState {
  header: OrderBookHeader;
  orderSlots: OrderSlot[];
  bidLevels: PriceLevel[];
  askLevels: PriceLevel[];
  fillEvents: FillEvent[];
}

export function decodeOrderBook(data: Buffer): OrderBookState {
  const header = decodeOrderBookHeader(data);

  let offset = ORDER_BOOK_HEADER_SIZE;

  const orderSlots: OrderSlot[] = [];
  for (let i = 0; i < header.maxOrderSlots; i++) {
    orderSlots.push(decodeOrderSlot(data, offset));
    offset += ORDER_SLOT_SIZE;
  }

  const bidLevels: PriceLevel[] = [];
  for (let i = 0; i < header.maxPriceLevelsPerSide; i++) {
    bidLevels.push(decodePriceLevel(data, offset));
    offset += PRICE_LEVEL_SIZE;
  }

  const askLevels: PriceLevel[] = [];
  for (let i = 0; i < header.maxPriceLevelsPerSide; i++) {
    askLevels.push(decodePriceLevel(data, offset));
    offset += PRICE_LEVEL_SIZE;
  }

  const fillEvents: FillEvent[] = [];
  for (let i = 0; i < header.maxFillEvents; i++) {
    fillEvents.push(decodeFillEvent(data, offset));
    offset += FILL_EVENT_SIZE;
  }

  return { header, orderSlots, bidLevels, askLevels, fillEvents };
}

// ---- Utilities ----
export function priceToHuman(price: bigint): number {
  return Number(price) / PRICE_SCALE;
}
export function humanToPrice(human: number): bigint {
  return BigInt(Math.round(human * PRICE_SCALE));
}

export function computeTwap(market: Market): number | null {
  const count = market.twapCount;
  if (count === 0) return null;
  let sum = 0n;
  if (count === TWAP_BUFFER_SIZE) {
    for (const p of market.twapPrices) sum += p;
  } else {
    for (let i = 0; i < count; i++) sum += market.twapPrices[i];
  }
  return Number(sum / BigInt(count)) / PRICE_SCALE;
}

// ---- FillLog (small, epoch-rotatable settlement source) ----

export interface FillLogHeader {
  discriminator: number;
  bump: number;
  marketIndex: number;
  epoch: number;
  capacity: number;
  count: number;
  head: number;
  lastMirroredSequence: bigint;
}

export function decodeFillLogHeader(data: Buffer): FillLogHeader {
  if (data.length < FILL_LOG_HEADER_SIZE)
    throw new Error("FillLogHeader buffer too small");
  if (data[0] !== DISC_FILL_LOG)
    throw new Error("Invalid FillLog discriminator");
  return {
    discriminator: readU8(data, 0),
    bump: readU8(data, 1),
    marketIndex: readU16LE(data, 2),
    epoch: data.readUInt32LE(4),
    capacity: readU16LE(data, 8),
    count: readU16LE(data, 10),
    head: readU16LE(data, 12),
    lastMirroredSequence: readU64LE(data, 16),
  };
}

/**
 * Decode the FillLog's fills in ring order (oldest first), returning the
 * `count` valid entries starting at `head`. The FillEvent layout is identical to
 * the OrderBook's (decodeFillEvent), only the container differs.
 */
export function decodeFillLogFills(data: Buffer): FillEvent[] {
  const header = decodeFillLogHeader(data);
  const out: FillEvent[] = [];
  for (let i = 0; i < header.count; i++) {
    const idx = (header.head + i) % header.capacity;
    out.push(decodeFillEvent(data, FILL_LOG_HEADER_SIZE + idx * FILL_EVENT_SIZE));
  }
  return out;
}

export { FILL_LOG_HEADER_SIZE, FILL_LOG_CAPACITY };
