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

export interface OrderBookData {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  spread: number | null;
  trades: RecentTrade[];
}

const EMPTY: OrderBookData = { bids: [], asks: [], spread: null, trades: [] };

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
        setData(EMPTY);
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

      setData({ bids, asks, spread, trades });
    } catch {
      // Transient RPC/decoding error — keep last good state and retry.
    }
  }, [marketIndex]);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 2_000);
    return () => clearInterval(id);
  }, [fetch]);

  return data;
}
