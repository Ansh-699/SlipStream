"use client";

import { useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import { useOrderBook } from "@/hooks/use-orderbook";
import { PRICE_SCALE, SIDE_BID } from "@/lib/slipstream";

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
 *
 * This used to be a THIRD independent 2s poller on the 626,736-byte OrderBook
 * account, on top of useOrderBook's shared one and useErPosition's — a second
 * 836 KB every 2s to display at most twenty rows, of which it read the first
 * 29% and threw the rest away. It now selects from the one shared decode.
 * The ER-then-base fallback and the keep-last-good-on-error semantics it used
 * to implement itself are identical in useOrderBook + useSharedSource, so
 * nothing was lost with the poller.
 */
export function useOpenOrders(owner: PublicKey | null, marketIndex: number = 0) {
  const { orderSlots } = useOrderBook(marketIndex);

  const orders = useMemo<OpenOrder[]>(() => {
    if (!owner) return [];
    const ownerB58 = owner.toBase58();
    const mine: OpenOrder[] = [];
    for (const slot of orderSlots) {
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
    return mine;
  }, [owner, orderSlots]);

  // Deliberately a no-op, not a forgotten stub. open-orders.tsx calls this
  // after a confirmed cancel to make the row disappear at once; the book is now
  // the shared 2s poller's and a single subscriber cannot make it tick early,
  // so the cancelled row clears on the next shared poll instead — within 2s of
  // a confirmation that itself took seconds. Delete this together with the
  // `refresh()` call at open-orders.tsx:60, which is the only caller.
  const refresh = () => {};

  return { orders, refresh };
}
