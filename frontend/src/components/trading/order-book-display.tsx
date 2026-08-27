"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

  // Change detection lives HERE, above the rows, because it needs to compare
  // whole LEVEL SETS between ticks — something no individual row can see.
  const levelStamps = useLevelStamps(askRows, bidRows);

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
                  {askRows.map((l) => (
                    <Row
                      key={`a-${l.price}`}
                      {...l}
                      maxCum={maxCum}
                      side="ask"
                      stamp={levelStamps.get(`a:${l.price}`) ?? 0}
                    />
                  ))}
                </div>

                <MidRow mid={mid} spread={spread} />

                {/* Bids — scrollable, anchored to the top (best bid near the mid) */}
                <div className="flex-1 flex flex-col justify-start min-h-0 overflow-y-auto slim-scroll">
                  {bidRows.map((l) => (
                    <Row
                      key={`b-${l.price}`}
                      {...l}
                      maxCum={maxCum}
                      side="bid"
                      stamp={levelStamps.get(`b:${l.price}`) ?? 0}
                    />
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



/**
 * Flash an element when the values it displays change.
 *
 * Web Animations API rather than a CSS class toggle: re-applying the SAME
 * animation name to an element does not restart it, so a class-based flash
 * silently stops firing once a row updates twice in a row -- which is every row,
 * every tick, on a live book. `element.animate()` builds a fresh animation each
 * call, so it always restarts, and it needs no extra state and no re-render to
 * do it (20 rows x ~0.4 updates/s, so the object churn is nothing).
 *
 * Never flashes on FIRST paint: `prev === null` means "we have not seen a value
 * yet", not "the value changed", and without that distinction the whole ladder
 * strobes on every mount and every tab switch.
 *
 * Honours prefers-reduced-motion by simply not animating -- the numbers still
 * update, they just do not pulse.
 */
function useFlash<T>(deps: T, tint: string, durationMs = 420, flashOnFirst = false) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef<string | null>(null);
  const sig = JSON.stringify(deps);
  useEffect(() => {
    const first = prev.current === null;
    // `flashOnFirst` covers a level that appears as a NEW row rather than by
    // re-pricing an existing one: the component mounts already carrying a
    // change stamp, and treating that as "first sight, nothing changed" would
    // swallow the one flash the user most wants to see — a level being ADDED.
    const changed = first ? flashOnFirst : prev.current !== sig;
    prev.current = sig;
    if (!changed) return;
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    el.animate(
      [{ backgroundColor: tint }, { backgroundColor: "transparent" }],
      { duration: durationMs, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
    // flashOnFirst is read only on the very first run by construction, so it is
    // deliberately not a dependency: including it would re-fire the flash every
    // time the parent recomputed the stamp map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, tint, durationMs]);
  return ref;
}

/**
 * Mid / spread, with a direction arrow and a flash on change.
 *
 * The NUMBER stays neutral. This panel's standing rule is that green and red
 * mean SIDE, and the mid is neither a bid nor an ask -- colouring it would make
 * the loudest number on the panel say "ask" every time the book ticked up.
 * The arrow and the flash are a deliberate, narrow exception: they encode
 * direction in TIME, they are transient, and an arrow cannot be read as a side.
 */
function MidRow({ mid, spread }: { mid: number | null; spread: number | null }) {
  // Direction lives in STATE, not in a ref read during render. Deriving it from
  // `prevMid.current` inline is a render-phase ref read: React may render without
  // committing, so the "previous" mid can advance for a paint that never happened
  // and the arrow ends up describing a move the user never saw. It is also the
  // exact rule (react-hooks/refs) that lib/shared-source.ts had to be fixed for.
  // Keeping it in state also makes the arrow persist between ticks by itself,
  // instead of needing a second ref to hold it.
  const [shown, setShown] = useState<"up" | "down" | null>(null);
  const prevMid = useRef<number | null>(null);
  useEffect(() => {
    const p = prevMid.current;
    prevMid.current = mid;
    if (p === null || mid === null || mid === p) return;
    setShown(mid > p ? "up" : "down");
  }, [mid]);
  const flashRef = useFlash(
    [mid, spread],
    shown === "down" ? "rgba(239,68,68,0.26)" : "rgba(34,197,94,0.26)",
    560
  );

  return (
    <div className="relative h-[34px] shrink-0 flex items-baseline gap-2 px-3 border-y border-[var(--t-border)]">
      <div ref={flashRef} aria-hidden className="absolute inset-0 pointer-events-none" />
      <span className="relative text-[15px] font-bold tnum text-[var(--t-text)] leading-[34px]">
        {mid !== null ? mid.toFixed(3) : "—"}
      </span>
      {shown && mid !== null && (
        <span
          aria-hidden
          className={`text-[11px] leading-[34px] ${
            shown === "up" ? "text-[var(--t-up)]" : "text-[var(--t-down)]"
          }`}
        >
          {shown === "up" ? "▲" : "▼"}
        </span>
      )}
      <span className="text-[11px] text-[var(--t-text-3)]">mid</span>
      <span className="ml-auto text-[11px] text-[var(--t-text-2)] tnum">
        {spread !== null ? `spread ${spread.toFixed(3)}` : ""}
      </span>
    </div>
  );
}

/**
 * Which PRICE LEVELS changed, keyed by price rather than by row position.
 *
 * The flash used to live inside Row and compare that row's own previous props.
 * Rows are index-keyed, so row 0 is always "best ask" — when the ladder shifts
 * by a single level every row's displayed price changes and the ENTIRE book
 * flashed, even though almost every level was untouched and had merely moved up
 * or down one slot. That is not what a level update looks like.
 *
 * Keying on price makes the identity right: a level flashes when it is ADDED, or
 * when its size changes. A level that only moved rows does not, because as far as
 * the book is concerned nothing happened to it.
 *
 * Returns a stamp per level; the stamp changes only on a real change, so a Row
 * can flash off it and stays quiet through pure re-ordering.
 *
 * This only works because the rows are KEYED BY PRICE. Getting the stamps right
 * was not enough on its own: with index keys React hands row 5 a different LEVEL
 * when the ladder shifts, so its `stamp` prop changes from one level's stamp to
 * another's and it flashes although neither level moved. Measured, that left
 * ~2 flashes per genuinely changed level. A price key gives each level a stable
 * component, so it carries its own stamp as it moves rows, and levels that
 * appear or leave mount and unmount instead of being recycled.
 */
function useLevelStamps(
  askRows: { price: number; size: number }[],
  bidRows: { price: number; size: number }[]
): Map<string, number> {
  const [stamps, setStamps] = useState<Map<string, number>>(() => new Map());
  const prevSizes = useRef<Map<string, number> | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const now = new Map<string, number>();
    for (const l of askRows) now.set(`a:${l.price}`, l.size);
    for (const l of bidRows) now.set(`b:${l.price}`, l.size);
    const prev = prevSizes.current;
    prevSizes.current = now;
    // First book we ever see: everything is "new" only in the trivial sense.
    // Flashing the whole ladder on arrival is exactly the strobe being removed.
    if (prev === null) return;

    let any = false;
    for (const [k, size] of now) {
      const before = prev.get(k);
      if (before === undefined || before !== size) { any = true; break; }
    }
    if (!any) return;

    const stamp = (seq.current += 1);
    // Rebuilt from `now`'s keys, so levels that leave the book drop out of the
    // map instead of accumulating for the lifetime of the page.
    setStamps((prevStamps) => {
      const next = new Map<string, number>();
      for (const [k, size] of now) {
        const before = prev.get(k);
        next.set(k, before === undefined || before !== size ? stamp : prevStamps.get(k) ?? 0);
      }
      return next;
    });
  }, [askRows, bidRows]);

  return stamps;
}

function Row({
  price,
  size,
  total,
  maxCum,
  side,
  stamp,
}: {
  price: number;
  size: number;
  total: number;
  maxCum: number;
  side: "bid" | "ask";
  /** Bumped by useLevelStamps only when THIS price level changed size or appeared. */
  stamp: number;
}) {
  const pct = Math.min(100, (total / maxCum) * 100);
  // Tinted with the row's own side rather than a white wash: white is invisible
  // in light mode, and the side colour already means "bid"/"ask" here. 0.16 over
  // the bar's own 0.10 is a lift you notice at the edge of vision and cannot
  // mistake for a real depth change.
  // The flash paints on its OWN overlay, not on the row's background. The row's
  // background sits UNDERNEATH the depth bar, so a row whose bar is wide had most
  // of its flash muted by the bar's own 0.10 fill — the wider the level, the less
  // you saw, which is backwards. The overlay is a later sibling than the bar, so
  // it composites above it, and the text spans are `relative` so they stay on top
  // of both.
  // Keyed off the level stamp, NOT off [price, size]. This row's own price
  // changes every time the ladder shifts by one slot, which is why the whole
  // book used to flash at once; the stamp only moves when this PRICE LEVEL
  // actually changed. `stamp > 0` on first sight means the row mounted for a
  // level that had just been added, which should flash.
  const flashRef = useFlash(
    [stamp],
    side === "bid" ? "rgba(34,197,94,0.30)" : "rgba(239,68,68,0.30)",
    520,
    stamp > 0
  );
  return (
    <div className="relative grid grid-cols-3 items-center h-5 shrink-0 px-3 text-[11.5px]">
      {/* cumulative-depth bar grows from the right edge. The width transition is
          what stops the ladder from snapping between frames: the bar slides to
          its new depth over one frame-budget-friendly 260ms instead of jumping,
          which is most of what reads as "smooth" in a live book. */}
      <div
        aria-hidden
        className="absolute inset-y-0 right-0 motion-safe:transition-[width] motion-safe:duration-[260ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{
          width: `${pct}%`,
          backgroundColor: side === "bid" ? "rgba(34,197,94,0.10)" : "rgba(239,68,68,0.10)",
        }}
      />
      {/* Flash overlay — full width, above the depth bar, below the text. */}
      <div ref={flashRef} aria-hidden className="absolute inset-0 pointer-events-none" />
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
