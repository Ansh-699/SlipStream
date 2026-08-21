"use client";

import { useOrderBook } from "@/hooks/use-orderbook";
import { explorerAddress } from "@/lib/manifest";

/**
 * Live "tape" of executed trades, read from the OrderBook PDA's on-chain
 * fill-event ring (newest first). Each row links the MAKER account (the
 * resting order that provided the liquidity) to the explorer for verification.
 *
 * Note: a FillEvent stores maker/taker/price/qty/fees but NOT the tx signature,
 * so we link the verifiable maker ACCOUNT (not a per-trade tx hash).
 */
export function RecentTrades() {
  const { trades } = useOrderBook(0);

  return (
    <div className="panel h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-white/[0.06] shrink-0">
        <div className="flex flex-col">
          <span className="panel-title">Recent Trades</span>
          <span className="text-[10px] text-white/50 font-medium">On-chain fills · click to verify</span>
        </div>
      </div>

      <div className="px-3 pt-2 pb-2 flex-1 flex flex-col min-h-0">
        <div className="grid grid-cols-[1.1fr_1fr_0.8fr_0.7fr] gap-2 text-[10px] text-white/45 font-semibold pb-1.5 uppercase tracking-wider border-b border-white/[0.05] shrink-0 px-1">
          <span>Price</span>
          <span className="text-right">Size (SOL)</span>
          <span className="text-right">Maker</span>
          <span className="text-right">Seq</span>
        </div>

        <div className="flex-1 overflow-y-auto slim-scroll mt-0.5 min-h-0">
          {trades.length === 0 ? (
            <div className="text-center text-xs text-white/55 font-medium py-8">
              No trades yet
            </div>
          ) : (
            trades.map((t) => (
              <a
                key={t.sequence}
                href={explorerAddress(t.maker, "er")}
                target="_blank"
                rel="noopener noreferrer"
                className="grid grid-cols-[1.1fr_1fr_0.8fr_0.7fr] gap-2 text-xs py-[3px] px-1 rounded-sm hover:bg-white/[0.04] transition-colors group"
                title={`Verify maker ${t.maker} on Explorer`}
              >
                <span className={`font-mono font-semibold tnum ${t.side === "buy" ? "text-emerald-400" : "text-rose-400"}`}>
                  {t.price.toFixed(3)}
                </span>
                <span className="text-right font-mono tnum text-white/75">
                  {t.size.toFixed(2)}
                </span>
                <span className="text-right font-mono tnum text-sky-400/80 group-hover:text-sky-300 underline decoration-dotted underline-offset-2">
                  {t.maker.slice(0, 4)}…
                </span>
                <span className="text-right font-mono tnum text-white/50">
                  #{t.sequence}
                </span>
              </a>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
