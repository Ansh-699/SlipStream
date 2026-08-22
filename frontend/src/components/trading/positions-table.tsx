"use client";

import { useState } from "react";
import { useWallet, useConnection } from "@/hooks/use-wallet-compat";
import { Connection, Transaction } from "@solana/web3.js";
import { usePositions } from "@/hooks/use-positions";
import { useErPosition } from "@/hooks/use-er-position";
import { useSession } from "@/hooks/use-session";
import { useTriggers } from "@/hooks/use-triggers";
import { useMarkPrice } from "@/hooks/use-mark-price";
import { PROGRAM_ID, MARKET_INDEX, ER_RPC, LOT_SIZE, MAX_LEVERAGE } from "@/lib/manifest";
import {
  createPlaceOrderInstruction,
  createClosePositionInstruction,
  createPlaceTriggerInstruction,
  createCancelTriggerInstruction,
  TRIGGER_KIND_STOP_LOSS,
  TRIGGER_KIND_TAKE_PROFIT,
} from "@/lib/slipstream";
import { confirmSignature } from "@/lib/confirm";

const PRICE_SCALE = 1_000_000;
// LOT_SIZE / MAX_LEVERAGE come from the Deploy_Manifest (see @/lib/manifest).
// Slippage bound on close-at-market: reject settling >1% through the current mark.
const CLOSE_SLIPPAGE_BPS = 100n;

const BTN_UTIL =
  "h-6 px-2 rounded-[4px] text-[12px] border border-[var(--t-border)] text-[var(--t-text-2)] transition-colors hover:text-[var(--t-text)] disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed";
const INPUT =
  "h-8 w-24 px-[10px] rounded-[4px] bg-[var(--t-surface)] border border-[var(--t-border)] text-[13px] tnum text-[var(--t-text)] placeholder:text-[var(--t-text-3)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]";

interface PositionsTableProps {
  markPrice: bigint | null;
}

