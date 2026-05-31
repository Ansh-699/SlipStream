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
  type OrderBookState,
  type OrderSlot,
  type PriceLevel,
} from "./accounts";

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
