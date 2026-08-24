"use client";

import { erConnection } from "@/lib/connections";
import { useState } from "react";
import { useWallet } from "@/hooks/use-wallet-compat";
import { Transaction } from "@solana/web3.js";
import { useOpenOrders } from "@/hooks/use-open-orders";
import { useSession } from "@/hooks/use-session";
import { PROGRAM_ID, MARKET_INDEX } from "@/lib/manifest";
import { createCancelOrderInstruction,
  humanizeError,
} from "@/lib/slipstream";
import { confirmSignature } from "@/lib/confirm";

/**
 * The connected wallet's RESTING orders on the ER book — the orders that have
 * been placed but not yet filled. (Filled orders become L1 Positions, shown
 * separately.) A limit order sits here at your price until someone crosses it.
 */
export function OpenOrders() {
  const { publicKey, sendTransaction } = useWallet();
  const { state: session, getSessionKeypair } = useSession(0);
  const { orders, error: ordersError } = useOpenOrders(publicKey ?? null, 0);
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
      // Nothing to refresh here: the book is the ONE shared 2s poller's and a
      // single subscriber cannot make it tick early, so the cancelled row
      // clears on its next tick — within 2s of a confirmation that itself took
      // seconds. The no-op `refresh()` that used to sit on this line, and the
      // stub behind it in useOpenOrders, were deleted together.
    } catch (err) {
      setCancelErr(humanizeError(err));
      console.error("cancel failed:", err);
    } finally {
      setCancelling(null);
    }
  };

  return (
    <div>
      <div className="h-9 flex items-center justify-between px-3 border-b border-[var(--t-border)]">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-2)]">
          Open Orders
        </span>
        <span className="text-[11px] text-[var(--t-text-3)] tnum">
          {/* "0 resting" is a claim about the book. With the book unreadable we
              do not know the count, so say so with a dash rather than assert. */}
          {ordersError && orders.length === 0 ? "—" : `${orders.length} resting`}
        </span>
      </div>
      <div className="p-3">
        {orders.length === 0 ? (
          <div className="text-center text-xs text-[var(--t-text-2)] py-6">
            {/* POS-1: a failed book read used to render as "No open orders" —
                the same sentence as a genuinely empty book. A trader whose
                limit order is resting (and fillable) was told they had none.
                Same wording as market-bar's banner for the same condition. */}
            {!publicKey
              ? "Sign in to see your open orders"
              : ordersError
                ? "Can't reach Solana — retrying."
                : "No open orders"}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-[11px] text-[var(--t-text-3)] border-b border-[var(--t-surface-2)]">
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
                  className="h-7 text-[11.5px] border-b border-[var(--t-surface-2)] last:border-b-0 hover:bg-[var(--t-surface-3)]"
                >
                  <td className={o.isLong ? "text-left text-[var(--t-up)]" : "text-left text-[var(--t-down)]"}>
                    {o.isLong ? "LONG" : "SHORT"}
                  </td>
                  <td className="text-right tnum text-[var(--t-text)]">${o.price.toFixed(3)}</td>
                  <td className="text-right tnum text-[var(--t-text)]">{o.size.toFixed(3)}</td>
                  <td className="text-right">
                    <button
                      onClick={() => handleCancel(o.orderId)}
                      disabled={cancelling === o.orderId.toString()}
                      aria-label="Cancel order"
                      className="h-6 px-2 rounded-[4px] text-[12px] bg-[var(--t-surface)] border border-[var(--t-border)] text-[var(--t-text-2)] transition-colors hover:text-[var(--t-text)] disabled:pointer-events-none disabled:text-[var(--t-text-3)] disabled:border-[var(--t-border)] disabled:cursor-not-allowed"
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
          <div className="pt-2 text-[11px] text-[var(--t-down)] break-all">{cancelErr}</div>
        )}
      </div>
    </div>
  );
}
