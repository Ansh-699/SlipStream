"use client";

import { useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import { useMarket } from "@/hooks/use-market";
import { useOrderBook } from "@/hooks/use-orderbook";
import { PRICE_SCALE, SIDE_BID, type FillEvent } from "@/lib/slipstream";

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
  // Nullable deliberately: priced at 0n the pnl() below returns a large
  // fabricated number that renders green or red by sign, next to a Mark column
  // that correctly shows "—". No price means no PnL, not a free one.
  markPrice: bigint | null,
  // The L1 settlement cursor. NOT optional and NOT defaultable to 0n: see the
  // note on `settledSeq` in the hook below. Callers that cannot read it must
  // not call this function at all.
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

  const up = markPrice === null ? null : pnl(size, entry, markPrice);
  // KNOWN GAP, and the comment on `markPrice` above only tells half the truth:
  // `up` is correctly null when there is no trustworthy price, and then
  // `Number(null)` collapses it straight back to 0. The row therefore paints a
  // green "+$0.00" in the one money cell while Mark, Liq. and Health beside it
  // honestly render "—". Widening this field to `number | null` is the right
  // fix but it does not compile on its own: positions-table.tsx reads
  // `unrealizedPnl >= 0` (and use-positions.ts fabricates the same 0 for the
  // settled row), and `null >= 0` is true, so the class must branch on null
  // too or the dash comes out green. Both render sites are outside this file.
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
  // Both inputs come from the pollers this page already runs: the shared
  // OrderBook source (useOrderBook, 2s) and the shared Market source
  // (useMarket, 5s). This hook used to run TWO more pollers of its own — a
  // second 626,736-byte getAccountInfo on the same order book every 2s, plus a
  // 2s read of a Market account that useMarket already holds — which measured
  // as roughly half of everything the tab moved. Subscribing costs nothing
  // extra: useSharedSource only starts a loop for the FIRST subscriber, and
  // both keys already have several.
  //
  // markPrice stays out of the data path entirely for the same reason it used
  // to be kept out of the fetch's dependency array: the live feed pushes ~20
  // prices/second, and it may only ever PRICE the fills, never re-read them.
  const { market } = useMarket(marketIndex);
  const { fillEvents } = useOrderBook(marketIndex);

  // The settlement cursor, or null when we do not have one.
  //
  // This used to be best-effort — an unreachable Market meant a cursor of 0n,
  // which reads as "nothing has ever settled". That is not a conservative
  // default, it is the most destructive possible value: reconstruct() keeps
  // every fill with `sequence > 0`, i.e. the ENTIRE 4096-entry ring including
  // months of fills that L1 settled long ago, and replays them into a position
  // that does not exist. Reproduced against live devnet: with the real cursor
  // (44189) every wallet correctly reconstructs to null; with the cursor
  // defaulted to 0 one wallet renders a pending LONG 5.600 SOL @ $73.09, and
  // the "Close" button beside it is live — one click sends a real 5.6 SOL IOC
  // and opens genuine opposite exposure.
  //
  // Without the cursor the client cannot tell a settled fill from a pending
  // one, so the only honest output is nothing at all. `market` is null while
  // the Market read is still in flight, when the account is genuinely absent,
  // and when the base layer is unreachable; all three mean "no cursor", and
  // all three must show no pending row rather than a fabricated one.
  //
  // The live [fillEventHead, +fillEventCount) window is NOT a substitute: that
  // window is currently the whole ring and L1 settlement cannot advance the
  // head, so it filters nothing.
  //
  // The shared cursor is up to 5s old rather than the 2s of the private poller
  // this replaced, so a just-settled fill can linger as "pending" for a few
  // seconds longer. That is the right trade: it is now the SAME cursor the
  // status panel renders settlement lag from, so the two can no longer
  // disagree, and erring towards "still pending" never invents exposure.
  const settledSeq = market ? BigInt(market.lastSettledSequence) : null;

  // Re-price on every oracle tick; the fills themselves only change when the
  // shared poller ticks. Reconstructing from a bounded ring already in memory
  // is pure CPU.
  const position = useMemo<ErPosition | null>(
    () =>
      owner && settledSeq !== null
        ? reconstruct(fillEvents, owner.toBase58(), markPrice, settledSeq)
        : null,
    [owner, fillEvents, markPrice, settledSeq]
  );

  return { position };
}
