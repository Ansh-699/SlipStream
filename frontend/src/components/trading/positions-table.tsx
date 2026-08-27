"use client";

import { erConnection } from "@/lib/connections";
import { useState } from "react";
import { useWallet, useConnection } from "@/hooks/use-wallet-compat";
import { Transaction } from "@solana/web3.js";
import { usePositions } from "@/hooks/use-positions";
import { useErPosition } from "@/hooks/use-er-position";
import { useOrderBook } from "@/hooks/use-orderbook";
import { useOpenOrders } from "@/hooks/use-open-orders";
import { useSession } from "@/hooks/use-session";
import { useTriggers } from "@/hooks/use-triggers";
import { useMarkPrice } from "@/hooks/use-mark-price";
import { useMarket } from "@/hooks/use-market";
import { PROGRAM_ID, MARKET_INDEX, LOT_SIZE, MAX_LEVERAGE } from "@/lib/manifest";
import {
  createPlaceOrderInstruction,
  createClosePositionInstruction,
  createPlaceTriggerInstruction,
  createCancelTriggerInstruction,
  TRIGGER_KIND_STOP_LOSS,
  TRIGGER_KIND_TAKE_PROFIT,
  FUNDING_SCALE,
  humanizeError,
} from "@/lib/slipstream";
import { confirmSignature } from "@/lib/confirm";
import { revalidateOrderBook } from "@/hooks/use-orderbook";

const PRICE_SCALE = 1_000_000;
// LOT_SIZE / MAX_LEVERAGE come from the Deploy_Manifest (see @/lib/manifest).
// Slippage bound on close-at-market: reject settling >1% through the current mark.
const CLOSE_SLIPPAGE_BPS = 100n;

// --t-border-strong, not --t-border: an empty SL/TP input has no label inside it
// and no fill distinct from the page, so its border IS the whole affordance, and
// --t-border measures 1.40:1 in light / 1.21:1 in dark — an invisible rectangle
// in both themes. --t-border-strong is 3.23:1 / 3.01:1, the WCAG 1.4.11 minimum
// for a control edge. Only the BASE border moves: the muted disabled: border is
// deliberate (ead59e1 set it when it dropped disabled:opacity-50, and disabled
// controls are exempt from 1.4.11), as is the decorative TriggerBadge edge below.
const BTN_UTIL =
  "h-6 px-2 rounded-[4px] text-[12px] border border-[var(--t-border-strong)] text-[var(--t-text-2)] transition-colors hover:text-[var(--t-text)] disabled:text-[var(--t-text-3)] disabled:border-[var(--t-border)] disabled:pointer-events-none disabled:cursor-not-allowed";
const INPUT =
  "h-8 w-24 px-[10px] rounded-[4px] bg-[var(--t-surface)] border border-[var(--t-border-strong)] text-[13px] tnum text-[var(--t-text)] placeholder:text-[var(--t-text-3)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]";

interface PositionsTableProps {
  /**
   * DEAD, and kept only so the parent compiles unchanged. Every figure in this
   * table is priced off `useMarkPrice(...).reference` below - the staleness-
   * gated value - precisely because the raw on-chain mark this prop carries is
   * the number S13-02 caught rendering green health on liquidatable positions.
   * Reading it here again would reintroduce that. Delete the prop and the
   * parent's argument together.
   */
  markPrice: bigint | null;
}

