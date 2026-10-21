"use client";

import { Buffer } from "buffer";
import { decompress as zstdDecompress } from "fzstd";
import { baseConnection, erConnection } from "@/lib/connections";
import { useSharedSource, revalidate, type LiveFeed } from "@/lib/shared-source";
import { erSocket } from "@/lib/er-socket";
import { useCallback, useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, ORDER_BOOK, MARKET_INDEX, ER_RPC_DIRECT } from "@/lib/manifest";
import {
  SEED_ORDERBOOK,
  PRICE_SCALE,
  SIDE_BID,
  decodeOrderBookIncremental,
  buildLadders,
  recentFills,
  type AggregatedLevel,
  type BookDecodeCache,
  type OrderSlot,
  type FillEvent,
} from "@/lib/slipstream";

/**
 * Levels kept per side. The book holds up to 512 per side and the ladder
 * scrolls, so it is no longer capped at the 20 that fit on screen: a trader's
 * own far-from-mid order used to vanish behind the market maker's rungs.
 */
export const BOOK_DEPTH = 100;

export type OrderBookLevel = AggregatedLevel;

export interface RecentTrade {
  sequence: number;
  price: number;
  /** Aggregate fill quantity in human (SOL) units. */
  size: number;
  /** "buy" when the taker lifted the offer (maker was a bid -> taker sold? ) */
  side: "buy" | "sell";
  /** Taker account (base58) — verifiable on the explorer. */
  taker: string;
  /** Maker account (base58). */
  maker: string;
}

/**
 * Why a caller needs this: an empty ladder has three very different causes —
 * we haven't fetched yet, the book decoded fine but nobody is quoting, or the
 * account/RPC is unreachable. Rendering all three as "no orders" is a lie, so
 * the status is reported rather than inferred from `bids.length === 0`.
 */
export type OrderBookStatus = "loading" | "live" | "stale" | "empty" | "unavailable";

export interface OrderBookData {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  spread: number | null;
  trades: RecentTrade[];
  /**
   * The raw decoded slot table and fill ring, exposed so that the OTHER
   * consumers of this account do not have to re-fetch 626,736 bytes to read a
   * slice of it. `decodeOrderBook` already produces both, so carrying them here
   * costs one array reference and zero extra bytes on the wire.
   *
   * NOT the same thing as `trades`: `trades` is `recentFills(book, 40)`, a
   * display-sized tail. `useErPosition` has to replay EVERY unsettled fill for
   * the owner, so it needs the whole ring — truncating to 40 would silently
   * drop part of a wallet's pending position.
   */
  orderSlots: OrderSlot[];
  fillEvents: FillEvent[];
  /** Matching engine's next fill sequence (settlement-lag numerator). */
  nextFillSequence: number;
  status: OrderBookStatus;
  /** Epoch ms of the last successful decode, or null if we never got one. */
  updatedAt: number | null;
  /** How the current book arrived: a rollup websocket push, or a read. */
  via: "push" | "read" | null;
}

const EMPTY: OrderBookData = {
  bids: [],
  asks: [],
  spread: null,
  trades: [],
  orderSlots: [],
  fillEvents: [],
  nextFillSequence: 0,
  status: "loading",
  updatedAt: null,
  via: null,
};

function orderBookAddress(marketIndex: number): PublicKey {
  // The manifest's resolved address for the deployed market; derived otherwise.
  if (marketIndex === MARKET_INDEX) return ORDER_BOOK;
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(marketIndex);
  return PublicKey.findProgramAddressSync([SEED_ORDERBOOK, buf], PROGRAM_ID)[0];
}

/** Account bytes from an RPC `data` tuple. `Buffer` is imported from the
 *  `buffer` package on purpose: the global one Next injects into client bundles
 *  is an older build with no readBigUInt64LE, which the decoders need (web3.js
 *  hands back buffer@6 instances, which is why its reads always worked). The rollup is asked for zstd: the
 *  626,736-byte book is ~35 KB compressed (mostly empty slots), against 836 KB
 *  as plain base64 -- or 40 KB gzipped through our proxy, which still pulled
 *  the full 836 KB from upstream on the server for every read. */
