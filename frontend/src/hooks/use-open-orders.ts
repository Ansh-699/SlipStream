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
  const { orderSlots, status } = useOrderBook(marketIndex);

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

  // POS-1. An empty list has two causes the panel used to render identically:
  // "you have no resting orders" and "we could not read the book at all". Only
  // "unavailable" is the second one — it is useOrderBook's word for unreachable
  // WITH nothing cached; "stale" still holds a last-good book, and "loading"
  // and "empty" are answers.
  //
  // (The `refresh` this used to return was a documented no-op — the book is the
  // shared 2s poller's and one subscriber cannot make it tick early — so it was
  // deleted along with its only call site in open-orders.tsx. A cancelled row
  // still clears on the next shared poll, within 2s.)
  return { orders, error: status === "unavailable" };
}
