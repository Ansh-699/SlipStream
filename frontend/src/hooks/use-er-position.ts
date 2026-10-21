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
  /** Mark-to-market unrealized PnL at the current mark (USD), or null when
   *  there is no trustworthy price to mark against — see `markPrice` below. */
  unrealizedPnl: number | null;
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

/** The replayed fills, before pricing: everything except unrealized PnL. */
interface Replayed {
  size: bigint; // signed, base atoms
  entry: bigint; // 6-dp price
  collateral: bigint; // 6-dp
  realized: bigint; // 6-dp
  count: number;
}

/**
 * Replay the owner's fills (as maker or taker) in sequence order, applying the
 * SAME position-update logic as the on-chain settle_trades. The result is the
 * net position the user holds on the ER right now.
 *
 * Deliberately NOT a function of the mark price. It walks the whole 4,096-entry
 * fill ring, and it used to be re-run inside the same memo that priced it -- so
 * every oracle tick (the live feed pushes ~20/s) replayed the entire ring and
 * base58-encoded two keys per fill: ~35 ms of main thread each time, measured
 * against the live devnet book, i.e. most of a core spent re-deriving a
 * position that had not changed. Replay now runs only when the fills, the owner
 * or the settlement cursor change; pricing is the cheap step below.
 */
function replay(
  fills: FillEvent[],
  owner: PublicKey,
  // The L1 settlement cursor. NOT optional and NOT defaultable to 0n: see the
  // note on `settledSeq` in the hook below. Callers that cannot read it must
  // not call this function at all.
  lastSettledSequence: bigint
): Replayed | null {
  // Sort by sequence ascending so VWAP / reductions apply in match order.
  // Fills at or below the L1 settlement cursor are already reflected in the
  // real Position account — replaying them here would double-count an
  // already-settled position as still "pending".
  const ordered = fills
    .filter((f) => f.quantity > 0n && f.sequence > lastSettledSequence)
    .sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0));

  let size = 0n; // signed, base atoms
  let entry = 0n; // 6-dp price
  let collateral = 0n; // 6-dp
  let realized = 0n; // 6-dp
  let count = 0;

  for (const f of ordered) {
    // Byte comparison, not base58: toBase58() twice per fill was the bulk of
    // this loop's cost.
    const isMaker = f.maker.equals(owner);
    const isTaker = f.taker.equals(owner);
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
  return { size, entry, collateral, realized, count };
}

function price(
  r: Replayed,
  // Nullable deliberately: priced at 0n the pnl() below returns a large
  // fabricated number that renders green or red by sign, next to a Mark column
  // that correctly shows "—". No price means no PnL, not a free one.
  markPrice: bigint | null
): ErPosition {
  const up = markPrice === null ? null : pnl(r.size, r.entry, markPrice);
  // `up` stays null all the way to the cell. It used to be handed to
  // `Number(null)`, which is 0, so the row painted a green "+$0.00" in the one
  // money cell while Mark, Liq. and Health beside it honestly rendered "—".
  // The render site branches its className on null as well as its text: the
  // colour test was `unrealizedPnl >= 0` and `null >= 0` is true in JS, which
  // would have produced a green em dash.
  return {
    isLong: r.size > 0n,
    size: Number(r.size) / 1e9,
    entryPrice: Number(r.entry) / PRICE_SCALE,
    collateral: Number(r.collateral) / PRICE_SCALE,
    realizedPnl: Number(r.realized) / PRICE_SCALE,
    unrealizedPnl: up === null ? null : Number(up) / PRICE_SCALE,
    fillCount: r.count,
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
  const { market, status: marketStatus } = useMarket(marketIndex);
  const { fillEvents, status: bookStatus } = useOrderBook(marketIndex);

  // The settlement cursor, or null when we do not have one.
  //
  // This used to be best-effort — an unreachable Market meant a cursor of 0n,
  // which reads as "nothing has ever settled". That is not a conservative
  // default, it is the most destructive possible value: replay() keeps
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

  // Replay only when the fills, the owner or the cursor change (the shared
  // feed keeps `fillEvents` referentially stable while the ring is untouched);
  // re-price on every oracle tick, which is a handful of bigint ops.
  const ownerKey = owner?.toBase58() ?? null;
  const replayed = useMemo<Replayed | null>(
    () =>
      ownerKey !== null && settledSeq !== null
        ? replay(fillEvents, new PublicKey(ownerKey), settledSeq)
        : null,
    [ownerKey, fillEvents, settledSeq]
  );
  const position = useMemo<ErPosition | null>(
    () => (replayed ? price(replayed, markPrice) : null),
    [replayed, markPrice]
  );

  // POS-1. `position === null` has two causes that must not render alike: "you
  // hold nothing pending" and "we could not read the fills or the settlement
  // cursor at all". Only the second is an error, and this hook no longer has a
  // catch of its own to raise it from — it is a pure selection over two shared
  // sources, so the error has to come from them. "unavailable" is the one
  // status on either source that means unreachable AND nothing cached; "stale"
  // still carries a last-good answer and "loading"/"missing" are answers of
  // their own.
  const error = marketStatus === "unavailable" || bookStatus === "unavailable";
  // The third cause of `position === null`: neither source has answered yet.
  // `settledSeq` is null for the whole of the Market read, so this hook returns
  // null-and-no-error while it knows nothing at all, which the panel renders as
  // "No open positions". Same word both shared sources already use.
  const loading = marketStatus === "loading" || bookStatus === "loading";

  return { position, error, loading };
}