function accountBytes([data, encoding]: [string, string]): Buffer {
  const raw = Buffer.from(data, "base64");
  return encoding === "base64+zstd" ? Buffer.from(zstdDecompress(raw)) : raw;
}

type Layer = "er" | "base";

/**
 * Per-market decode state shared by the push feed and the reads, so the two
 * can never apply out of order: a read that started before a push and lands
 * after it carries an older slot and is dropped (`ingest`), and both reuse one
 * incremental decode cache.
 */
interface BookFeed {
  layer: Layer | null;
  slot: number;
  cache: BookDecodeCache | null;
  data: OrderBookData | null;
  /** The last push's raw text: the rollup re-sends unchanged accounts. */
  lastRaw: string | null;
  /** performance.now() of the last thing that proved the feed is current. */
  heardAt: number;
}

const feeds = new Map<number, BookFeed>();
function feedFor(marketIndex: number): BookFeed {
  let feed = feeds.get(marketIndex);
  if (!feed) {
    feed = { layer: null, slot: -1, cache: null, data: null, lastRaw: null, heardAt: 0 };
    feeds.set(marketIndex, feed);
  }
  return feed;
}

function toTrades(fills: FillEvent[]): RecentTrade[] {
  return fills.map((fe) => ({
    sequence: Number(fe.sequence),
    price: Number(fe.price) / PRICE_SCALE,
    size: Number(fe.quantity) / 1e9,
    // makerSide is the resting side that was hit. If the maker was a bid,
    // the taker sold into it; otherwise the taker bought.
    side: fe.makerSide === SIDE_BID ? "sell" : "buy",
    taker: fe.taker.toBase58(),
    maker: fe.maker.toBase58(),
  }));
}

/**
 * Decode `bytes` (read at `slot` on `layer`) into the shared book, unless a
 * newer slot from the same layer is already applied. Returns the current book.
 */
function ingest(feed: BookFeed, layer: Layer, slot: number, bytes: Buffer, via: "push" | "read"): OrderBookData {
  if (feed.data && feed.layer === layer && slot < feed.slot) return feed.data;
  // Slots are only comparable within one chain; a layer switch starts over.
  const prev = feed.layer === layer ? feed.cache : null;
  const book = decodeOrderBookIncremental(bytes, prev);
  const { bids, asks, spread } = buildLadders(book, { depth: BOOK_DEPTH });

  // Fills change far less often than quotes. When the ring is untouched, keep
  // the previous arrays so everything keyed on them -- the pending-position
  // replay, the trade tape, fill toasts -- skips its work by reference.
  const before = feed.layer === layer ? feed.data : null;
  const prevBook = prev?.book;
  const fillsUnchanged =
    before !== null &&
    prevBook !== undefined &&
    prevBook.header.fillEventHead === book.header.fillEventHead &&
    prevBook.header.fillEventCount === book.header.fillEventCount &&
    prevBook.header.nextFillSequence === book.header.nextFillSequence &&
    book.fillEvents.every((fe, i) => fe === prevBook.fillEvents[i]);
  const slotsUnchanged =
    before !== null &&
    prevBook !== undefined &&
    book.orderSlots.every((os, i) => os === prevBook.orderSlots[i]);

  // The ring's LIVE WINDOW, newest first — not the raw slot array.
  // book.fillEvents is a 4096-slot ring buffer: the raw array is in physical
  // slot order and still holds drained entries, so a consumer reading it
  // positionally gets neither "recent" nor "valid". recentFills walks it from
  // fillEventHead for fillEventCount entries and drops the empty slots, which
  // is what every consumer actually wants.
  const fillEvents = fillsUnchanged ? before!.fillEvents : recentFills(book, book.header.fillEventCount);
  const data: OrderBookData = {
    bids,
    asks,
    spread,
    trades: fillsUnchanged ? before!.trades : toTrades(fillEvents.slice(0, 40)),
    orderSlots: slotsUnchanged ? before!.orderSlots : book.orderSlots,
    fillEvents,
    nextFillSequence: Number(book.header.nextFillSequence),
    status: bids.length || asks.length ? "live" : "empty",
    updatedAt: Date.now(),
    via,
  };
  feed.layer = layer;
  feed.slot = slot;
  feed.cache = { data: bytes, book };
  feed.data = data;
  feed.heardAt = performance.now();
  return data;
}

