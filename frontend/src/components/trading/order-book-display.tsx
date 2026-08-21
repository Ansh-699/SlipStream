"use client";

import { useMemo } from "react";
import { useOrderBook } from "@/hooks/use-orderbook";

const DEPTH = 20; // levels shown per side (full available depth)

export function OrderBookDisplay() {
  const { bids, asks } = useOrderBook(0);

  // Build cumulative ladders. Asks render top→down moving DOWN toward the mid,
  // so the cumulative total is largest at the top (farthest level). Bids render
  // from the mid downward, cumulative largest at the bottom.
  const { askRows, bidRows, maxCum, mid, spread, buyPct } = useMemo(() => {
    const a = asks.slice(0, DEPTH);
    const b = bids.slice(0, DEPTH);

    // Cumulative totals (sum from best price outward).
    const cumulate = <T extends { size: number }>(levels: T[]) => {
      const out: (T & { total: number })[] = [];
      let total = 0;
      for (const l of levels) {
        total += l.size;
        out.push({ ...l, total });
      }
      return { rows: out, total };
    };
    const { rows: askCum, total: askTotal } = cumulate(a);
    const { rows: bidCum, total: bidTotal } = cumulate(b);

    const maxCum = Math.max(askTotal, bidTotal, 0.0001);
    const mid = b.length && a.length ? (b[0].price + a[0].price) / 2 : b[0]?.price ?? a[0]?.price ?? null;
    const spread = b.length && a.length ? a[0].price - b[0].price : null;
    const buyPct = bidTotal + askTotal > 0 ? (bidTotal / (bidTotal + askTotal)) * 100 : 50;

    // Asks kept in ASCENDING price (best ask first); the asks container uses
    // flex-col-reverse so the best ask sits at the BOTTOM (by the mid) while the
    // section scrolls properly (justify-end + overflow has a known scroll bug).
    const askRows = askCum;
    return { askRows, bidRows: bidCum, maxCum, mid, spread, buyPct };
  }, [bids, asks]);

  const empty = bids.length === 0 && asks.length === 0;

  return (
    <div className="panel h-full flex flex-col">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-white/[0.06]">
        <span className="panel-title">Order Book</span>
        <span className="text-[10px] text-white/50 font-medium">SOL-PERP</span>
      </div>

      {/* Column header */}
      <div className="grid grid-cols-3 px-4 pt-2 pb-1.5 text-[10px] text-white/50 font-semibold uppercase tracking-wider shrink-0">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Total</span>
      </div>

      <div className="flex-1 flex flex-col min-h-0 px-1.5 pb-1.5">
        {empty ? (
          <div className="flex-1 flex items-center justify-center text-xs text-white/55 font-medium">
            No orders yet
          </div>
        ) : (
          <>
            {/* Asks — col-reverse so best ask sits at the bottom (by the mid)
                and the section scrolls reliably into deeper levels. */}
            <div className="flex-1 flex flex-col-reverse gap-px min-h-0 overflow-y-auto slim-scroll">
              {askRows.map((l, i) => (
                <Row key={`a-${i}`} {...l} maxCum={maxCum} side="ask" />
              ))}
            </div>

            {/* Mid / spread. The mid is neither a bid nor an ask, so it stays
                neutral — emerald and rose mean side in this panel. */}
            <div className="flex items-baseline gap-2 px-2.5 py-1.5 shrink-0">
              <span className="text-base font-bold tnum text-white">
                {mid !== null ? mid.toFixed(3) : "—"}
              </span>
              <span className="text-[10px] text-white/55 font-medium">mid</span>
              <span className="ml-auto text-[10px] text-white/55 font-medium tnum">
                {spread !== null ? `spread ${spread.toFixed(3)}` : ""}
              </span>
            </div>

            {/* Bids — scrollable, anchored to the top (best bid near the mid) */}
            <div className="flex-1 flex flex-col justify-start gap-px min-h-0 overflow-y-auto slim-scroll">
              {bidRows.map((l, i) => (
                <Row key={`b-${i}`} {...l} maxCum={maxCum} side="bid" />
              ))}
            </div>

            {/* Buy / Sell ratio bar */}
            <div className="shrink-0 px-1.5 pt-1.5">
              <div
                role="img"
                aria-label={`Resting depth: ${buyPct.toFixed(0)}% bids, ${(100 - buyPct).toFixed(0)}% asks`}
                className="flex items-center h-4 rounded-sm overflow-hidden text-[10px] font-bold"
              >
                <div
                  className="h-full bg-emerald-500/25 text-emerald-300 flex items-center pl-1.5"
                  style={{ width: `${buyPct}%` }}
                >
                  {buyPct >= 12 ? `${buyPct.toFixed(0)}%` : ""}
                </div>
                <div
                  className="h-full bg-rose-500/25 text-rose-300 flex items-center justify-end pr-1.5 flex-1"
                >
                  {100 - buyPct >= 12 ? `${(100 - buyPct).toFixed(0)}%` : ""}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  price,
  size,
  total,
  maxCum,
  side,
}: {
  price: number;
  size: number;
  total: number;
  maxCum: number;
  side: "bid" | "ask";
}) {
  const pct = Math.min(100, (total / maxCum) * 100);
  return (
    <div className="relative grid grid-cols-3 text-[11px] leading-5 px-2.5 rounded-sm">
      {/* cumulative-depth bar grows from the right edge */}
      <div
        className={`absolute inset-y-0 right-0 ${side === "bid" ? "bg-emerald-500/[0.14]" : "bg-rose-500/[0.14]"}`}
        style={{ width: `${pct}%` }}
      />
      <span className={`relative font-mono tnum ${side === "bid" ? "text-emerald-400" : "text-rose-400"}`}>
        {price.toFixed(3)}
      </span>
      <span className="relative text-right font-mono tnum text-white/85">
        {fmtAmt(size)}
      </span>
      <span className="relative text-right font-mono tnum text-white/55">
        {fmtAmt(total)}
      </span>
    </div>
  );
}

/** Compact amount formatter (e.g. 2,416.40). */
function fmtAmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
