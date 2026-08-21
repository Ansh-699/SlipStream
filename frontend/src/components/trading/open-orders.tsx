"use client";

import { useState } from "react";
import { useWallet } from "@/hooks/use-wallet-compat";
import { Connection, Transaction } from "@solana/web3.js";
import { useOpenOrders } from "@/hooks/use-open-orders";
import { useSession } from "@/hooks/use-session";
import { PROGRAM_ID, MARKET_INDEX, ER_RPC } from "@/lib/manifest";
import { createCancelOrderInstruction } from "@/lib/slipstream";
import { confirmSignature } from "@/lib/confirm";

/**
 * The connected wallet's RESTING orders on the ER book — the orders that have
 * been placed but not yet filled. (Filled orders become L1 Positions, shown
 * separately.) A limit order sits here at your price until someone crosses it.
 */
export function OpenOrders() {
  const { publicKey, sendTransaction } = useWallet();
  const { state: session, getSessionKeypair } = useSession(0);
  const { orders, refresh } = useOpenOrders(publicKey ?? null, 0);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelErr, setCancelErr] = useState<string | null>(null);

  const handleCancel = async (orderId: bigint) => {
    if (!publicKey) return;
    setCancelling(orderId.toString());
    setCancelErr(null);
    try {
      const sessionKp = getSessionKeypair();
      const useSessionKey = session.sessionActive && sessionKp !== null;
      const signerPk = useSessionKey ? sessionKp!.publicKey : publicKey;

      const ix = createCancelOrderInstruction(
        publicKey,
        MARKET_INDEX,
        orderId,
        PROGRAM_ID,
        signerPk
      );
      const tx = new Transaction().add(ix);

      // cancel_order runs on the ER (book + credit are delegated there).
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
      setCancelErr(err instanceof Error ? err.message : String(err));
      console.error("cancel failed:", err);
    } finally {
      setCancelling(null);
    }
  };

  return (
    <div className="panel">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-white/[0.06]">
        <span className="panel-title">Open Orders</span>
        <span className="text-[10px] text-white/50 font-medium">{orders.length} resting</span>
      </div>
      <div className="px-2 pb-2">
        {orders.length === 0 ? (
          <div className="text-center text-xs text-white/55 font-medium py-8">
            {publicKey ? "No open orders" : "Connect wallet to view open orders"}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-[10px] text-white/50 font-semibold uppercase tracking-wider border-b border-white/[0.06]">
                <th className="text-left font-semibold px-2 py-2">Side</th>
                <th className="text-right font-semibold px-2 py-2">Price</th>
                <th className="text-right font-semibold px-2 py-2">Size</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.orderId.toString()} className="border-t border-white/[0.05] hover:bg-white/[0.02] transition-colors">
                  <td className="px-2 py-2.5">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide ${
                        o.isLong
                          ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/25"
                          : "bg-rose-500/15 text-rose-300 border border-rose-500/25"
                      }`}
                    >
                      {o.isLong ? "LONG" : "SHORT"}
                    </span>
                  </td>
                  <td className="text-right font-mono tnum text-xs px-2 text-white/80">
                    ${o.price.toFixed(3)}
                  </td>
                  <td className="text-right font-mono tnum text-xs px-2 text-white/80">
                    {o.size.toFixed(3)}
                  </td>
                  <td className="text-right px-2 py-2">
                    <button
                      onClick={() => handleCancel(o.orderId)}
                      disabled={cancelling === o.orderId.toString()}
                      className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 transition-colors disabled:opacity-50"
                    >
                      {cancelling === o.orderId.toString() ? "…" : "Cancel"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cancelErr && (
          <div className="px-2 pt-2 text-[11px] text-rose-400 break-all">{cancelErr}</div>
        )}
      </div>
    </div>
  );
}
