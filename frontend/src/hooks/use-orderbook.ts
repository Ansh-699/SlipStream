"use client";

import { useCallback, useEffect, useState } from "react";
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

export function useOrderBook(marketIndex: number = 0) {
  const [data, setData] = useState<OrderBookData>(EMPTY);

  const fetch = useCallback(async () => {
    try {
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
        const erConn = new Connection(ER_RPC, "confirmed");
        info = await erConn.getAccountInfo(pda);
      } catch {
        // ER unavailable — fall back to base RPC below.
      }
      if (!info) {
        const baseConn = new Connection(RPC_URL, "confirmed");
        info = await baseConn.getAccountInfo(pda);
      }
      if (!info) {
        // Neither the ER nor the base layer returned the account.
        setData((prev) => ({ ...prev, status: "unavailable" }));
        return;
      }

      // Decode with the canonical SDK decoder (correct 88-byte order slots, etc).
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

      setData({
        bids,
        asks,
        spread,
        trades,
        nextFillSequence: Number(book.header.nextFillSequence),
        status: bids.length || asks.length ? "live" : "empty",
        updatedAt: Date.now(),
      });
    } catch {
      // Transient RPC/decode error. Keep the last good ladder on screen — a
      // single blip should not blank the book — but stop calling it live, so
      // callers can say "stale" instead of showing frozen quotes as current.
      setData((prev) => {
        if (prev.updatedAt === null) return { ...prev, status: "unavailable" };
        return prev.status === "stale" ? prev : { ...prev, status: "stale" };
      });
    }
  }, [marketIndex]);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 2_000);
    return () => clearInterval(id);
  }, [fetch]);

  return data;
}
