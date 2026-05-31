"use client";

import { useCallback, useEffect, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, ORDER_BOOK, MARKET_INDEX, ER_RPC, RPC_URL } from "@/lib/manifest";
import {
  SEED_ORDERBOOK,
  PRICE_SCALE,
  SIDE_BID,
  decodeOrderBook,
} from "@/lib/slipstream";

export interface OpenOrder {
  /** On-chain order id (needed to cancel). */
  orderId: bigint;
  /** true = bid/long, false = ask/short. */
  isLong: boolean;
  /** Human price (USD). */
  price: number;
  /** Remaining unfilled size in SOL. */
  size: number;
}

/**
 * A wallet's resting orders, read straight from the ER orderbook (the live book
 * lives on the Ephemeral Rollup). These are OPEN orders that haven't fully
 * filled yet — distinct from settled L1 Positions. Each order slot carries its
 * owner, so we filter the active slots to the connected wallet.
 */
export function useOpenOrders(owner: PublicKey | null, marketIndex: number = 0) {
  const [orders, setOrders] = useState<OpenOrder[]>([]);

  const fetch = useCallback(async () => {
    if (!owner) {
      setOrders([]);
      return;
    }
    try {
      let pda: PublicKey;
      if (marketIndex === MARKET_INDEX) {
        pda = ORDER_BOOK;
      } else {
        const buf = Buffer.alloc(2);
        buf.writeUInt16LE(marketIndex);
        [pda] = PublicKey.findProgramAddressSync([SEED_ORDERBOOK, buf], PROGRAM_ID);
      }

      // Live book is on the ER; fall back to base if the ER is unreachable.
      let info = null;
      try {
        const erConn = new Connection(ER_RPC, "confirmed");
        info = await erConn.getAccountInfo(pda);
      } catch {
        /* fall through to base */
      }
      if (!info) {
        const baseConn = new Connection(RPC_URL, "confirmed");
        info = await baseConn.getAccountInfo(pda);
      }
      if (!info) {
        setOrders([]);
        return;
      }

      const book = decodeOrderBook(info.data as Buffer);
      const ownerB58 = owner.toBase58();
      const mine: OpenOrder[] = [];
      for (const slot of book.orderSlots) {
        if (!slot.active) continue;
        if (slot.remainingSize === 0n) continue;
        if (slot.owner.toBase58() !== ownerB58) continue;
        mine.push({
          orderId: slot.orderId,
          isLong: slot.side === SIDE_BID,
          price: Number(slot.price) / PRICE_SCALE,
          size: Number(slot.remainingSize) / 1e9,
        });
      }
      // Best price first within each side; longs above shorts.
      mine.sort((a, b) => {
        if (a.isLong !== b.isLong) return a.isLong ? -1 : 1;
        return a.isLong ? b.price - a.price : a.price - b.price;
      });
      setOrders(mine);
    } catch {
      // Transient RPC/decode error — keep last good state and retry.
    }
  }, [owner, marketIndex]);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 2_000);
    return () => clearInterval(id);
  }, [fetch]);

  return { orders, refresh: fetch };
}