export function PositionsTable({ markPrice }: PositionsTableProps) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  // S13-02: every per-position figure below - Mark, Liq., health, uPnL - used
  // to derive from `markPrice` with none of the staleness treatment the market
  // bar applies to the identical value 400px above. A frozen mark renders a
  // green health score on a position the program computes as liquidatable.
  const { reference, stale: markStale, reason: markReason } = useMarkPrice(MARKET_INDEX);
  const referenceAtoms =
    reference !== null ? BigInt(Math.round(reference * PRICE_SCALE)) : null;
  // uPnL is priced off the reference too - S13-02 names it as one of the
  // figures derived from the frozen mark. Passing `markPrice` here would leave
  // the Mark column honest while the PnL beside it stayed wrong.
  const { positions, refresh } = usePositions(referenceAtoms);
  const { position: erPosition } = useErPosition(publicKey ?? null, referenceAtoms);
  const { state: session, getSessionKeypair } = useSession(0);
  const { triggers, refresh: refreshTriggers } = useTriggers();
  const [flattening, setFlattening] = useState(false);
  const [flattenErr, setFlattenErr] = useState<string | null>(null);
  const [closeErr, setCloseErr] = useState<string | null>(null);
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
          reduceOnly: true, // closing a position — skip margin gate, no new credit
        },
        PROGRAM_ID,
        signerPk
      );

      const tx = new Transaction().add(ix);
      const erConn = new Connection(ER_RPC, "confirmed");
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
      refresh();
    } catch (err) {
      setFlattenErr(err instanceof Error ? err.message : String(err));
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

      const ix = createClosePositionInstruction(publicKey, marketIndex, PROGRAM_ID, {
        closeSize,
        limitPrice,
      });
      const sig = await sendTransaction(new Transaction().add(ix), connection);
      await confirmSignature(connection, sig, { timeoutMs: 30_000 });
      refresh();
    } catch (err) {
      setCloseErr(err instanceof Error ? err.message : String(err));
      console.error("Close position failed:", err);
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
      setTriggerErr(err instanceof Error ? err.message : String(err));
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
      setTriggerErr(err instanceof Error ? err.message : String(err));
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
          {positions.length + (erPosition ? 1 : 0)} open
        </span>
      </div>
      <div className="p-3">
        {positions.length === 0 && !erPosition ? (
          <div className="text-center text-xs text-[var(--t-text-2)] py-6">
            {publicKey ? "No open positions" : "Sign in to see your positions"}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-[11px] text-[var(--t-text-3)] border-b border-[var(--t-surface-2)]">
                <th className="h-[26px] px-2 text-left font-normal">Side</th>
                <th className="h-[26px] px-2 text-right font-normal">Size</th>
                <th className="h-[26px] px-2 text-right font-normal">Entry</th>
                <th className="h-[26px] px-2 text-right font-normal">Mark</th>
                <th className="h-[26px] px-2 text-right font-normal">Liq.</th>
                <th className="h-[26px] px-2 text-right font-normal">Health</th>
                <th className="h-[26px] px-2 text-right font-normal">uPnL</th>
                <th className="h-[26px]"></th>
              </tr>
            </thead>
            <tbody>
              {/* ER (pending-settlement) position — filled on the rollup, not yet
                  settled to an L1 Position. Reconstructed from the ER fill queue. */}
              {erPosition && (
                <tr className="h-7 text-[11.5px] border-b border-[var(--t-surface-2)] last:border-b-0 hover:bg-[var(--t-surface)]">
                  <td className="px-2 text-left">
                    <span className="inline-flex items-center gap-2">
                      <SideBadge isLong={erPosition.isLong} />
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--t-warn)]">
                        <span className="h-1 w-1 rounded-full bg-[var(--t-warn)] animate-pulse" />
                        Pending
                      </span>
                    </span>
                  </td>
                  <td className={`text-right tnum ${erPosition.isLong ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>
                    {Math.abs(erPosition.size).toFixed(3)}
                  </td>
                  <td className="px-2 text-right tnum text-[var(--t-text)]">
                    ${erPosition.entryPrice.toFixed(2)}
                  </td>
                  <td
                    className={`px-2 text-right tnum ${markStale ? "text-[var(--t-warn)]" : "text-[var(--t-text)]"}`}
                    title={markStale && markReason ? markReason : undefined}
                  >
                    {reference !== null ? `$${reference.toFixed(2)}` : "—"}
                  </td>
                  {(() => {
                    const mk = reference ?? 0;
                    const { liq, health } = liqAndHealth(
                      erPosition.isLong,
                      Math.abs(erPosition.size),
                      erPosition.entryPrice,
                      mk,
                      erPosition.collateral
                    );
                    return (
                      <>
                        <td className="px-2 text-right tnum text-[var(--t-warn)]">
                          {liq !== null ? `$${liq.toFixed(2)}` : "—"}
                        </td>
                        <td className="px-2 text-right">
                          <HealthCell health={health} />
                        </td>
                      </>
                    );
                  })()}
                  <td className={`text-right tnum ${erPosition.unrealizedPnl >= 0 ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>
                    {fmtSignedUsd(erPosition.unrealizedPnl)}
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
                  <tr key={i} className="h-7 text-[11.5px] border-b border-[var(--t-surface-2)] last:border-b-0 hover:bg-[var(--t-surface)]">
                    <td className="px-2 text-left">
                      <span className="inline-flex items-center gap-2">
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
                    </td>
                    <td className={`text-right tnum ${pos.size > 0n ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>
                      {size.toFixed(3)}
                    </td>
                    <td className="px-2 text-right tnum text-[var(--t-text)]">
                      ${(Number(pos.entryPrice) / PRICE_SCALE).toFixed(2)}
                    </td>
                    <td
                      className={`px-2 text-right tnum ${markStale ? "text-[var(--t-warn)]" : "text-[var(--t-text)]"}`}
                      title={markStale && markReason ? markReason : undefined}
                    >
                      {reference !== null ? `$${reference.toFixed(2)}` : "—"}
                    </td>
                    {(() => {
                      const mk = reference ?? 0;
                      const { liq, health } = liqAndHealth(
                        pos.isLong,
                        size,
                        Number(pos.entryPrice) / PRICE_SCALE,
                        mk,
                        Number(pos.collateral) / PRICE_SCALE
                      );
                      return (
                        <>
                          <td className="px-2 text-right tnum text-[var(--t-warn)]">
                            {liq !== null ? `$${liq.toFixed(2)}` : "—"}
                          </td>
                          <td className="px-2 text-right">
                            <HealthCell health={health} />
                          </td>
                        </>
                      );
                    })()}
                    <td className={`text-right tnum ${pos.unrealizedPnl >= 0 ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>
                      {fmtSignedUsd(pos.unrealizedPnl)}
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
                        <button
                          onClick={() => handleClose(pos.marketIndex, pos.isLong, sizeAtoms, 0.5)}
                          className={`${BTN_UTIL} bg-[var(--t-surface)]`}
                          title="Close half the position (lot-rounded, 1% slippage bound)"
                        >
                          ½
                        </button>
                        <button
                          onClick={() => handleClose(pos.marketIndex, pos.isLong, sizeAtoms, 1)}
                          className={`${BTN_UTIL} bg-[var(--t-surface)]`}
                          title="Close at mark (1% slippage bound)"
                        >
                          Close
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
                  <td colSpan={8} className="py-3">
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
        {flattenErr && (
          <div className="pt-2 text-[11px] text-[var(--t-down)] break-all">{flattenErr}</div>
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
 * Liquidation price + health factor.
 *
 * IMPORTANT: we do NOT use the position's stored collateral for this estimate.
 * On the ER, a position's collateral is the sum of each fill's `filled_margin`,
 * which for older fills was stamped under the pre-fix (1000x) margin scale — that
 * made health read in the hundreds and pushed the liq price negative. Instead we
 * derive the posted margin from the position's OWN notional at the current 20x
 * convention (margin = size*entry/leverage), which is what a correctly-scaled
 * position holds. This yields a realistic, self-consistent health + liq price.
 *
 *   maintenance_margin = (notional / leverage) / 2
 *   health = (margin + uPnL) / maintenance_margin
 *   long  liq = entry − (margin − maint) / size
 *   short liq = entry + (margin − maint) / size
 *
 * Inputs are human units: sizeSol (SOL), entry/mark (USD).
 */
function liqAndHealth(
  isLong: boolean,
  sizeSol: number,
  entry: number,
  mark: number,
  _collateral: number
): { liq: number | null; health: number | null } {
  if (sizeSol <= 0 || entry <= 0) return { liq: null, health: null };
  const notional = sizeSol * entry;
  const initialMargin = notional / MAX_LEVERAGE; // posted margin (1/leverage of notional)
  const maintMargin = initialMargin / 2;
  if (maintMargin <= 0) return { liq: null, health: null };

  const buffer = (initialMargin - maintMargin) / sizeSol; // USD move to liquidation
  const liq = isLong ? entry - buffer : entry + buffer;

  const uPnl = (isLong ? mark - entry : entry - mark) * sizeSol;
  const health = (initialMargin + uPnl) / maintMargin;

  return { liq: liq > 0 ? liq : null, health };
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
