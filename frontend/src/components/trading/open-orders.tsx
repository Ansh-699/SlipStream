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
    <div>
      <div className="h-9 flex items-center justify-between px-3 border-b border-[#1d2224]">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#a2abb1]">
          Open Orders
        </span>
        <span className="text-[11px] text-[#838c92] tnum">{orders.length} resting</span>
      </div>
      <div className="p-3">
        {orders.length === 0 ? (
          <div className="text-center text-xs text-[#a2abb1] py-6">
            {publicKey ? "No open orders" : "Sign in to see your open orders"}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-[11px] text-[#838c92] border-b border-[#15191a]">
                <th className="h-[26px] text-left font-normal">Side</th>
                <th className="h-[26px] text-right font-normal">Price</th>
                <th className="h-[26px] text-right font-normal">Size</th>
                <th className="h-[26px]"></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr
                  key={o.orderId.toString()}
                  className="h-7 text-[11.5px] border-b border-[#15191a] last:border-b-0 hover:bg-[#121516]"
                >
                  <td className={o.isLong ? "text-left text-[#22c55e]" : "text-left text-[#ef4444]"}>
                    {o.isLong ? "LONG" : "SHORT"}
                  </td>
                  <td className="text-right tnum text-[#e6e9ea]">${o.price.toFixed(3)}</td>
                  <td className="text-right tnum text-[#e6e9ea]">{o.size.toFixed(3)}</td>
                  <td className="text-right">
                    <button
                      onClick={() => handleCancel(o.orderId)}
                      disabled={cancelling === o.orderId.toString()}
                      aria-label="Cancel order"
                      className="h-6 px-2 rounded-[4px] text-[12px] bg-[#121516] border border-[#1d2224] text-[#a2abb1] transition-colors hover:text-[#e6e9ea] disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed"
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
          <div className="pt-2 text-[11px] text-[#ef4444] break-all">{cancelErr}</div>
        )}
      </div>
    </div>
  );
}