/** A direct, zstd-compressed read from the rollup; null when the browser cannot
 *  reach it (the caller then goes through the proxy, as before). */
async function readDirect(address: string): Promise<{ slot: number; bytes: Buffer } | null | undefined> {
  try {
    const response = await fetch(ER_RPC_DIRECT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [address, { encoding: "base64+zstd", commitment: "confirmed" }],
      }),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      result?: { context: { slot: number }; value: { data: [string, string] } | null };
    };
    if (!body.result) return undefined;
    if (!body.result.value) return null;
    return { slot: body.result.context.slot, bytes: accountBytes(body.result.value.data) };
  } catch {
    return undefined;
  }
}

/** Never re-render the ladder faster than this: 20/s is below what reads as
 *  delay, and every animation frame (60/s) kept the main thread busy
 *  re-styling rows through market-maker bursts. */
const MIN_RENDER_GAP_MS = 50;
/** A maker requotes by cancel-then-place. Hold the last levels through that
 *  gap instead of flashing an empty book. */
const REQUOTE_GAP_MS = 2_500;
/** With the socket up and subscribed, re-read only after this much silence: a
 *  quiet book sends no pushes, so this is a heartbeat, not the feed. */
const PUSH_QUIET_MS = 15_000;

function liveFeed(marketIndex: number): LiveFeed<OrderBookData> {
  const feed = feedFor(marketIndex);
  let subscribed = false;
  return {
    // A hidden tab reads nothing: the socket is dropped after 30s hidden, and
    // on return it reconnects and the open handler below re-reads at once.
    fresh: () =>
      document.hidden ||
      (subscribed && erSocket()?.open === true && performance.now() - feed.heardAt < PUSH_QUIET_MS),
    start(push) {
      const socket = erSocket();
      if (!socket) return () => {};
      let pending: { slot: number; value: [string, string] } | null = null;
      let scheduled = false;
      let stopped = false;
      let lastPublishAt = 0;
      let lastQuotedAt = 0;
      let holdTimer: ReturnType<typeof setTimeout> | null = null;

      const publish = () => {
        scheduled = false;
        lastPublishAt = performance.now();
        if (stopped || !pending) return;
        const { slot, value } = pending;
        pending = null;
        feed.heardAt = performance.now();
        // The rollup pushes the account on every write, changed or not.
        if (value[0] === feed.lastRaw && feed.layer === "er") return;
        let data: OrderBookData;
        try {
          data = ingest(feed, "er", slot, accountBytes(value), "push");
        } catch {
          return; // a malformed push; the read path keeps the book honest
        }
        feed.lastRaw = value[0];
        const quoted = data.bids.length > 0 || data.asks.length > 0;
        if (quoted) lastQuotedAt = performance.now();
        else if (performance.now() - lastQuotedAt < REQUOTE_GAP_MS) {
          // Re-check once the gap has passed; a later push supersedes this.
          if (holdTimer === null) {
            holdTimer = setTimeout(() => {
              holdTimer = null;
              if (!stopped && feed.data && feed.data.bids.length + feed.data.asks.length === 0) push(feed.data);
            }, REQUOTE_GAP_MS);
          }
          return;
        }
        push(data);
      };
      // Coalesce bursts: keep only the newest push, decode it once, on a frame
      // (none while the tab is hidden and rAF sleeps).
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        const wait = Math.max(0, lastPublishAt + MIN_RENDER_GAP_MS - performance.now());
        setTimeout(() => requestAnimationFrame(publish), wait);
      };

      const unsubscribe = socket.subscribeAccount(orderBookAddress(marketIndex).toBase58(), ({ slot, value }) => {
        subscribed = true;
        if (!value) return;
        pending = { slot, value: value.data };
        schedule();
      });
      const offStatus = socket.onStatus((open) => {
        // Pushes resume from "now"; anything missed while down needs a read.
        if (open) {
          subscribed = true;
          revalidate(`orderbook:${marketIndex}`);
        } else subscribed = false;
      });
      if (socket.open) subscribed = true;
      return () => {
        stopped = true;
        if (holdTimer !== null) clearTimeout(holdTimer);
        unsubscribe();
        offStatus();
      };
    },
  };
}

