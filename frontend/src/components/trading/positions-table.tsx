"use client";

import { useState } from "react";
import { useWallet, useConnection } from "@/hooks/use-wallet-compat";
import { Connection, Transaction } from "@solana/web3.js";
import { usePositions } from "@/hooks/use-positions";
import { useErPosition } from "@/hooks/use-er-position";
import { useSession } from "@/hooks/use-session";
import { useTriggers } from "@/hooks/use-triggers";
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

interface PositionsTableProps {
  markPrice: bigint | null;
}

export function PositionsTable({ markPrice }: PositionsTableProps) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { positions, refresh } = usePositions(markPrice);
  const { position: erPosition } = useErPosition(publicKey ?? null, markPrice);
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
      // wide bound off the mark so it sweeps available depth.
      const mark = Number(markPrice || 0n) / PRICE_SCALE;
      const crossPrice = erPosition.isLong ? mark * 0.95 : mark * 1.05;
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

      let limitPrice = 0n;
      if (markPrice && markPrice > 0n) {
        limitPrice = isLong
          ? (markPrice * (10_000n - CLOSE_SLIPPAGE_BPS)) / 10_000n
          : (markPrice * (10_000n + CLOSE_SLIPPAGE_BPS)) / 10_000n;
      }

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
    <div className="panel">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-white/[0.06]">
        <span className="panel-title">Positions</span>
        <span className="text-[10px] text-white/50 font-medium">
          {positions.length + (erPosition ? 1 : 0)} open
        </span>
      </div>
      <div className="px-2 pb-2">
        {positions.length === 0 && !erPosition ? (
          <div className="text-center text-xs text-white/55 font-medium py-8">
            {publicKey ? "No open positions" : "Sign in to see your positions"}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-[10px] text-white/50 font-semibold uppercase tracking-wider border-b border-white/[0.06]">
                <th className="text-left font-semibold px-2 py-2">Side</th>
                <th className="text-right font-semibold px-2 py-2">Size</th>
                <th className="text-right font-semibold px-2 py-2">Entry</th>
                <th className="text-right font-semibold px-2 py-2">Mark</th>
                <th className="text-right font-semibold px-2 py-2">Liq.</th>
                <th className="text-right font-semibold px-2 py-2">Health</th>
                <th className="text-right font-semibold px-2 py-2">uPnL</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {/* ER (pending-settlement) position — filled on the rollup, not yet
                  settled to an L1 Position. Reconstructed from the ER fill queue. */}
              {erPosition && (
                <tr className="border-t border-white/[0.05] bg-amber-500/[0.04]">
                  <td className="px-2 py-2.5">
                    <div className="flex flex-col gap-1">
                      <SideBadge isLong={erPosition.isLong} />
                      <span className="text-[10px] text-amber-400/90 font-semibold uppercase tracking-wide flex items-center gap-1">
                        <span className="h-1 w-1 rounded-full bg-amber-400 animate-pulse" />
                        Pending
                      </span>
                    </div>
                  </td>
                  <td className={`text-right font-mono tnum text-xs px-2 ${erPosition.isLong ? "text-emerald-400" : "text-rose-400"}`}>
                    {Math.abs(erPosition.size).toFixed(3)}
                  </td>
                  <td className="text-right font-mono tnum text-xs px-2 text-white/80">
                    ${erPosition.entryPrice.toFixed(2)}
                  </td>
                  <td className="text-right font-mono tnum text-xs px-2 text-white/80">
                    ${(Number(markPrice || 0n) / PRICE_SCALE).toFixed(2)}
                  </td>
                  {(() => {
                    const mk = Number(markPrice || 0n) / PRICE_SCALE;
                    const { liq, health } = liqAndHealth(
                      erPosition.isLong,
                      Math.abs(erPosition.size),
                      erPosition.entryPrice,
                      mk,
                      erPosition.collateral
                    );
                    return (
                      <>
                        <td className="text-right font-mono tnum text-xs px-2 text-amber-300/90">
                          {liq !== null ? `$${liq.toFixed(2)}` : "—"}
                        </td>
                        <td className="text-right text-xs px-2">
                          <HealthCell health={health} />
                        </td>
                      </>
                    );
                  })()}
                  <td className={`text-right font-mono tnum font-bold text-xs px-2 ${erPosition.unrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {fmtSignedUsd(erPosition.unrealizedPnl)}
                  </td>
                  <td className="text-right px-2 py-2">
                    <button
                      onClick={handleFlatten}
                      disabled={flattening}
                      className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/25 text-rose-200 transition-colors disabled:opacity-50"
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
                  <tr key={i} className="border-t border-white/[0.05] hover:bg-white/[0.02] transition-colors">
                    <td className="px-2 py-2.5">
                      <div className="flex flex-col gap-1">
                        <SideBadge isLong={pos.isLong} />
                        {(triggers.stopLoss || triggers.takeProfit) && (
                          <span className="flex gap-1">
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
                      </div>
                    </td>
                    <td className={`text-right font-mono tnum text-xs px-2 ${pos.size > 0n ? "text-emerald-400" : "text-rose-400"}`}>
                      {size.toFixed(3)}
                    </td>
                    <td className="text-right font-mono tnum text-xs px-2 text-white/80">
                      ${(Number(pos.entryPrice) / PRICE_SCALE).toFixed(2)}
                    </td>
                    <td className="text-right font-mono tnum text-xs px-2 text-white/80">
                      ${(Number(markPrice || 0n) / PRICE_SCALE).toFixed(2)}
                    </td>
                    {(() => {
                      const mk = Number(markPrice || 0n) / PRICE_SCALE;
                      const { liq, health } = liqAndHealth(
                        pos.isLong,
                        size,
                        Number(pos.entryPrice) / PRICE_SCALE,
                        mk,
                        Number(pos.collateral) / PRICE_SCALE
                      );
                      return (
                        <>
                          <td className="text-right font-mono tnum text-xs px-2 text-amber-300/90">
                            {liq !== null ? `$${liq.toFixed(2)}` : "—"}
                          </td>
                          <td className="text-right text-xs px-2">
                            <HealthCell health={health} />
                          </td>
                        </>
                      );
                    })()}
                    <td className={`text-right font-mono tnum font-bold text-xs px-2 ${pos.unrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {fmtSignedUsd(pos.unrealizedPnl)}
                    </td>
                    <td className="text-right px-2 py-2">
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => setTriggerOpen((v) => !v)}
                          className={`text-[11px] font-semibold px-2 py-1 rounded-md border transition-colors ${
                            triggerOpen
                              ? "bg-sky-500/20 border-sky-500/30 text-sky-200"
                              : "bg-white/5 hover:bg-white/10 border-white/10 text-white/70"
                          }`}
                          title="Set stop-loss / take-profit"
                        >
                          SL/TP
                        </button>
                        <button
                          onClick={() => handleClose(pos.marketIndex, pos.isLong, sizeAtoms, 0.5)}
                          className="text-[11px] font-semibold px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 transition-colors"
                          title="Close half the position (lot-rounded, 1% slippage bound)"
                        >
                          ½
                        </button>
                        <button
                          onClick={() => handleClose(pos.marketIndex, pos.isLong, sizeAtoms, 1)}
                          className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 transition-colors"
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
                <tr className="border-t border-white/[0.05] bg-sky-500/[0.03]">
                  <td colSpan={8} className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1.5 text-[11px] text-white/60 font-medium">
                        Stop-loss $
                        <input
                          value={slInput}
                          onChange={(e) => setSlInput(e.target.value)}
                          placeholder={triggers.stopLoss ? (Number(triggers.stopLoss.triggerPrice) / PRICE_SCALE).toFixed(2) : "price"}
                          inputMode="decimal"
                          className="w-20 bg-white/5 border border-white/10 rounded-md px-2 py-1 text-xs font-mono tnum text-white/85 outline-none focus:border-sky-500/40"
                        />
                      </label>
                      <label className="flex items-center gap-1.5 text-[11px] text-white/60 font-medium">
                        Take-profit $
                        <input
                          value={tpInput}
                          onChange={(e) => setTpInput(e.target.value)}
                          placeholder={triggers.takeProfit ? (Number(triggers.takeProfit.triggerPrice) / PRICE_SCALE).toFixed(2) : "price"}
                          inputMode="decimal"
                          className="w-20 bg-white/5 border border-white/10 rounded-md px-2 py-1 text-xs font-mono tnum text-white/85 outline-none focus:border-sky-500/40"
                        />
                      </label>
                      <button
                        onClick={() => handleSetTriggers(positions[0].isLong)}
                        disabled={triggerBusy}
                        className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/25 text-sky-200 transition-colors disabled:opacity-50"
                      >
                        {triggerBusy ? "…" : "Set"}
                      </button>
                      {triggers.stopLoss && (
                        <button
                          onClick={() => handleCancelTrigger(TRIGGER_KIND_STOP_LOSS)}
                          disabled={triggerBusy}
                          className="text-[11px] font-medium px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white/60 transition-colors disabled:opacity-50"
                        >
                          Clear SL
                        </button>
                      )}
                      {triggers.takeProfit && (
                        <button
                          onClick={() => handleCancelTrigger(TRIGGER_KIND_TAKE_PROFIT)}
                          disabled={triggerBusy}
                          className="text-[11px] font-medium px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white/60 transition-colors disabled:opacity-50"
                        >
                          Clear TP
                        </button>
                      )}
                      <span className="text-[10px] text-white/50">
                        Executed by keepers when the mark price crosses — works even if you close this tab.
                      </span>
                    </div>
                    {triggerErr && (
                      <div className="text-[11px] text-rose-400 pt-1.5 break-all">{triggerErr}</div>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {flattenErr && (
          <div className="text-[11px] text-rose-400 px-2 py-1.5 break-all">{flattenErr}</div>
        )}
        {closeErr && (
          <div className="text-[11px] text-rose-400 px-2 py-1.5 break-all">{closeErr}</div>
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
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide ${
        isLong
          ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/25"
          : "bg-rose-500/15 text-rose-300 border border-rose-500/25"
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
  if (health === null) return <span className="text-white/55">—</span>;
  const color =
    health >= 2 ? "text-emerald-400" : health >= 1.3 ? "text-amber-400" : "text-rose-400";
  const bar =
    health >= 2 ? "bg-emerald-400" : health >= 1.3 ? "bg-amber-400" : "bg-rose-400";
  // Margin meter: health 0 (liquidation) .. 3+ (full bar).
  const pct = Math.max(0, Math.min(100, (health / 3) * 100));
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span className={`font-mono tnum ${color}`}>{health.toFixed(2)}</span>
      <span className="block w-10 h-[3px] rounded-full bg-white/10 overflow-hidden">
        <span className={`block h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

function TriggerBadge({ label, price, tone }: { label: string; price: number; tone: "rose" | "emerald" }) {
  const cls =
    tone === "rose"
      ? "bg-rose-500/10 text-rose-300/90 border-rose-500/20"
      : "bg-emerald-500/10 text-emerald-300/90 border-emerald-500/20";
  return (
    <span className={`inline-flex items-center gap-0.5 px-1 py-px rounded-sm border text-[10px] font-bold tracking-wide ${cls}`}>
      {label} <span className="font-mono tnum">${price.toFixed(2)}</span>
    </span>
  );
}
