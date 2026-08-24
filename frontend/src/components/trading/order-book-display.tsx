"use client";

import { useMemo, useState } from "react";
import { useOrderBook } from "@/hooks/use-orderbook";
import { explorerAddress, TICK_SIZE } from "@/lib/manifest";

const DEPTH = 20; // levels shown per side (full available depth)
const PRICE_SCALE = 1_000_000;
/** Smallest price increment the program will accept, straight from the manifest. */
const tickSize = (Number(TICK_SIZE) / PRICE_SCALE).toFixed(3);

export function OrderBookDisplay() {
  // `status` and `updatedAt` are the point of this hook's return shape: an empty
  // ladder has three different causes and a POPULATED ladder has two — current,
  // or the last good one held on screen while every read since has failed. That
  // second one used to render byte-for-byte identically to a live book, so a
  // trader could price a limit order off quotes that stopped minutes ago.
  const { bids, asks, trades, status, updatedAt } = useOrderBook(0);
  const [tab, setTab] = useState<"book" | "trades">("book");

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
  const sellPct = 100 - buyPct;

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg)] overflow-hidden">
      {/* Tab header */}
      <div className="tk-head justify-between">
        <div role="tablist" aria-label="Order book" className="flex items-stretch gap-4">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "book"}
            aria-controls="book-panel"
            className="tk-tab"
            onClick={() => setTab("book")}
          >
            Book
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "trades"}
            aria-controls="trades-panel"
            className="tk-tab"
            onClick={() => setTab("trades")}
          >
            Trades
          </button>
        </div>
        <span className="text-[11px] text-[var(--t-text-3)]">SOL-PERP</span>
      </div>

      {/* Real protocol parameters, not decoration: the tick comes from the
          deploy manifest and the lot from the market's own lot size. */}
      <div className="h-8 shrink-0 flex items-center gap-1.5 px-3 border-b border-[var(--t-border)]">
        <span className="tk-chip">Tick {tickSize}</span>
        <span className="tk-chip">SOL-USD</span>
      </div>

      {/* The one thing separating a live panel from a frozen one, and it sits
          outside the tab switch because BOTH tabs are fed by the same read of
          the same account. useSharedSource deliberately keeps the last good
          value on screen through a failed fetch (a blip must not blank the
          book), so without this every level, the mid, the spread and every
          "recent" trade render during an outage exactly as they render current
          data — and someone prices a limit order off quotes that stopped
          minutes ago.

          It states the clock time of the last good read rather than an age in
          seconds: an age needs Date.now() during render, which is impure and
          lints as such, and running a clock purely to count it up is a
          re-render a second for a number the reader already has. */}
      {status === "stale" && updatedAt !== null && (
        <div
          role="status"
          className="shrink-0 border-b border-[var(--t-warn)]/30 bg-[var(--t-warn)]/10 px-3 py-1 text-[11px] font-medium text-[var(--t-warn)]"
        >
          Not updating — last read at {new Date(updatedAt).toLocaleTimeString()}
        </div>
      )}

      {/* Both branches are real tabpanel elements. They used to be fragments, so
          the tabs' aria-controls resolved to nothing and the ladder announced as
          a run of unlabelled divs. `flex-1 flex flex-col min-h-0` is load-bearing,
          not decoration: the wrapper sits between the `h-full flex flex-col`
          container above and the shrink-0 header + flex-1 min-h-0 scroll region
          below, and without it the ladder stops scrolling. The inactive tab's
          aria-controls still dangles because only one panel renders at a time —
          the same trade-off activity-drawer.tsx makes. */}
      {tab === "book" ? (
        <div
          id="book-panel"
          role="tabpanel"
          aria-label="Order book"
          className="flex-1 flex flex-col min-h-0"
        >
          {/* Column header */}
          <div className="grid grid-cols-3 shrink-0 px-3 py-1.5 text-[11px] text-[var(--t-text-3)]">
            <span>Price (USD)</span>
            <span className="text-right">Size (SOL)</span>
            <span className="text-right">Total (SOL)</span>
          </div>

          <div className="flex-1 flex flex-col min-h-0">
            {empty ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-1 px-4 text-center">
                <span className="text-[12px] text-[var(--t-text)]">
                  {status === "loading"
                    ? "Loading the book…"
                    : status === "unavailable"
                      ? "Can't reach the order book"
                      : status === "stale"
                        ? "Book not updating"
                        : "No resting orders"}
                </span>
                <span className="max-w-[34ch] text-[11px] leading-relaxed text-[var(--t-text-2)]">
                  {status === "unavailable"
                    ? "Neither the rollup nor the base layer answered."
                    : status === "stale"
                      ? "Nothing was resting when the last read succeeded."
                      : status === "empty"
                        ? "The book decoded cleanly but nobody is quoting."
                        : ""}
                </span>
              </div>
            ) : (
              <>
                {/* Asks — col-reverse so best ask sits at the bottom (by the mid)
                    and the section scrolls reliably into deeper levels. */}
                <div className="flex-1 flex flex-col-reverse min-h-0 overflow-y-auto slim-scroll">
                  {askRows.map((l, i) => (
                    <Row key={`a-${i}`} {...l} maxCum={maxCum} side="ask" />
                  ))}
                </div>

                {/* Mid / spread. The mid is neither a bid nor an ask, so it stays
                    neutral — green and red mean side in this panel. */}
                <div className="h-[34px] shrink-0 flex items-baseline gap-2 px-3 border-y border-[var(--t-border)]">
                  <span className="text-[15px] font-bold tnum text-[var(--t-text)] leading-[34px]">
                    {mid !== null ? mid.toFixed(3) : "—"}
                  </span>
                  <span className="text-[11px] text-[var(--t-text-3)]">mid</span>
                  <span className="ml-auto text-[11px] text-[var(--t-text-2)] tnum">
                    {spread !== null ? `spread ${spread.toFixed(3)}` : ""}
                  </span>
                </div>

                {/* Bids — scrollable, anchored to the top (best bid near the mid) */}
                <div className="flex-1 flex flex-col justify-start min-h-0 overflow-y-auto slim-scroll">
                  {bidRows.map((l, i) => (
                    <Row key={`b-${i}`} {...l} maxCum={maxCum} side="bid" />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <div
          id="trades-panel"
          role="tabpanel"
          aria-label="Recent trades"
          className="flex-1 flex flex-col min-h-0"
        >
          {/* Column header */}
          <div className="grid grid-cols-3 shrink-0 px-3 py-1.5 text-[11px] text-[var(--t-text-3)]">
            <span>Price (USD)</span>
            <span className="text-right">Size (SOL)</span>
            <span className="text-right">Maker</span>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto slim-scroll">
            {trades.length === 0 ? (
              <div className="h-full flex items-center justify-center text-[12px] text-[var(--t-text-2)]">
                {/* Same three-way split as the book: the fill ring comes from the
                    same account and the same read, so "No trades yet" was being
                    printed for a market that is trading whenever that read was
                    failing or had not landed yet. */}
                {status === "loading"
                  ? "Loading trades…"
                  : status === "unavailable"
                    ? "Can't reach the order book"
                    : status === "stale"
                      ? "Trade feed not updating"
                      : "No trades yet"}
              </div>
            ) : (
              trades.map((t) => (
                <a
                  key={t.sequence}
                  href={explorerAddress(t.maker, "er")}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Verify maker ${t.maker} on Explorer`}
                  className="grid grid-cols-3 items-center h-5 px-3 text-[11.5px] hover:bg-[var(--t-surface-3)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]"
                >
                  <span className={`tnum ${t.side === "buy" ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>
                    {t.price.toFixed(3)}
                  </span>
                  <span className="text-right tnum text-[var(--t-text)]">{t.size.toFixed(2)}</span>
                  <span className="text-right tnum text-[var(--t-up)] underline decoration-dotted underline-offset-2">
                    {t.maker.slice(0, 4)}…
                  </span>
                </a>
              ))
            )}
          </div>
        </div>
      )}

      {/* Buy / Sell pressure. Hidden when there is no book: with zero depth
          buyPct falls back to 50, and rendering a half-and-half bar next to
          "No resting orders" would invent a split that does not exist. */}
      {!empty && (
      <div
        role="img"
        aria-label={`Resting depth: ${buyPct.toFixed(0)}% bids, ${sellPct.toFixed(0)}% asks`}
        className="h-8 shrink-0 flex items-center gap-2 px-3 border-t border-[var(--t-border)]"
      >
        <span className="text-[11px] tnum text-[var(--t-up)] shrink-0">Buy {buyPct.toFixed(0)}%</span>
        <div aria-hidden className="flex-1 flex h-1 rounded-[4px] overflow-hidden bg-[var(--t-surface)]">
          <div className="h-full bg-[var(--t-up)]" style={{ width: `${buyPct}%` }} />
          <div className="h-full flex-1 bg-[var(--t-down)]" />
        </div>
        <span className="text-[11px] tnum text-[var(--t-down)] shrink-0">{sellPct.toFixed(0)}% Sell</span>
      </div>
      )}
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
    <div className="relative grid grid-cols-3 items-center h-5 shrink-0 px-3 text-[11.5px]">
      {/* cumulative-depth bar grows from the right edge */}
      <div
        aria-hidden
        className="absolute inset-y-0 right-0"
        style={{
          width: `${pct}%`,
          backgroundColor: side === "bid" ? "rgba(34,197,94,0.10)" : "rgba(239,68,68,0.10)",
        }}
      />
      <span className={`relative tnum ${side === "bid" ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>
        {price.toFixed(3)}
      </span>
      <span className="relative text-right tnum text-[var(--t-text)]">{fmtAmt(size)}</span>
      <span className="relative text-right tnum text-[var(--t-text-2)]">{fmtAmt(total)}</span>
    </div>
  );
}

/** Compact amount formatter (e.g. 2,416.40). */
function fmtAmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