export function useOrderBook(marketIndex: number = 0): OrderBookData {
  // ONE feed for this market, however many components mount this hook, and
  // for every consumer of the account rather than just the ladder: the book,
  // the status panel, fill toasts, open orders, the pending-position replay and
  // the trade tape all select from this one decode.
  //
  // It is a PUSH feed now. The rollup sends the account over a websocket the
  // moment it changes (processed commitment, ~10 ms blocks), zstd-compressed;
  // the 2s read below is the fallback for when the socket is down, and a slow
  // heartbeat while it is up. Before, the book was only ever as fresh as the
  // last 2s poll, plus the proxy hop, plus up to 16s of backoff.
  const key = `orderbook:${marketIndex}`;

  const fetcher = useCallback(async (): Promise<OrderBookData> => {
    const feed = feedFor(marketIndex);
    const pda = orderBookAddress(marketIndex);

    // The live book lives on the Ephemeral Rollup. Read it directly and
    // compressed first; through the proxy if the browser cannot reach it.
    const direct = await readDirect(pda.toBase58());
    if (direct) return ingest(feed, "er", direct.slot, direct.bytes, "read");

    let info = null;
    let layer: Layer = "er";
    try {
      const res = await erConnection.getAccountInfoAndContext(pda);
      if (res.value) info = { slot: res.context.slot, data: res.value.data };
    } catch {
      // ER unavailable — fall back to base RPC below.
    }
    if (!info) {
      layer = "base";
      const res = await baseConnection.getAccountInfoAndContext(pda);
      if (res.value) info = { slot: res.context.slot, data: res.value.data };
    }
    if (!info) {
      // Neither layer returned it. Throwing (rather than returning an
      // "unavailable" shape) lets the shared source keep the last good ladder,
      // which the status mapping below then marks stale.
      throw new Error("order book account not found on either layer");
    }
    return ingest(feed, layer, info.slot, info.data as Buffer, "read");
  }, [marketIndex]);

  const live = useMemo(() => liveFeed(marketIndex), [marketIndex]);
  const { data, error } = useSharedSource<OrderBookData>(key, fetcher, 2_000, live);

  // Same three-way distinction as before: never fetched, fetched and empty, or
  // last-good-but-failing. A blip must not blank the book, and frozen quotes
  // must not be shown as current.
  return useMemo(() => {
    if (!data) return error ? { ...EMPTY, status: "unavailable" as const } : EMPTY;
    return error ? { ...data, status: "stale" as const } : data;
  }, [data, error]);
}

/**
 * Force an immediate re-read of the shared book.
 *
 * Exported as a function rather than letting callers pass the key string,
 * because the key format is this module's business: useSharedSource's contract
 * is that the key must encode every input the fetcher depends on, and a caller
 * hand-writing "orderbook:0" is exactly how two sources end up sharing one
 * entry by accident.
 *
 * Use it after a CONFIRMED write that changes the book -- a cancel, a fill --
 * so the row disappears at once even if the push feed is down (the next poll
 * tick is 2.5s away at best and ~16s in backoff). With the feed up the push
 * normally lands first and this read is dropped by the slot guard.
 */
export function revalidateOrderBook(marketIndex: number = 0): void {
  revalidate(`orderbook:${marketIndex}`);
}
