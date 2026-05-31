"use client";

import { useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { Connection, Transaction, PublicKey } from "@solana/web3.js";
import { usePositions } from "@/hooks/use-positions";
import { useErPosition } from "@/hooks/use-er-position";
import { useSession } from "@/hooks/use-session";
import { PROGRAM_ID, MARKET, MARKET_INDEX, ER_RPC } from "@/lib/manifest";
import { createPlaceOrderInstruction } from "@/lib/slipstream";
import { confirmSignature } from "@/lib/confirm";

const SEED_MARKET = Buffer.from("market");
const SEED_POSITION = Buffer.from("position");
const SEED_USER = Buffer.from("user");
const IX_CLOSE_POSITION = 0x08;
const PRICE_SCALE = 1_000_000;
const LOT_SIZE = 100_000_000n; // 0.1 SOL in 9-dp base atoms

interface PositionsTableProps {
  markPrice: bigint | null;
}

export function PositionsTable({ markPrice }: PositionsTableProps) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { positions, refresh } = usePositions(markPrice);
  const { position: erPosition } = useErPosition(publicKey ?? null, markPrice);
  const { state: session, getSessionKeypair } = useSession(0);
  const [flattening, setFlattening] = useState(false);
  const [flattenErr, setFlattenErr] = useState<string | null>(null);

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
    } catch (err: any) {
      setFlattenErr(err?.message ?? String(err));
      console.error("flatten failed:", err);
    } finally {
      setFlattening(false);
    }
  };

  const handleClose = async (marketIndex: number) => {
    if (!publicKey) return;
    try {
      const mBuf = Buffer.alloc(2);
      mBuf.writeUInt16LE(marketIndex);
      // Use the resolved market address from the Deploy_Manifest for the MVP
      // market; derive for any other index.
      const market =
        marketIndex === MARKET_INDEX
          ? MARKET
          : PublicKey.findProgramAddressSync([SEED_MARKET, mBuf], PROGRAM_ID)[0];
      const [position] = PublicKey.findProgramAddressSync(
        [SEED_POSITION, publicKey.toBuffer(), mBuf],
        PROGRAM_ID
      );
      const [userAccount] = PublicKey.findProgramAddressSync(
        [SEED_USER, publicKey.toBuffer()],
        PROGRAM_ID
      );

      const data = Buffer.alloc(1);
      data[0] = IX_CLOSE_POSITION;

      const tx = new Transaction().add({
        keys: [
          { pubkey: market, isSigner: false, isWritable: true },
          { pubkey: position, isSigner: false, isWritable: true },
          { pubkey: userAccount, isSigner: false, isWritable: true },
          { pubkey: publicKey, isSigner: true, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data,
      });

      const sig = await sendTransaction(tx, connection);
      await confirmSignature(connection, sig, { timeoutMs: 30_000 });
      refresh();
    } catch (err) {
      console.error("Close position failed:", err);
    }
  };

  return (
    <div className="panel">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-white/[0.06]">
        <span className="panel-title">Positions</span>
        <span className="text-[10px] text-white/30 font-medium">
          {positions.length + (erPosition ? 1 : 0)} open
        </span>
      </div>
      <div className="px-2 pb-2">
        {positions.length === 0 && !erPosition ? (
          <div className="text-center text-xs text-white/40 font-medium py-8">
            {publicKey ? "No open positions" : "Connect wallet to view positions"}
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
                      <span className="text-[8px] text-amber-400/90 font-semibold uppercase tracking-wide flex items-center gap-1">
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
                    {erPosition.unrealizedPnl >= 0 ? "+" : ""}${erPosition.unrealizedPnl.toFixed(2)}
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
                return (
                  <tr key={i} className="border-t border-white/[0.05] hover:bg-white/[0.02] transition-colors">
                    <td className="px-2 py-2.5">
                      <SideBadge isLong={pos.isLong} />
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
                      {pos.unrealizedPnl >= 0 ? "+" : ""}${pos.unrealizedPnl.toFixed(2)}
                    </td>
                    <td className="text-right px-2 py-2">
                      <button
                        onClick={() => handleClose(pos.marketIndex)}
                        className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 transition-colors"
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {flattenErr && (
          <div className="text-[11px] text-rose-400 px-2 py-1.5 break-all">{flattenErr}</div>
        )}
      </div>
    </div>
  );
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

const MAX_LEVERAGE = 20;

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
  if (health === null) return <span className="text-white/40">—</span>;
  const color =
    health >= 2 ? "text-emerald-400" : health >= 1.3 ? "text-amber-400" : "text-rose-400";
  return <span className={`font-mono tnum ${color}`}>{health.toFixed(2)}</span>;
}
