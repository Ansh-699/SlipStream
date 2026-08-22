"use client";

import { baseConnection, erConnection } from "@/lib/connections";
import { useSharedSource } from "@/lib/shared-source";
import { useCallback, useMemo } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, ORDER_BOOK, MARKET_INDEX, ER_RPC, RPC_URL } from "@/lib/manifest";
import {
  SEED_ORDERBOOK,
  PRICE_SCALE,
  SIDE_BID,
  decodeOrderBook,
  buildLadders,
  recentFills,
  type AggregatedLevel,
} from "@/lib/slipstream";

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
  /** Matching engine's next fill sequence (settlement-lag numerator). */
  nextFillSequence: number;
  status: OrderBookStatus;
  /** Epoch ms of the last successful decode, or null if we never got one. */
  updatedAt: number | null;
}

const EMPTY: OrderBookData = {
  bids: [],
  asks: [],
  spread: null,
  trades: [],
  nextFillSequence: 0,
  status: "loading",
  updatedAt: null,
};

export function useOrderBook(marketIndex: number = 0): OrderBookData {
  // ONE poller for this market, however many components mount this hook. It is
  // mounted three times on /trade (order-book-display, status-panel,
  // fill-toasts) and the account is 626,736 bytes, so the two redundant copies
  // every 2s were ~835 KB/s of pure duplication — and status-panel reads eight
  // bytes of it. useErPosition and useOpenOrders pull the same account again on
  // their own schedules; those are separate call sites, not separate data.
  const key = `orderbook:${marketIndex}`;

  const fetcher = useCallback(async (): Promise<OrderBookData> => {
    let pda: PublicKey;
    if (marketIndex === MARKET_INDEX) {
      // Use the resolved orderbook address from the Deploy_Manifest.
      pda = ORDER_BOOK;
    } else {
      const buf = Buffer.alloc(2);
      buf.writeUInt16LE(marketIndex);
      [pda] = PublicKey.findProgramAddressSync([SEED_ORDERBOOK, buf], PROGRAM_ID);
    }

    // The live book lives on the Ephemeral Rollup; try ER first, then base.
    let info = null;
    try {
      info = await erConnection.getAccountInfo(pda);
    } catch {
      // ER unavailable — fall back to base RPC below.
    }
    if (!info) {
      info = await baseConnection.getAccountInfo(pda);
    }
    if (!info) {
      // Neither layer returned it. Throwing (rather than returning an
      // "unavailable" shape) lets the shared source keep the last good ladder,
      // which the status mapping below then marks stale.
      throw new Error("order book account not found on either layer");
    }

    const book = decodeOrderBook(info.data as Buffer);
    const { bids, asks, spread } = buildLadders(book, { depth: 20 });

    const trades: RecentTrade[] = recentFills(book, 40).map((fe) => ({
      sequence: Number(fe.sequence),
      price: Number(fe.price) / PRICE_SCALE,
      size: Number(fe.quantity) / 1e9,
      // makerSide is the resting side that was hit. If the maker was a bid,
      // the taker sold into it; otherwise the taker bought.
      side: fe.makerSide === SIDE_BID ? "sell" : "buy",
      taker: fe.taker.toBase58(),
      maker: fe.maker.toBase58(),
    }));

    return {
      bids,
      asks,
      spread,
      trades,
      nextFillSequence: Number(book.header.nextFillSequence),
      status: bids.length || asks.length ? "live" : "empty",
      updatedAt: Date.now(),
    };
  }, [marketIndex]);

  const { data, error } = useSharedSource<OrderBookData>(key, fetcher, 2_000);

  // Same three-way distinction as before: never fetched, fetched and empty, or
  // last-good-but-failing. A blip must not blank the book, and frozen quotes
  // must not be shown as current.
  return useMemo(() => {
    if (!data) return error ? { ...EMPTY, status: "unavailable" as const } : EMPTY;
    return error ? { ...data, status: "stale" as const } : data;
  }, [data, error]);
}