export function PositionsTable({}: PositionsTableProps) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  // S13-02: every per-position figure below - Mark, Liq., health, uPnL - used
  // to derive from `markPrice` with none of the staleness treatment the market
  // bar applies to the identical value 400px above. A frozen mark renders a
  // green health score on a position the program computes as liquidatable.
  // `mark` and `stampStale` are the RAW on-chain values, kept separate from
  // `reference` on purpose: `reference` is what this client should compute and
  // display with (oracle first), but close_position settles at `mark` and
  // refuses outright once the stamp ages out, so the pre-flight checks in
  // handleClose have to reason about the number the PROGRAM will use, not ours.
  const {
    reference,
    mark,
    stale: markStale,
    stampStale,
    reason: markReason,
  } = useMarkPrice(MARKET_INDEX);
  const referenceAtoms =
    reference !== null ? BigInt(Math.round(reference * PRICE_SCALE)) : null;
  // uPnL is priced off the reference too - S13-02 names it as one of the
  // figures derived from the frozen mark. Passing `markPrice` here would leave
  // the Mark column honest while the PnL beside it stayed wrong.
  const {
    positions,
    error: positionsError,
    loading: positionsLoading,
    refresh,
  } = usePositions(referenceAtoms);
  const {
    position: erPosition,
    error: erError,
    loading: erLoading,
  } = useErPosition(publicKey ?? null, referenceAtoms);
  // "not read yet" is neither "flat" nor "failed". Both halves have to have
  // answered before an empty table may be called empty.
  const positionsUnknown = positionsLoading || erLoading;
  // HEALTH-1 (funding half). Position.collateral is only debited when something
  // REALIZES the accrual - settle_trades.rs:355-384 on the next fill, or
  // claim_funding - so between those the chain carries a funding debt against
  // the position that collateral alone cannot show, and this table used to
  // ignore it entirely. liquidate_position.rs:139-158 subtracts
  // compute_funding_payment(size, cumulative_index, snapshot, mark) from the
  // health numerator, so a position with a large unclaimed debt read healthier
  // here than the keeper computed it. `market.fundingRate` is that cumulative
  // index; the per-position snapshot now comes through usePositions.
  //
  // Same shared 5s Market source useMarkPrice already subscribes to (one
  // poller per key however many components mount it), so this costs no RPC.
  // Null while that read is in flight or unreachable: an unknown debt is not a
  // zero one, and the cells render "—" rather than guess.
  const { market } = useMarket(MARKET_INDEX);
  const cumFundingIndex = market ? market.fundingRate : null;
  // Both of these select from the ONE shared order-book source (useSharedSource,
  // one 2s poller per market however many components mount it) that
  // order-book-display, status-panel, fill-toasts and useErPosition already
  // subscribe to on this page. Mounting them here costs zero extra RPC — no new
  // request, no second decode — and buys the two pre-flight checks in
  // handleFlatten that turn a silent no-op and an opaque revert into a sentence.
  const book = useOrderBook(MARKET_INDEX);
  const { orders: openOrders } = useOpenOrders(publicKey ?? null, MARKET_INDEX);
  const { state: session, status: sessionStatus, getSessionKeypair } = useSession(0);
  const { triggers, refresh: refreshTriggers } = useTriggers();
  // Market::mark_price_for_close (market.rs:173-183) only consults the freshness
  // stamp when last_mark_price > 0; at 0 it falls through to the TWAP and the
  // stamp decides nothing. `mark` is null in exactly that case (and while the
  // market read is in flight), so both terms are required - a stale stamp alone
  // is not proof the program will refuse, and blocking an exit on a guess is
  // the worse failure of the two.
  const closeRefusedByMark = stampStale && mark !== null;
  const closeRefusedTitle = `Can't close: ${markReason ?? "the on-chain mark is stale"} - close_position settles at that mark and will refuse`;
  const [flattening, setFlattening] = useState(false);
  const [flattenErr, setFlattenErr] = useState<string | null>(null);
  // An advisory is not an error. A flatten that will only partially fill is
  // still worth sending, so it must not be painted in the red the refusals use.
  const [flattenNote, setFlattenNote] = useState<string | null>(null);
  const [closeErr, setCloseErr] = useState<string | null>(null);
  const [closing, setClosing] = useState<number | null>(null);
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [slInput, setSlInput] = useState("");
  const [tpInput, setTpInput] = useState("");
  const [triggerBusy, setTriggerBusy] = useState(false);
  const [triggerErr, setTriggerErr] = useState<string | null>(null);

  // Flatten the ER (pending) position by placing an opposite-side IOC order that
  // crosses the book. This nets the position to zero at ER speed — the way to
  // close a position that hasn't settled to an L1 Position yet (close_position
  // only works on a settled, non-zero L1 position).
  const handleFlatten = async () => {
    if (!publicKey || !erPosition) return;
    if (!session.delegated) {
      setFlattenErr("Start a trading session first");
      return;
    }
    setFlattening(true);
    setFlattenErr(null);
    setFlattenNote(null);
    // Declared OUTSIDE the try because the catch reads it. Hints explain a
    // revert that may never happen, so they belong with the error, not on
    // screen ahead of it.
    const hints: string[] = [];
    try {
      // Opposite side: if currently LONG, sell (ASK); if SHORT, buy (BID).
      const closeSideVal = erPosition.isLong ? 1 : 0;
      // Round position size to a whole number of lots.
      const sizeAtoms = BigInt(Math.round(Math.abs(erPosition.size) * 1e9));
      const lots = sizeAtoms / LOT_SIZE;
      const sizeVal = lots * LOT_SIZE;
      if (sizeVal <= 0n) {
        setFlattenErr("Position smaller than one lot");
        setFlattening(false);
        return;
      }

      const sessionKp = getSessionKeypair();
      const useSessionKey = session.sessionActive && sessionKp !== null;
      const signerPk = useSessionKey ? sessionKp!.publicKey : publicKey;

      // IOC (order type 2) at a price that crosses: a marketable limit. Use a
      // wide bound off the reference price so it sweeps available depth.
      //
      // S13-04/S9-X02: this used to build the band from `markPrice` - the
      // on-chain mark - with no freshness test. A +/-5% band around a mark that
      // is 18.6% below the market does not reach the book on the buy side, so
      // "Close" on a short simply could not fill, and the only feedback was
      // whatever the RPC happened to say. `reference` is the oracle when it is
      // up and a still-fresh mark otherwise; when it is null there is no price
      // this client can honestly quote, so refuse rather than send an order
      // built on a number we know is wrong.
      if (reference === null) {
        setFlattenErr(
          markReason
            ? `No trustworthy price to close against - ${markReason}. Try again once it recovers.`
            : "No trustworthy price to close against right now."
        );
        setFlattening(false);
        return;
      }
      const crossPrice = erPosition.isLong ? reference * 0.95 : reference * 1.05;
      const priceVal = BigInt(Math.round((crossPrice / 0.001)) ) * 1000n; // tick = $0.001
      // The limit actually sent, tick-rounded. Every check below compares the
      // book against THIS, not against the pre-rounding float.
      const limitUsd = Number(priceVal) / PRICE_SCALE;
      const wantSol = Number(sizeVal) / 1e9;

      // --- Pre-flight checks, in the order the program hits them. ---
      //
      // Only ONE of them refuses to send (the empty-book check), because only
      // it is certain: an IOC that crosses nothing CONFIRMS, so there is no
      // revert for the user to read and no way to tell it apart from "not
      // updated yet". The other two describe conditions the PROGRAM decides,
      // and this client cannot reproduce its decision from here - so they warn
      // and send. A recoverable revert with a decoded message (humanizeError
      // handles every program error) beats a refusal on the exit path with no
      // override, which is the rule stated at the top of this file.
      // TWO buckets, because they have different lifetimes. `notes` describes
      // what this order WILL do and stays true after it lands (the partial-fill
      // warning). `hints` explains a revert that may not happen, so it is
      // false the moment the close succeeds - it is attached to the error in
      // the catch instead of standing on screen. They used to share one state,
      // which left "this may bounce" sitting under a position that had just
      // closed cleanly.
      const notes: string[] = [];
      //
      // FLAT-1/ORD-8. `reduceOnly` below does NOT skip the margin gate. The byte
      // is parsed and thrown away (place_order.rs:36-47, :90): it used to skip
      // the gate and the taker debit on the caller's unverifiable word that the
      // order reduced a position — the ER cannot read the L1 Position, so any
      // wallet with zero credit could drain a maker's margin into a free
      // position. Every order is now gated and debited identically. That means
      // this IOC is margined like a brand-new position: place_order.rs:220
      // charges compute_initial_margin(compute_notional(size, price), leverage)
      // against credit.available() BEFORE it matches anything, so a position
      // opened at or near max leverage cannot be flattened on the rollup at all
      // — and the revert surfaces as "Not enough trading credit ... reduce the
      // size", advice that is actively wrong for someone trying to exit.
      //
      // Priced at `priceVal`, not at `reference`: for a non-MARKET order
      // place_order.rs:173-183 takes the order's OWN limit as the reference
      // price, and this limit sits 5% either side of the reference. Same
      // divisors as compute_notional/compute_initial_margin (fixed_point.rs:53,
      // :65), so this matches the chain's gate exactly.
      //
      // A WARNING, not a refusal, and gated on sessionStatus === "live" on top
      // of that. `useSession` is a plain per-instance hook with its own 5s
      // poller - it is mounted four times on this page and only the instance
      // that ran an action refreshes eagerly - so this copy of `available` can
      // be up to 5s behind the chain even when the read succeeded. Refusing on
      // it told a user who had just cancelled an order (releasing committed
      // margin) or just funded credit that they had "$0.00" of credit they
      // demonstrably held, with nothing to click. The chain gates this for
      // real; all this text has to do is explain the revert in advance,
      // because InsufficientCredit's own message ("reduce the size") is
      // actively wrong advice for someone trying to exit.
      const needAtoms = (sizeVal * priceVal) / 1_000_000_000n / BigInt(MAX_LEVERAGE);
      if (sessionStatus === "live" && session.available < needAtoms) {
        hints.push(
          `Closing on the rollup re-posts margin - it needs $${(Number(needAtoms) / PRICE_SCALE).toFixed(2)} of free credit and your last read showed $${(Number(session.available) / PRICE_SCALE).toFixed(2)}, so this may bounce. ` +
            `If it does: add credit in the Session panel, or wait for this fill to settle and use Close on the settled row - that path posts no new margin.`
        );
      }

      // Only a "live" or "empty" ladder is a CURRENT answer about the book;
      // "loading"/"stale"/"unavailable" mean absent or frozen, and neither of
      // the two book-derived checks below may fire on those - refusing an exit
      // (or crying wolf about one) on a book we cannot currently see is worse
      // than letting the program decide. Both are fail-open by construction.
      const bookKnown = book.status === "live" || book.status === "empty";

      // FLAT-3. place_order.rs:431 rejects the WHOLE order with SelfTrade if
      // the matcher REACHES a maker slot the taker owns. Closing a long sends
      // an ASK that walks the bids, so the user's own resting BID inside this
      // limit can stop the close dead - a routine state after a partial limit
      // fill, sitting in the Open Orders panel above with nothing connecting it
      // to the failure. humanizeError's "That order would have traded against
      // your own resting order." is accurate and gives no instruction. We do
      // NOT prepend a cancel_order: killing a user's maker order on a "Close"
      // click is a money decision they did not make.
      //
      // WARN AND SEND - it may not fire at all. match_order (place_order.rs:
      // 376-431) tests the owner of the HEAD SLOT OF THE CURRENT BEST LEVEL
      // inside `while remaining > 0`, and only descends to a worse level once
      // the better ones are drained; the loop exits the moment `remaining`
      // hits 0. So a 1 SOL close that fills entirely against other makers at a
      // better price never touches the user's own order at a worse one and
      // never trips the check. And because `limitUsd` sits a full 5% off the
      // reference, essentially any resting order of theirs matched this test -
      // which bricked "Close" outright for anyone who is also a maker. A
      // cumulative-depth reachability check would be closer, but the book can
      // move between the check and execution, so it could never be a guarantee
      // either: not a thing to block an exit on.
      const blocking = bookKnown
        ? openOrders.find(
            (o) =>
              o.isLong === erPosition.isLong &&
              (erPosition.isLong ? o.price >= limitUsd : o.price <= limitUsd)
          )
        : undefined;
      if (blocking) {
        hints.push(
          `You have a resting ${blocking.isLong ? "bid" : "ask"} at $${blocking.price.toFixed(2)} inside this close's price range. If the close reaches it, the program rejects the whole order as a self-trade rather than filling around it - cancel that order in Open Orders and retry.`
        );
      }

      // ORD-5/FLAT-2. An IOC that crosses nothing CONFIRMS. The transaction
      // succeeds, the Pending row re-renders identical, and there is no error,
      // no confirmation and no way to tell "it did nothing" from "it has not
      // updated yet" - so the user clicks again, and by the block above each
      // click is a fresh fully-margined order that is likelier to bounce on
      // InsufficientCredit than to do anything.
      //
      // The depth-20 truncation is safe in both directions: whether anything
      // crosses AT ALL is decided by index 0 (buildLadders sorts bids
      // descending, asks ascending, then slices), and truncation can only make
      // `crossable` an UNDER-estimate - which is why a short book downgrades to
      // an advisory rather than a refusal.
      const crossable = (erPosition.isLong ? book.bids : book.asks)
        .filter((l) => (erPosition.isLong ? l.price >= limitUsd : l.price <= limitUsd))
        .reduce((sum, l) => sum + l.size, 0);
      if (bookKnown && crossable <= 0) {
        setFlattenErr(
          `Nothing to cross - there are no ${erPosition.isLong ? "bids" : "asks"} within 5% of $${reference.toFixed(2)}. This order would confirm and fill nothing at all. Try again once the book refills.`
        );
        setFlattening(false);
        return;
      }
      // A partial exit beats no exit, so this sends - but it says so up front
      // instead of letting the row quietly settle at a smaller size two seconds
      // later with no explanation.
      if (bookKnown && crossable < wantSol) {
        notes.push(
          `Only ${crossable.toFixed(3)} SOL of the book is within 5% of $${reference.toFixed(2)}, so this closes part of your ${wantSol.toFixed(3)} SOL and leaves the rest open.`
        );
      }
      if (notes.length > 0) setFlattenNote(notes.join(" "));

      const ix = createPlaceOrderInstruction(
        publicKey,
        MARKET_INDEX,
        {
          side: closeSideVal,
          orderType: 2, // IOC
          price: priceVal,
          size: sizeVal,
          expiryTs: 0n,
          maxSlippageBps: 0,
          // Wire-compatibility only. place_order parses this byte and ignores it
          // (place_order.rs:90 `let _reduce_only = ...`), so it changes nothing
          // about margin, the taker debit or resting behaviour - see the long
          // note above the margin pre-flight. It stays on the wire because a
          // future on-chain reduce-only path will read it.
          reduceOnly: true,
        },
        PROGRAM_ID,
        signerPk
      );

      const tx = new Transaction().add(ix);
      const erConn = erConnection;
      const { blockhash } = await erConn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      let sig: string;
      if (useSessionKey) {
        tx.feePayer = sessionKp!.publicKey;
        tx.sign(sessionKp!);
        sig = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      } else {
        tx.feePayer = publicKey;
        sig = await sendTransaction(tx, erConn, { skipPreflight: false });
      }
      await confirmSignature(erConn, sig, { timeoutMs: 30_000 });
      // Draining the position to zero leaves any SL/TP PDA armed against
      // nothing, which the leftover-trigger banner below has to be able to see
      // at once rather than up to 5s later on the trigger poll. See TRIG-1.
      refresh();
      refreshTriggers();
      // The IOC just consumed levels; re-read the shared book at once rather
      // than leaving the ladder showing depth that is already gone.
      revalidateOrderBook(MARKET_INDEX);
    } catch (err) {
      // The pre-flight hints are attached HERE rather than left standing on
      // screen: they describe a revert that may never happen, so they stop
      // being true the moment the close lands. When the revert IS one of them,
      // this is the only text saying what to do about it.
      setFlattenErr([humanizeError(err), ...hints].join(" "));
      console.error("flatten failed:", err);
    } finally {
      setFlattening(false);
    }
  };

  /**
   * Close a settled L1 position with a 1% slippage bound off the current mark
   * (closing a long sells: floor; closing a short buys back: cap). `fraction`
   * < 1 closes that share of the position, lot-rounded.
   */
  const handleClose = async (
    marketIndex: number,
    isLong: boolean,
    sizeAtoms: bigint,
    fraction: 1 | 0.5
  ) => {
    if (!publicKey) return;
    // Every sibling handler in this file has a busy flag; this one did not, so
    // the buttons stayed live through sendTransaction AND a 30s confirm. A
    // second click signed a SECOND close_position — which on a half close
    // closes twice, and on a full close reverts with a raw error.
    if (closing !== null) return;
    setClosing(marketIndex);
    setCloseErr(null);
    try {
      let closeSize = 0n; // 0 = full close
      if (fraction !== 1) {
        const lots = (sizeAtoms / 2n) / LOT_SIZE;
        closeSize = lots * LOT_SIZE;
        if (closeSize <= 0n) {
          setCloseErr("Half is smaller than one lot — use full close");
          return;
        }
      }

      // S9-X02: the slippage bound is built from the reference price, not the
      // raw on-chain mark. Bounding a close against a 16-day-old number either
      // reverts or admits a fill far outside the band the user thought they
      // set. limitPrice 0 means "no bound" to the program, so falling back to it
      // when there is no trustworthy price would silently REMOVE the user's
      // protection - refuse instead.
      if (referenceAtoms === null) {
        setCloseErr(
          markReason
            ? `No trustworthy price to bound this close - ${markReason}. Try again once it recovers.`
            : "No trustworthy price to bound this close right now."
        );
        return;
      }
      const limitPrice = isLong
        ? (referenceAtoms * (10_000n - CLOSE_SLIPPAGE_BPS)) / 10_000n
        : (referenceAtoms * (10_000n + CLOSE_SLIPPAGE_BPS)) / 10_000n;

      // CLOSE-1: run the program's own two gates here, before a wallet prompt
      // and a 30s confirm wait, because in both states close_position is
      // GUARANTEED to revert and neither revert says anything useful.
      //
      // First gate: close_position.rs:120-125 resolves the settlement price
      // through Market::mark_price_for_close, which returns None once the
      // refresh stamp ages out (market.rs:173-183) and the close fails with
      // OracleStale - which humanizeError has nothing specific to say about, so
      // every retry looks like an unexplained failure. The Mark cell is already
      // amber with this exact reason; the buttons were still fully live.
      if (closeRefusedByMark) {
        setCloseErr(
          `The on-chain mark is stale${markReason ? ` - ${markReason}` : ""}. close_position settles at that mark, so the program refuses this close until the crank catches up. Nothing was sent.`
        );
        return;
      }
      // Second gate, and the one that matters: close_position.rs:129-137
      // compares that same ON-CHAIN mark against the bound above - not the
      // oracle the bound was built from. Once the two diverge past 1% in the
      // wrong direction the mark sits outside the band and every attempt
      // reverts with SlippageExceeded, which humanizeError reports as "The book
      // moved past your slippage bound. Retry or widen it." That is a wrong
      // diagnosis (the book is not involved in close_position at all) attached
      // to advice for a control this UI does not have - and should not: settling
      // ~19% away from the oracle is precisely what the bound exists to refuse.
      const markAtoms = mark !== null ? BigInt(Math.round(mark * PRICE_SCALE)) : null;
      if (markAtoms !== null && (isLong ? markAtoms < limitPrice : markAtoms > limitPrice)) {
        setCloseErr(
          `The on-chain mark ($${mark!.toFixed(2)}) is outside the 1% bound this close sets around the oracle ($${(Number(referenceAtoms) / PRICE_SCALE).toFixed(2)}), so the program would reject it. This close settles at the mark, not on the book - wait for the crank to bring the two back in line. Nothing was sent.`
        );
        return;
      }

      const ix = createClosePositionInstruction(publicKey, marketIndex, PROGRAM_ID, {
        closeSize,
        limitPrice,
      });
      const sig = await sendTransaction(new Transaction().add(ix), connection);
      await confirmSignature(connection, sig, { timeoutMs: 30_000 });
      // A full close leaves any SL/TP PDA armed with no position under it, and
      // the row that carried the only Clear SL/TP control has just vanished.
      // Refresh the triggers with the positions so the leftover-trigger banner
      // appears on this click rather than up to 5s later. See TRIG-1.
      refresh();
      refreshTriggers();
    } catch (err) {
      setCloseErr(humanizeError(err));
      console.error("Close position failed:", err);
    } finally {
      setClosing(null);
    }
  };

  /** Place/replace SL and/or TP triggers from the expander inputs. */
  const handleSetTriggers = async (isLong: boolean) => {
    if (!publicKey) return;
    setTriggerBusy(true);
    setTriggerErr(null);
    try {
      const tx = new Transaction();
      const parse = (v: string): bigint | null => {
        const n = parseFloat(v);
        return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * PRICE_SCALE)) : null;
      };
      const sl = parse(slInput);
      const tp = parse(tpInput);
      if (sl === null && tp === null) {
        setTriggerErr("Enter a stop-loss and/or take-profit price");
        setTriggerBusy(false);
        return;
      }
      // Direction from position side: a long's SL fires below, TP above; a
      // short's the reverse.
      if (sl !== null) {
        tx.add(
          createPlaceTriggerInstruction(
            publicKey, MARKET_INDEX, TRIGGER_KIND_STOP_LOSS, !isLong, sl, PROGRAM_ID
          )
        );
      }
      if (tp !== null) {
        tx.add(
          createPlaceTriggerInstruction(
            publicKey, MARKET_INDEX, TRIGGER_KIND_TAKE_PROFIT, isLong, tp, PROGRAM_ID
          )
        );
      }
      const sig = await sendTransaction(tx, connection);
      await confirmSignature(connection, sig, { timeoutMs: 30_000 });
      setSlInput("");
      setTpInput("");
      setTriggerOpen(false);
      refreshTriggers();
    } catch (err) {
      setTriggerErr(humanizeError(err));
    } finally {
      setTriggerBusy(false);
    }
  };

  const handleCancelTrigger = async (kind: number) => {
    if (!publicKey) return;
    setTriggerBusy(true);
    setTriggerErr(null);
    try {
      const ix = createCancelTriggerInstruction(publicKey, MARKET_INDEX, kind, PROGRAM_ID);
      const sig = await sendTransaction(new Transaction().add(ix), connection);
      await confirmSignature(connection, sig, { timeoutMs: 30_000 });
      refreshTriggers();
    } catch (err) {
      setTriggerErr(humanizeError(err));
    } finally {
      setTriggerBusy(false);
    }
  };

  return (
    <div>
      <div className="h-9 flex items-center justify-between px-3 border-b border-[var(--t-border)]">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-2)]">
          Positions
        </span>
        <span className="text-[11px] text-[var(--t-text-3)] tnum">
          {/* "0 open" is a claim about the chain. When either read threw, or
              simply has not come back yet, we do not know the count, so say so
              with a dash rather than asserting flat. The ER read counts too: it
              is the half that would be carrying an unsettled, fully-levered
              fill. */}
          {(positionsError || erError || positionsUnknown) &&
          positions.length === 0 &&
          !erPosition
            ? "—"
            : `${positions.length + (erPosition ? 1 : 0)} open`}
        </span>
      </div>
      <div className="p-3">
        {positions.length === 0 && !erPosition ? (
          <div className="text-center text-xs text-[var(--t-text-2)] py-6">
            {/* Both hooks now separate a failed read from an empty one. They
                used to render identically, so a trader reloading through a
                devnet rate-limit was told they were flat while a leveraged
                position was live and moving. `erError` is the same claim about
                the pending half - with the book or the settlement cursor
                unreadable, "no pending position" is a guess, not an answer.
                A read still IN FLIGHT is the third state: on every page load
                and every drawer re-expand this branch used to announce "No
                open positions" for the length of the round trip. */}
            {!publicKey
              ? "Sign in to see your positions"
              : positionsUnknown
                ? "Checking your positions…"
                : positionsError || erError
                  ? "Can't reach Solana — positions unknown, retrying"
                  : "No open positions"}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-[11px] text-[var(--t-text-3)] border-b border-[var(--t-surface-2)]">
                {/* Six columns, not eight. Entry and Mark are read as one
                    comparison, and Liq. is meaningless without the health beside
                    it, so each pair shares a cell and stacks. Same figures, same
                    honest empty states — fewer things to scan. */}
                <th className="h-[26px] px-2 text-left font-normal">Position</th>
                <th className="h-[26px] px-2 text-right font-normal">Size</th>
                <th className="h-[26px] px-2 text-right font-normal">Entry / Mark</th>
                <th className="h-[26px] px-2 text-right font-normal">Liq. / Health</th>
                <th className="h-[26px] px-2 text-right font-normal">uPnL</th>
                <th className="h-[26px]"></th>
              </tr>
            </thead>
            <tbody>
              {/* ER (pending-settlement) position — filled on the rollup, not yet
                  settled to an L1 Position. Reconstructed from the ER fill queue. */}
              {erPosition && (
                <tr className="h-[42px] text-[11.5px] border-b border-[var(--t-surface-2)] last:border-b-0 hover:bg-[var(--t-surface-3)]">
                  <td className="px-2 text-left">
                    <div className="flex flex-col gap-0.5 leading-tight">
                      <span className="font-semibold text-[var(--t-text)]">SOL-PERP</span>
                      <span className="inline-flex items-center gap-1.5">
                        <SideBadge isLong={erPosition.isLong} />
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--t-warn)]">
                          <span className="h-1 w-1 rounded-full bg-[var(--t-warn)] animate-pulse" />
                          Pending
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className={`px-2 text-right tnum ${erPosition.isLong ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>
                    {Math.abs(erPosition.size).toFixed(3)}
                  </td>
                  {/* Entry over Mark. Mark keeps its own staleness colour and
                      reason tooltip — pairing them must not make the live half
                      inherit the entry's certainty. */}
                  <td className="px-2 text-right">
                    <div className="flex flex-col gap-0.5 leading-tight">
                      <span className="tnum text-[var(--t-text)]">
                        ${erPosition.entryPrice.toFixed(2)}
                      </span>
                      <span
                        className={`tnum ${markStale ? "text-[var(--t-warn)]" : "text-[var(--t-text-2)]"}`}
                        title={markStale && markReason ? markReason : undefined}
                      >
                        {reference !== null ? `${reference.toFixed(2)}` : "—"}
                      </span>
                    </div>
                  </td>
                  {(() => {
                    const mk = reference;
                    const { liq, health } = liqAndHealth(
                      erPosition.isLong,
                      Math.abs(erPosition.size),
                      erPosition.entryPrice,
                      mk,
                      erPosition.collateral,
                      // 0, and it is exact rather than a stand-in: this position
                      // has not settled, so no Position account carries a
                      // funding snapshot for it yet. settle_trades.rs:385 stamps
                      // the snapshot at the CURRENT cumulative index as it
                      // creates the position, so no funding can have accrued
                      // against these fills before then.
                      0
                    );
                    return (
                      <td className="px-2 text-right">
                        <div className="flex flex-col items-end gap-0.5 leading-tight">
                          <span className="tnum text-[var(--t-warn)]">
                            {liq !== null ? `${liq.toFixed(2)}` : "—"}
                          </span>
                          <HealthCell health={health} />
                        </div>
                      </td>
                    );
                  })()}
                  {/* PNL-1/ERPNL-1: the className branches on null as well as
                      the text. `null >= 0` is TRUE in JS, so testing only the
                      sign paints a GREEN em dash - a confident profit colour on
                      the cell that is admitting it has no number. */}
                  <td
                    className={`text-right tnum ${
                      erPosition.unrealizedPnl === null
                        ? "text-[var(--t-text-3)]"
                        : erPosition.unrealizedPnl >= 0
                          ? "text-[var(--t-up)]"
                          : "text-[var(--t-down)]"
                    }`}
                  >
                    {erPosition.unrealizedPnl === null
                      ? "—"
                      : fmtSignedUsd(erPosition.unrealizedPnl)}
                  </td>
                  <td className="px-2 text-right">
                    <button
                      onClick={handleFlatten}
                      disabled={flattening}
                      className={`${BTN_UTIL} bg-[var(--t-surface)]`}
                      title="Close by placing an opposite IOC order on the ER"
                    >
                      {flattening ? "…" : "Close"}
                    </button>
                  </td>
                </tr>
              )}
              {positions.map((pos, i) => {
                const size = Number(pos.size < 0n ? -pos.size : pos.size) / 1e9;
                const sizeAtoms = pos.size < 0n ? -pos.size : pos.size;
                return (
                  <tr key={i} className="h-[42px] text-[11.5px] border-b border-[var(--t-surface-2)] last:border-b-0 hover:bg-[var(--t-surface-3)]">
                    <td className="px-2 text-left">
                      <div className="flex flex-col gap-0.5 leading-tight">
                        <span className="font-semibold text-[var(--t-text)]">SOL-PERP</span>
                      <span className="inline-flex items-center gap-1.5">
                        <SideBadge isLong={pos.isLong} />
                        {(triggers.stopLoss || triggers.takeProfit) && (
                          <span className="inline-flex items-center gap-1">
                            {triggers.stopLoss && (
                              <TriggerBadge
                                label="SL"
                                price={Number(triggers.stopLoss.triggerPrice) / PRICE_SCALE}
                                tone="rose"
                              />
                            )}
                            {triggers.takeProfit && (
                              <TriggerBadge
                                label="TP"
                                price={Number(triggers.takeProfit.triggerPrice) / PRICE_SCALE}
                                tone="emerald"
                              />
                            )}
                          </span>
                        )}
                      </span>
                      </div>
                    </td>
                    <td className={`px-2 text-right tnum ${pos.size > 0n ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>
                      {size.toFixed(3)}
                    </td>
                    <td className="px-2 text-right">
                      <div className="flex flex-col gap-0.5 leading-tight">
                        <span className="tnum text-[var(--t-text)]">
                          ${(Number(pos.entryPrice) / PRICE_SCALE).toFixed(2)}
                        </span>
                        <span
                          className={`tnum ${markStale ? "text-[var(--t-warn)]" : "text-[var(--t-text-2)]"}`}
                          title={markStale && markReason ? markReason : undefined}
                        >
                          {reference !== null ? `${reference.toFixed(2)}` : "—"}
                        </span>
                      </div>
                    </td>
                    {(() => {
                      const mk = reference;
                      // The dimensionless rate compute_funding_payment applies
                      // to signed notional: (cumulative_index - snapshot) /
                      // FUNDING_SCALE, both 18-dp i128 (funding.rs:76-98).
                      const fundingRate =
                        cumFundingIndex === null
                          ? null
                          : Number(cumFundingIndex - pos.fundingIndexSnapshot) /
                            Number(FUNDING_SCALE);
                      const { liq, health } = liqAndHealth(
                        pos.isLong,
                        size,
                        Number(pos.entryPrice) / PRICE_SCALE,
                        mk,
                        Number(pos.collateral) / PRICE_SCALE,
                        fundingRate
                      );
                      return (
                        <td className="px-2 text-right">
                          <div className="flex flex-col items-end gap-0.5 leading-tight">
                            <span className="tnum text-[var(--t-warn)]">
                              {liq !== null ? `${liq.toFixed(2)}` : "—"}
                            </span>
                            <HealthCell health={health} />
                          </div>
                        </td>
                      );
                    })()}
                    {/* Same null-before-sign branch as the ER row above, and
                        for the same reason: `null >= 0` is true, so a text-only
                        patch yields a green em dash. */}
                    <td
                      className={`text-right tnum ${
                        pos.unrealizedPnl === null
                          ? "text-[var(--t-text-3)]"
                          : pos.unrealizedPnl >= 0
                            ? "text-[var(--t-up)]"
                            : "text-[var(--t-down)]"
                      }`}
                    >
                      {pos.unrealizedPnl === null
                        ? "—"
                        : fmtSignedUsd(pos.unrealizedPnl)}
                    </td>
                    <td className="px-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => setTriggerOpen((v) => !v)}
                          className={`${BTN_UTIL} ${triggerOpen ? "bg-[var(--t-surface-3)] text-[var(--t-text)]" : "bg-[var(--t-surface)]"}`}
                          title="Set stop-loss / take-profit"
                        >
                          SL/TP
                        </button>
                        {/* Disabled on a stale stamp because close_position
                            settles at the on-chain mark and refuses outright
                            when Market::mark_price_for_close returns None - the
                            click could only ever cost a signature and a 30s
                            wait for an OracleStale nobody can act on. The
                            divergence gate is NOT wired into `disabled`: it is
                            side-dependent (it blocks a long and a short at
                            opposite ends of the same divergence), so it stays a
                            pre-flight refusal in handleClose that names which
                            way the mark has moved. */}
                        <button
                          onClick={() => handleClose(pos.marketIndex, pos.isLong, sizeAtoms, 0.5)}
                          disabled={closing !== null || closeRefusedByMark}
                          className={`${BTN_UTIL} bg-[var(--t-surface)]`}
                          title={
                            closeRefusedByMark
                              ? closeRefusedTitle
                              : "Close half the position (lot-rounded, 1% slippage bound)"
                          }
                        >
                          {closing === pos.marketIndex ? "…" : "½"}
                        </button>
                        <button
                          onClick={() => handleClose(pos.marketIndex, pos.isLong, sizeAtoms, 1)}
                          disabled={closing !== null || closeRefusedByMark}
                          className={`${BTN_UTIL} bg-[var(--t-surface)]`}
                          title={
                            closeRefusedByMark
                              ? closeRefusedTitle
                              : "Close at mark (1% slippage bound)"
                          }
                        >
                          {closing === pos.marketIndex ? "…" : "Close"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {/* SL/TP expander: one trigger pair per market (matches the
                  per-owner-per-market Position + TriggerOrder PDAs). */}
              {triggerOpen && positions.length > 0 && (
                <tr className="border-b border-[var(--t-surface-2)] last:border-b-0">
                  <td colSpan={6} className="py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1.5 text-[11px] text-[var(--t-text-2)]">
                        Stop-loss $
                        <input
                          value={slInput}
                          onChange={(e) => setSlInput(e.target.value)}
                          placeholder={triggers.stopLoss ? (Number(triggers.stopLoss.triggerPrice) / PRICE_SCALE).toFixed(2) : "price"}
                          inputMode="decimal"
                          className={INPUT}
                        />
                      </label>
                      <label className="flex items-center gap-1.5 text-[11px] text-[var(--t-text-2)]">
                        Take-profit $
                        <input
                          value={tpInput}
                          onChange={(e) => setTpInput(e.target.value)}
                          placeholder={triggers.takeProfit ? (Number(triggers.takeProfit.triggerPrice) / PRICE_SCALE).toFixed(2) : "price"}
                          inputMode="decimal"
                          className={INPUT}
                        />
                      </label>
                      <button
                        onClick={() => handleSetTriggers(positions[0].isLong)}
                        disabled={triggerBusy}
                        className="h-7 px-3 rounded-[6px] text-[13px] font-semibold bg-[var(--t-up-3)] text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)] disabled:bg-[var(--t-surface-3)] disabled:text-[var(--t-text-2)] disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]"
                      >
                        {triggerBusy ? "…" : "Set"}
                      </button>
                      {triggers.stopLoss && (
                        <button
                          onClick={() => handleCancelTrigger(TRIGGER_KIND_STOP_LOSS)}
                          disabled={triggerBusy}
                          className={`${BTN_UTIL} bg-[var(--t-surface)]`}
                        >
                          Clear SL
                        </button>
                      )}
                      {triggers.takeProfit && (
                        <button
                          onClick={() => handleCancelTrigger(TRIGGER_KIND_TAKE_PROFIT)}
                          disabled={triggerBusy}
                          className={`${BTN_UTIL} bg-[var(--t-surface)]`}
                        >
                          Clear TP
                        </button>
                      )}
                      <span className="text-[11px] text-[var(--t-text-3)]">
                        Executed by keepers when the mark price crosses — works even if you close this tab.
                      </span>
                    </div>
                    {triggerErr && (
                      <div className="pt-2 text-[11px] text-[var(--t-down)] break-all">{triggerErr}</div>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {/* TRIG-1: the ONLY Clear SL / Clear TP controls live inside the SL/TP
            expander, and that expander is gated on `positions.length > 0`. A
            full close (or a flatten that drains the ER position to zero) makes
            the row vanish and takes the controls with it - while the TriggerOrder
            PDA stays armed. execute_trigger.rs:63-72 never checks that the
            trigger's guarded side matches the position it closes, so the next
            position the user opens, on EITHER side, gets force-closed by a stop
            they set for a position that no longer exists and could not cancel.
            This block deliberately lives OUTSIDE the table/empty-state ternary
            so it renders in both branches; the expander's own gate is left
            alone because widening it drags in the `positions[0].isLong` read.
            Suppressed while `positionsError` is set, and while either read is
            still in flight: "no position open" is a claim about the chain, and
            neither a read that threw nor one that has not answered is that
            answer. */}
        {positions.length === 0 && !positionsError && !positionsUnknown && (triggers.stopLoss || triggers.takeProfit) && (
          <div className="pt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--t-warn)]">
            <span>
              {erPosition
                ? "Trigger armed with no settled position yet — it will fire against this position once it settles."
                : "Leftover trigger — with no position open it will close whichever position you open next, on either side."}
            </span>
            {triggers.stopLoss && (
              <button
                onClick={() => handleCancelTrigger(TRIGGER_KIND_STOP_LOSS)}
                disabled={triggerBusy}
                className={`${BTN_UTIL} bg-[var(--t-surface)]`}
              >
                Clear SL
              </button>
            )}
            {triggers.takeProfit && (
              <button
                onClick={() => handleCancelTrigger(TRIGGER_KIND_TAKE_PROFIT)}
                disabled={triggerBusy}
                className={`${BTN_UTIL} bg-[var(--t-surface)]`}
              >
                Clear TP
              </button>
            )}
            {triggerErr && (
              <span className="text-[var(--t-down)] break-all">{triggerErr}</span>
            )}
          </div>
        )}
        {/* Last-good rows kept through a failed read are not current rows. */}
        {positionsError && positions.length > 0 && (
          <div className="pt-2 text-[11px] text-[var(--t-warn)]">
            Can&apos;t reach Solana — these rows may be out of date, retrying.
          </div>
        )}
        {flattenErr && (
          <div className="pt-2 text-[11px] text-[var(--t-down)] break-all">{flattenErr}</div>
        )}
        {/* Shown ALONGSIDE an error, not instead of it: the two pre-flights
            that used to refuse now warn and send, so when the revert is one of
            them this line is the only text saying what to do - the decoded
            InsufficientCredit ("reduce the size") is wrong advice on an exit.
            handleFlatten clears both at the top of every attempt, so a note is
            never left over from a previous one. */}
        {flattenNote && (
          <div className="pt-2 text-[11px] text-[var(--t-warn)] break-all">{flattenNote}</div>
        )}
        {closeErr && (
          <div className="pt-2 text-[11px] text-[var(--t-down)] break-all">{closeErr}</div>
        )}
      </div>
    </div>
  );
}

/** Format a signed USD value with the sign BEFORE the dollar sign, e.g.
 *  -$0.44 / +$1.20 (not "$-0.44"). */
function fmtSignedUsd(v: number): string {
  const sign = v < 0 ? "-" : "+";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function SideBadge({ isLong }: { isLong: boolean }) {
  return (
    <span
      className={`text-[11px] font-semibold tracking-wide ${
        isLong ? "text-[var(--t-up)]" : "text-[var(--t-down)]"
      }`}
    >
      {isLong ? "LONG" : "SHORT"}
    </span>
  );
}

/**
 * Liquidation price + health factor, mirroring what the liquidator actually
 * computes (liquidate_position.rs:133-158):
 *
 *   notional    = size * MARK            (compute_notional - the mark, not entry)
 *   initial     = notional / leverage    (compute_initial_margin)
 *   maintenance = initial / 2            (compute_maintenance_margin)
 *   health      = (collateral + uPnL - funding) / maintenance
 *
 * This used to discard the position's collateral entirely and put the DERIVED
 * initial margin in the numerator instead, i.e. it computed
 * (notional/leverage) / (notional/leverage/2), which is 2.00 for any position
 * with zero uPnL no matter what collateral it actually holds. A long whose
 * collateral had been drained from $7.50 to $3.50 by a stretch of positive
 * funding therefore rendered 2.00 in full green - a full bar and "$3.75 of
 * room" - while the chain computed 3.50/3.75 = 0.93 and the keeper's next pass
 * liquidated it. The user was liquidated off a screen showing maximum health.
 *
 * The collateral is still not trusted OUTRIGHT, which is what the discarded
 * comment was protecting: both rows' collateral accumulates from the same
 * `filled_margin`, and fills stamped under the pre-fix (1000x) margin scale
 * make it read in the hundreds, pushing health into the hundreds and the liq
 * price negative. So it is used as a conservative FLOOR - min(collateral,
 * derived). A legacy-inflated value falls back to the derived estimate exactly
 * as before, while a funding-drained value (always smaller) is honoured, and
 * neither can overstate health.
 *
 * Accrued funding IS subtracted, which is the other half of the same failure.
 * The collateral floor above only covers the case where something has already
 * realized the debt out of collateral (claim_funding, or settle_trades on the
 * next fill); between those the debt is unclaimed, collateral is untouched, and
 * the position read healthier here than the keeper computed it. `fundingRate`
 * is (Market.cumulative_funding_index - Position.funding_index_snapshot) /
 * FUNDING_SCALE - the dimensionless rate compute_funding_payment (funding.rs:
 * 66-101) applies to SIGNED notional, so a long pays a positive delta and a
 * short receives it, and it is subtracted from the numerator exactly as
 * liquidate_position.rs:153-158 does (it passes -funding_payment into
 * compute_health_factor, which adds it).
 *
 * `mark` is the reference price (oracle first), not Market::last_mark_price, so
 * these figures track the market rather than the crank - deliberate, and the
 * same choice the Mark column beside them makes.
 *
 * Inputs are human units: sizeSol (SOL), entry/mark (USD), collateral (USD).
 */
/**
 * `mark` is nullable ON PURPOSE. It used to be called with `reference ?? 0`,
 * and at mark = 0 the uPnL term below inverts: a SHORT reads
 * uPnl = +entry*size, health enormous, and HealthCell paints a full green bar
 * on a position the program may consider liquidatable. A LONG reads the
 * mirror image and looks about to be liquidated. Both are fabrications from a
 * price the rest of this component correctly refuses to quote — the Mark
 * column two cells left already renders "—" in the same state.
 */
function liqAndHealth(
  isLong: boolean,
  sizeSol: number,
  entry: number,
  mark: number | null,
  collateral: number,
  // Nullable for the same reason `mark` is: without the Market's cumulative
  // funding index the position's unclaimed debt is UNKNOWN, and an unknown debt
  // rendered as zero is the overstatement this parameter exists to remove.
  fundingRate: number | null
): { liq: number | null; health: number | null } {
  if (sizeSol <= 0 || entry <= 0) return { liq: null, health: null };
  if (mark === null || mark <= 0) return { liq: null, health: null };
  if (fundingRate === null) return { liq: null, health: null };

  const notional = sizeSol * mark;
  const derivedMargin = notional / MAX_LEVERAGE;
  const maintMargin = derivedMargin / 2;
  if (maintMargin <= 0) return { liq: null, health: null };
  // No `collateral > 0 ?` guard in front of this. Zero is a DECODED value, not
  // a missing one: claim_funding.rs:90-97 and settle_trades.rs:370-376 both
  // saturating_sub a funding shortfall out of Position.collateral, flooring it
  // at 0 while size stays open. Treating that 0 as "no figure" and falling back
  // to the derived margin prints health 2.00 in green on a position the keeper
  // computes at 0 (compute_health_factor returns 0 for net_margin <= 0) and
  // liquidates on its next pass - the exact failure the block above describes,
  // one dollar short of the worst state.
  const margin = Math.min(collateral, derivedMargin);

  const uPnl = (isLong ? mark - entry : entry - mark) * sizeSol;
  // Positive = the position PAYS, so it comes OFF the numerator. Signed
  // notional, not |notional|: that sign is the whole of funding's direction
  // (funding.rs:87-94), and dropping it would credit longs with the debt shorts
  // owe them.
  const funding = (isLong ? notional : -notional) * fundingRate;
  const health = (margin + uPnl - funding) / maintMargin;

  // Liquidation price: solve health(P) = 1 for P. Because maintenance margin is
  // itself a function of the mark, the old fixed "buffer" form no longer
  // matches this health number - and a liq price that disagrees with the health
  // factor printed next to it is the defect this whole function is fixing.
  // Funding is a function of the mark too (it is a rate on notional), so it has
  // to be solved WITH it rather than held constant at today's price. With
  // q = +size for a long / -size for a short and k = size / (2*leverage):
  //   margin + q*(P - entry) - q*P*rate = |q| * P / (2*leverage)
  //   P = (q*entry - margin) / (q*(1 - rate) - k)
  // which is the pair below (the short form is that expression multiplied
  // through by -1). At rate = 0 both collapse to the previous formula.
  // (size - k) is size * (1 - 1/(2*leverage)), positive for any leverage >= 1;
  // the (1 - rate) factor only perturbs it, and a degenerate denominator falls
  // out through the isFinite/positive filter below.
  const k = sizeSol / (2 * MAX_LEVERAGE);
  const qAdj = sizeSol * (1 - fundingRate);
  const liq = isLong
    ? (sizeSol * entry - margin) / (qAdj - k)
    : (sizeSol * entry + margin) / (qAdj + k);

  return { liq: Number.isFinite(liq) && liq > 0 ? liq : null, health };
}

function HealthCell({ health }: { health: number | null }) {
  if (health === null) return <span className="text-[var(--t-text-3)]">—</span>;
  const color =
    health >= 2 ? "text-[var(--t-up)]" : health >= 1.3 ? "text-[var(--t-warn)]" : "text-[var(--t-down)]";
  const bar =
    health >= 2 ? "bg-[var(--t-up)]" : health >= 1.3 ? "bg-[var(--t-warn)]" : "bg-[var(--t-down)]";
  // Margin meter: health 0 (liquidation) .. 3+ (full bar).
  const pct = Math.max(0, Math.min(100, (health / 3) * 100));
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span className={`tnum ${color}`}>{health.toFixed(2)}</span>
      <span className="block w-10 h-[2px] bg-[var(--t-border)] overflow-hidden">
        <span className={`block h-full ${bar}`} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

function TriggerBadge({ label, price, tone }: { label: string; price: number; tone: "rose" | "emerald" }) {
  const cls = tone === "rose" ? "text-[var(--t-down)]" : "text-[var(--t-up)]";
  return (
    <span className={`inline-flex items-center gap-0.5 px-1 rounded-[3px] bg-[var(--t-surface)] border border-[var(--t-border)] text-[10px] font-semibold tracking-wide ${cls}`}>
      {label} <span className="tnum">${price.toFixed(2)}</span>
    </span>
  );
}
