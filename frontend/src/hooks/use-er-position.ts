"use client";

import { baseConnection, erConnection } from "@/lib/connections";
import { startPoll } from "@/lib/poll";
import { useCallback, useEffect, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, MARKET, ORDER_BOOK, MARKET_INDEX, ER_RPC, RPC_URL } from "@/lib/manifest";
import {
  SEED_ORDERBOOK,
  SEED_MARKET,
  PRICE_SCALE,
  SIDE_BID,
  decodeOrderBook,
  decodeMarket,
  type FillEvent,
} from "@/lib/slipstream";

/**
 * A position reconstructed from the ER fill queue — the trades that have ALREADY
 * matched on the Ephemeral Rollup but have not yet been settled into an L1
 * `Position` account (settlement is gated by the MagicBlock sponsored-commit
 * cap). This mirrors what `settle_trades::update_position` would write on L1, so
 * the user can see their true economic position the instant it fills, marked
 * "pending settlement".
 */
export interface ErPosition {
  isLong: boolean;
  /** Net signed size in SOL (human units). */
  size: number;
  /** Volume-weighted average entry price (USD). */
  entryPrice: number;
  /** Collateral accrued from drained fill margin (USD). */
  collateral: number;
  /** Realized PnL booked on reductions/flips (USD). */
  realizedPnl: number;
  /** Mark-to-market unrealized PnL at the current mark (USD). */
  unrealizedPnl: number;
  /** Number of ER fills that make up this position (not yet on L1). */
  fillCount: number;
}

/** VWAP blend matching math/fixed_point.rs::compute_vwap_entry (integer-exact). */
function vwap(oldSize: bigint, oldEntry: bigint, addSize: bigint, addPrice: bigint): bigint {
  const total = oldSize + addSize;
  if (total === 0n) return 0n;
  return (oldSize * oldEntry + addSize * addPrice) / total;
}

/** Signed-size PnL matching compute_unrealized_pnl: size is 9-dp base atoms, so
 *  divide (priceDiff * size) by BASE_SCALE (1e9) to get 6-dp quote PnL. */
function pnl(signedQty: bigint, entry: bigint, mark: bigint): bigint {
  if (signedQty === 0n) return 0n;
  const absQty = signedQty < 0n ? -signedQty : signedQty;
  const diff = signedQty > 0n ? mark - entry : entry - mark;
  return (diff * absQty) / 1_000_000_000n; // BASE_SCALE
}

/**
 * Replay the owner's fills (as maker or taker) in sequence order, applying the
 * SAME position-update logic as the on-chain settle_trades. The result is the
 * net position the user holds on the ER right now.
 */
function reconstruct(
  fills: FillEvent[],
  ownerB58: string,
  markPrice: bigint,
  lastSettledSequence: bigint
): ErPosition | null {
  // Sort by sequence ascending so VWAP / reductions apply in match order.
  // Fills at or below the L1 settlement cursor are already reflected in the
  // real Position account — replaying them here would double-count an
  // already-settled position as still "pending".
  const ordered = [...fills]
    .filter((f) => f.quantity > 0n && f.sequence > lastSettledSequence)
    .sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0));

  let size = 0n; // signed, base atoms
  let entry = 0n; // 6-dp price
  let collateral = 0n; // 6-dp
  let realized = 0n; // 6-dp
  let count = 0;

  for (const f of ordered) {
    const isMaker = f.maker.toBase58() === ownerB58;
    const isTaker = f.taker.toBase58() === ownerB58;
    if (!isMaker && !isTaker) continue;
    count += 1;

    // The maker trades on maker_side; the taker on the opposite side. (Same rule
    // settle_trades uses: taker_side = maker_side == BID ? ASK : BID.)
    const side = isMaker
      ? f.makerSide
      : f.makerSide === SIDE_BID
      ? 1 /* ASK */
      : SIDE_BID;
    const signedQty = side === SIDE_BID ? f.quantity : -f.quantity;

    // Both sides credit Position.collateral with the same filled_margin
    // (same-leverage MVP), exactly as update_position does.
    collateral += f.filledMargin;

    if (size === 0n) {
      size = signedQty;
      entry = f.price;
    } else if ((size > 0n && side === SIDE_BID) || (size < 0n && side !== SIDE_BID)) {
      // Same direction — VWAP blend.
      const absOld = size < 0n ? -size : size;
      entry = vwap(absOld, entry, f.quantity, f.price);
      size += signedQty;
    } else {
      // Reduce or flip.
      const absOld = size < 0n ? -size : size;
      const reduceQty = f.quantity < absOld ? f.quantity : absOld;
      const reduceSigned = size > 0n ? reduceQty : -reduceQty;
      realized += pnl(reduceSigned, entry, f.price);

      if (f.quantity >= absOld) {
        const flip = f.quantity - absOld;
        if (flip > 0n) {
          size = side === SIDE_BID ? flip : -flip;
          entry = f.price;
        } else {
          size = 0n;
          entry = 0n;
        }
      } else {
        size += signedQty;
      }
    }
  }

  if (count === 0 || size === 0n) return null;

  const up = pnl(size, entry, markPrice);
  return {
    isLong: size > 0n,
    size: Number(size) / 1e9,
    entryPrice: Number(entry) / PRICE_SCALE,
    collateral: Number(collateral) / PRICE_SCALE,
    realizedPnl: Number(realized) / PRICE_SCALE,
    unrealizedPnl: Number(up) / PRICE_SCALE,
    fillCount: count,
  };
}

export function useErPosition(
  owner: PublicKey | null,
  markPrice: bigint | null,
  marketIndex: number = 0
) {
  const [position, setPosition] = useState<ErPosition | null>(null);

  const fetch = useCallback(async () => {
    if (!owner) {
      setPosition(null);
      return;
    }
    try {
      let pda: PublicKey;
      let marketPda: PublicKey;
      if (marketIndex === MARKET_INDEX) {
        pda = ORDER_BOOK;
        marketPda = MARKET;
      } else {
        const buf = Buffer.alloc(2);
        buf.writeUInt16LE(marketIndex);
        [pda] = PublicKey.findProgramAddressSync([SEED_ORDERBOOK, buf], PROGRAM_ID);
        [marketPda] = PublicKey.findProgramAddressSync([SEED_MARKET, buf], PROGRAM_ID);
      }

      let info = null;
      try {
        const erConn = erConnection;
        info = await erConn.getAccountInfo(pda);
      } catch {
        /* fall through to base */
      }
      if (!info) {
        const baseConn = baseConnection;
        info = await baseConn.getAccountInfo(pda);
      }
      if (!info) {
        setPosition(null);
        return;
      }

      // Read the L1 settlement cursor so already-settled fills aren't replayed
      // as still-pending. Best-effort: an unreachable/undecodable Market just
      // means the cursor is treated as 0 (unfiltered), same as before this fix.
      let lastSettledSequence = 0n;
      try {
        const baseConn = baseConnection;
        const marketInfo = await baseConn.getAccountInfo(marketPda);
        if (marketInfo) {
          lastSettledSequence = BigInt(decodeMarket(marketInfo.data as Buffer).lastSettledSequence);
        }
      } catch {
        /* best-effort */
      }

      const book = decodeOrderBook(info.data as Buffer);
      const pos = reconstruct(book.fillEvents, owner.toBase58(), markPrice ?? 0n, lastSettledSequence);
      setPosition(pos);
    } catch {
      // Transient — keep last good state.
    }
  }, [owner, markPrice, marketIndex]);

  useEffect(() => {
    fetch();
    return startPoll(fetch, 2_000);
  }, [fetch]);

  return { position, refresh: fetch };
}
