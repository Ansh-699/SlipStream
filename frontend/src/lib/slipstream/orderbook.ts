// Order-book aggregation helpers built on top of the vendored SDK decoders.
//
// The on-chain PriceLevel struct stores price + a FIFO of order slots
// (head_slot -> next_at_level -> ... -> SENTINEL) and an order count, but NOT
// an aggregate size. To surface the true resting size at each level we walk the
// slot linked list and sum each slot's remaining_size. This mirrors how the
// program itself reads a level (see place_order.rs / cancel_order.rs).

import { PRICE_SCALE, SENTINEL } from "./constants";
import {
  decodeOrderBook,
  decodeOrderBookHeader,
  decodeOrderSlot,
  decodePriceLevel,
  decodeFillEvent,
  computeOrderBookAccountSize,
  ORDER_BOOK_HEADER_SIZE,
  ORDER_SLOT_SIZE,
  PRICE_LEVEL_SIZE,
  FILL_EVENT_SIZE,
  type OrderBookState,
  type OrderSlot,
  type PriceLevel,
  type FillEvent,
} from "./accounts";

/** The previous decode, kept so the next one can reuse what did not change. */
export interface BookDecodeCache {
  data: Uint8Array;
  book: OrderBookState;
}

function sameBytes(a: Uint8Array, b: Uint8Array, offset: number, length: number): boolean {
  for (let i = offset, end = offset + length; i < end; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * `decodeOrderBook`, reusing every record whose bytes are unchanged since `prev`.
 *
 * WHY: the book is one 626,736-byte account -- 2,048 order slots, 2x512 price
 * levels and a 4,096-entry fill ring -- and a full decode builds ~10,000
 * objects including 10,240 PublicKeys, every update. A trade or a requote
 * rewrites a handful of those records, so with the rollup now PUSHING each
 * update (up to 20 renders/s) re-decoding the whole thing each time was most of
 * the main thread. Comparing bytes is a tight loop with no allocation; only the
 * records that differ are decoded again.
 *
 * Unchanged records keep their object identity, so the result is safe to diff
 * by reference. Output is byte-for-byte what `decodeOrderBook` returns,
 * including its truncation check.
 */
export function decodeOrderBookIncremental(data: Buffer, prev: BookDecodeCache | null): OrderBookState {
  const header = decodeOrderBookHeader(data);
  const needed = computeOrderBookAccountSize(
    header.maxOrderSlots,
    header.maxPriceLevelsPerSide,
    header.maxFillEvents
  );
  if (data.length < needed) {
    throw new Error(`OrderBook buffer truncated: header declares ${needed} bytes, got ${data.length}`);
  }
  const base =
    prev &&
    prev.data.length === data.length &&
    prev.book.header.maxOrderSlots === header.maxOrderSlots &&
    prev.book.header.maxPriceLevelsPerSide === header.maxPriceLevelsPerSide &&
    prev.book.header.maxFillEvents === header.maxFillEvents
      ? prev
      : null;
  if (!base) return decodeOrderBook(data);
  const old = base.data;

  let offset = ORDER_BOOK_HEADER_SIZE;
  const orderSlots: OrderSlot[] = new Array(header.maxOrderSlots);
  for (let i = 0; i < header.maxOrderSlots; i++, offset += ORDER_SLOT_SIZE) {
    orderSlots[i] = sameBytes(data, old, offset, ORDER_SLOT_SIZE)
      ? base.book.orderSlots[i]
      : decodeOrderSlot(data, offset);
  }
  const levels = (previous: PriceLevel[]): PriceLevel[] => {
    const out: PriceLevel[] = new Array(header.maxPriceLevelsPerSide);
    for (let i = 0; i < header.maxPriceLevelsPerSide; i++, offset += PRICE_LEVEL_SIZE) {
      out[i] = sameBytes(data, old, offset, PRICE_LEVEL_SIZE) ? previous[i] : decodePriceLevel(data, offset);
    }
    return out;
  };
  const bidLevels = levels(base.book.bidLevels);
  const askLevels = levels(base.book.askLevels);
  const fillEvents: FillEvent[] = new Array(header.maxFillEvents);
  for (let i = 0; i < header.maxFillEvents; i++, offset += FILL_EVENT_SIZE) {
    fillEvents[i] = sameBytes(data, old, offset, FILL_EVENT_SIZE)
      ? base.book.fillEvents[i]
      : decodeFillEvent(data, offset);
  }
  return { header, orderSlots, bidLevels, askLevels, fillEvents };
}

export interface AggregatedLevel {
  /** Human-readable price (scaled down by PRICE_SCALE). */
  price: number;
  /** Aggregate resting size at this level, in base units (lots * lotSize). */
  size: number;
  /** Number of resting orders at this level. */
  orders: number;
}

export interface OrderBookLadders {
  /** Bids sorted descending (best/highest first). */
  bids: AggregatedLevel[];
  /** Asks sorted ascending (best/lowest first). */
  asks: AggregatedLevel[];
  /** asks[0].price - bids[0].price, or null if either side is empty. */
  spread: number | null;
}

/**
 * Sum the remaining size resting at a single price level by walking its FIFO of
 * order slots, guarding against malformed/cyclic links with a visit cap.
 */
function aggregateLevelSize(level: PriceLevel, orderSlots: OrderSlot[]): bigint {
  let total = 0n;
  let slot = level.headSlot;
  let guard = 0;
  const maxHops = orderSlots.length + 1;
  while (slot !== SENTINEL && slot < orderSlots.length && guard < maxHops) {
    const s = orderSlots[slot];
    if (s.active) total += s.remainingSize;
    slot = s.nextAtLevel;
    guard += 1;
  }
  return total;
}

/**
 * Convert decoded bid/ask PriceLevel arrays into human-readable, sorted ladders.
 * Base size is divided by `baseScale` (defaults to 1e9 lamports-style base units
 * used elsewhere in the UI) so callers get a human SOL quantity.
 */
export function buildLadders(
  book: OrderBookState,
  opts: { baseScale?: number; depth?: number } = {}
): OrderBookLadders {
  const baseScale = opts.baseScale ?? 1e9;
  const depth = opts.depth ?? 20;
  const { header, orderSlots, bidLevels, askLevels } = book;

  const toLevel = (lvl: PriceLevel): AggregatedLevel => ({
    price: Number(lvl.price) / PRICE_SCALE,
    size: Number(aggregateLevelSize(lvl, orderSlots)) / baseScale,
    orders: lvl.orderCount,
  });

  const bids = bidLevels
    .slice(0, header.bidLevelCount)
    .filter((l) => l.price > 0n && l.orderCount > 0)
    .map(toLevel)
    .sort((a, b) => b.price - a.price) // descending
    .slice(0, depth);

  const asks = askLevels
    .slice(0, header.askLevelCount)
    .filter((l) => l.price > 0n && l.orderCount > 0)
    .map(toLevel)
    .sort((a, b) => a.price - b.price) // ascending
    .slice(0, depth);

  const spread =
    bids.length > 0 && asks.length > 0 ? asks[0].price - bids[0].price : null;

  return { bids, asks, spread };
}

/** Decode raw account data and aggregate it into ladders in one step. */
export function decodeOrderBookLadders(
  data: Buffer,
  opts?: { baseScale?: number; depth?: number }
): { book: OrderBookState; ladders: OrderBookLadders } {
  const book = decodeOrderBook(data);
  return { book, ladders: buildLadders(book, opts) };
}

/**
 * Extract recent fills from the decoded fill-event ring buffer, newest first.
 * The ER matching engine only ever PUSHES fills (it never pops), so the valid
 * entries occupy [fillEventHead, fillEventHead + fillEventCount). We must read
 * from HEAD, not tail — tail is where the NEXT fill will be written, so starting
 * there lands on empty/stale slots (the bug that left the tape empty despite
 * fills existing on-chain).
 */
export function recentFills(book: OrderBookState, limit = 30) {
  const { header, fillEvents } = book;
  const count = Math.min(header.fillEventCount, fillEvents.length);
  if (count === 0) return [];

  const max = header.maxFillEvents || fillEvents.length;
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = (header.fillEventHead + i) % max;
    const fe = fillEvents[idx];
    if (fe.sequence === 0n && fe.quantity === 0n) continue;
    out.push(fe);
  }
  out.sort((a, b) => (b.sequence > a.sequence ? 1 : b.sequence < a.sequence ? -1 : 0));
  return out.slice(0, limit);
}
