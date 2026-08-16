"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@/hooks/use-wallet-compat";
import { explorerAddress } from "@/lib/manifest";
import { PRICE_SCALE, SIDE_BID } from "@/lib/slipstream";

/**
 * Settled trade history, served from the fills indexer the settlement keeper
 * writes (/api/trades). Connected wallet -> personal history with Maker/Taker
 * role + fees; otherwise the market-wide settled tape.
 */

interface FillRow {
  sequence: number;
  price: number;
  quantity: number;
  maker: string;
  taker: string;
  maker_side: number;
  taker_fee_bps: number;
  maker_rebate_bps: number;
  settled_at: number;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function TradeHistory() {
  const { publicKey } = useWallet();
  const [fills, setFills] = useState<FillRow[]>([]);
  const [indexed, setIndexed] = useState(true);
  const wallet = publicKey?.toBase58() ?? null;

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const url = wallet ? `/api/trades?wallet=${wallet}&limit=60` : "/api/trades?limit=60";
        const res = await fetch(url);
        const json = await res.json();
        if (!stop) {
          setFills(json.fills ?? []);
          setIndexed(json.indexed !== false);
        }
      } catch {
        /* keep last */
      }
    };
    poll();
    const id = setInterval(poll, 10_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [wallet]);

  const volume = fills.reduce((s, f) => s + (f.quantity / 1e9) * (f.price / PRICE_SCALE), 0);

  return (
    <div className="panel flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-white/[0.06] shrink-0">
        <div className="flex flex-col">
          <span className="panel-title">Trade History</span>
          <span className="text-[9px] text-white/35 font-medium">
            {wallet ? "Your settled fills" : "All settled fills"} · from the L1 settlement pipeline
          </span>
        </div>
        {fills.length > 0 && (
          <span className="text-[10px] text-white/45 font-mono tnum">
            {fills.length} fills · ${volume.toFixed(0)} vol
          </span>
        )}
      </div>

      <div className="px-3 pt-2 pb-2 flex-1 min-h-0 flex flex-col">
        <div className="grid grid-cols-[0.9fr_0.9fr_0.9fr_0.7fr_0.7fr_0.9fr] gap-2 text-[9px] text-white/45 font-semibold pb-1.5 uppercase tracking-wider border-b border-white/[0.05] shrink-0 px-1">
          <span>Time</span>
          <span className="text-right">Price</span>
          <span className="text-right">Size (SOL)</span>
          <span className="text-right">Side</span>
          <span className="text-right">Role</span>
          <span className="text-right">Counterparty</span>
        </div>

        <div className="max-h-[220px] overflow-y-auto slim-scroll mt-0.5">
          {fills.length === 0 ? (
            <div className="text-center text-xs text-white/40 font-medium py-6">
              {indexed ? "No settled fills yet" : "Indexer warming up…"}
            </div>
          ) : (
            fills.map((f) => {
              const isMaker = wallet !== null && f.maker === wallet;
              // Taker side is opposite the resting (maker) side; flip again for
              // the viewer's own side when they were the maker.
              const takerBought = f.maker_side === SIDE_BID ? false : true;
              const viewerBought = wallet ? (isMaker ? !takerBought : takerBought) : takerBought;
              const counterparty = isMaker ? f.taker : f.maker;
              return (
                <a
                  key={f.sequence}
                  href={explorerAddress(counterparty, "er")}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="grid grid-cols-[0.9fr_0.9fr_0.9fr_0.7fr_0.7fr_0.9fr] gap-2 text-xs py-[3px] px-1 rounded-sm hover:bg-white/[0.04] transition-colors"
                >
                  <span className="font-mono tnum text-white/45">{fmtTime(f.settled_at)}</span>
                  <span className="text-right font-mono tnum text-white/80">
                    {(f.price / PRICE_SCALE).toFixed(3)}
                  </span>
                  <span className="text-right font-mono tnum text-white/70">
                    {(f.quantity / 1e9).toFixed(2)}
                  </span>
                  <span
                    className={`text-right font-semibold ${viewerBought ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {viewerBought ? "Buy" : "Sell"}
                  </span>
                  <span className="text-right">
                    {wallet ? (
                      <span
                        className={`inline-block text-[9px] font-semibold uppercase tracking-wider px-1.5 py-px rounded-sm ${
                          isMaker
                            ? "bg-sky-400/10 text-sky-300/80"
                            : "bg-amber-400/10 text-amber-300/80"
                        }`}
                      >
                        {isMaker ? "Maker" : "Taker"}
                      </span>
                    ) : (
                      <span className="text-white/30">—</span>
                    )}
                  </span>
                  <span className="text-right font-mono tnum text-sky-400/80 underline decoration-dotted underline-offset-2">
                    {counterparty.slice(0, 4)}…
                  </span>
                </a>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
