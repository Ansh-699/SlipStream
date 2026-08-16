"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useWallet } from "@/hooks/use-wallet-compat";
import { useOrderBook } from "@/hooks/use-orderbook";

/**
 * Toasts a notification when a live fill on the ER order book involves the
 * connected wallet (as maker or taker). Diffs the fill tape by sequence; the
 * first snapshot after mount/connect is treated as history, not news.
 */

interface Toast {
  id: number;
  side: "buy" | "sell";
  role: "Maker" | "Taker";
  price: number;
  size: number;
}

const TOAST_TTL_MS = 6_000;
const MAX_TOASTS = 4;

export function FillToasts() {
  const { publicKey } = useWallet();
  const { trades } = useOrderBook(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastSeen = useRef<number | null>(null);
  const walletRef = useRef<string | null>(null);

  const wallet = publicKey?.toBase58() ?? null;

  useEffect(() => {
    // Wallet changed (connect/disconnect/switch): reset the cursor so the
    // current tape becomes the new baseline instead of a toast storm.
    if (walletRef.current !== wallet) {
      walletRef.current = wallet;
      lastSeen.current = null;
    }
    if (!wallet || trades.length === 0) return;

    if (lastSeen.current === null) {
      lastSeen.current = trades[0].sequence; // baseline: newest-first tape
      return;
    }

    const fresh = trades.filter((t) => t.sequence > (lastSeen.current as number));
    if (fresh.length === 0) return;
    lastSeen.current = trades[0].sequence;

    const mine = fresh
      .filter((t) => t.maker === wallet || t.taker === wallet)
      .map((t): Toast => {
        const isMaker = t.maker === wallet;
        // Tape side is the taker's side; the maker took the other side.
        const side = isMaker ? (t.side === "buy" ? "sell" : "buy") : t.side;
        return {
          id: t.sequence,
          side,
          role: isMaker ? "Maker" : "Taker",
          price: t.price,
          size: t.size,
        };
      });
    if (mine.length === 0) return;

    setToasts((prev) => [...mine.reverse(), ...prev].slice(0, MAX_TOASTS));
    for (const m of mine) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== m.id));
      }, TOAST_TTL_MS);
    }
  }, [trades, wallet]);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            transition={{ duration: 0.18 }}
            className="panel px-3.5 py-2.5 min-w-[220px] pointer-events-auto"
          >
            <div className="flex items-center justify-between gap-3">
              <span
                className={`text-xs font-bold ${t.side === "buy" ? "text-emerald-400" : "text-rose-400"}`}
              >
                {t.side === "buy" ? "Bought" : "Sold"} {t.size.toFixed(2)} SOL
              </span>
              <span className="text-[9px] font-semibold uppercase tracking-wider text-white/40">
                {t.role}
              </span>
            </div>
            <div className="text-[11px] font-mono tnum text-white/60 mt-0.5">
              @ ${t.price.toFixed(3)} · fill #{t.id}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
