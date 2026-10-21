"use client";

import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useOrderBook, BOOK_DEPTH } from "@/hooks/use-orderbook";
import { useOpenOrders } from "@/hooks/use-open-orders";
import { useWallet } from "@/hooks/use-wallet-compat";
import { explorerAddress, TICK_SIZE } from "@/lib/manifest";
import { pickBookPrice } from "@/lib/ticket-bus";
import { erSocket } from "@/lib/er-socket";
import { Spinner } from "@/components/ui/spinner";

// Every level the feed carries (the columns scroll): capping at the twenty that
// fit on screen hid a trader's own far-from-mid order behind the maker's rungs.
const DEPTH = BOOK_DEPTH;
const SKELETON_ROWS = 16;
const PRICE_SCALE = 1_000_000;
// Shared formatters: toLocaleString with options builds a formatter per call --
// per row, per side, per book update, which at push rate is real main-thread time.
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const BOOK_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const subscribeSocket = (onChange: () => void) => {
  const off = erSocket()?.onStatus(onChange);
  return () => {
    off?.();
  };
};
const socketOpen = () => erSocket()?.open ?? false;
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Placeholder ladder while the first read is in flight: the real book's exact
 * structure (asks, mid row, bids, pressure bar) with depth bars that deepen
 * away from the mid, under one shimmer. A blank panel reads as broken. */
function BookSkeleton() {
  const rows = (side: "ask" | "bid") =>
    Array.from({ length: SKELETON_ROWS }, (_, i) => {
      // Distance from the mid: asks render top-down toward it, bids away from it.
      const depth = side === "ask" ? SKELETON_ROWS - 1 - i : i;
      return (
        <div key={`${side}${i}`} className="relative grid h-5 shrink-0 grid-cols-3 items-center border-b border-[var(--t-border)]/40 px-3">
          <span
            aria-hidden
            className={`absolute inset-y-0 right-0 ${side === "ask" ? "bg-[var(--t-book-ask)]" : "bg-[var(--t-book-bid)]"} opacity-[0.10]`}
            style={{ width: `${Math.min(96, 8 + depth * 6 + ((i * 7) % 5))}%` }}
          />
          <span className={`relative h-2 w-[52px] rounded-sm ${side === "ask" ? "bg-[var(--t-down)]/25" : "bg-[var(--t-up)]/25"}`} />
          <span className="relative ml-auto h-2 rounded-sm bg-[var(--t-surface-3)]" style={{ width: `${18 + ((i * 5) % 3) * 6}px` }} />
          <span className="relative ml-auto h-2 w-9 rounded-sm bg-[var(--t-surface-3)]" />
        </div>
      );
    });
  return (
    <div role="status" aria-label="Loading the live order book" className="book-shimmer relative flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">{rows("ask")}</div>
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-y border-[var(--t-border)] px-3">
        <span className="h-4 w-[72px] rounded-sm bg-[var(--t-surface-3)]" />
        <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-[var(--t-text-3)]">
          <Spinner className="h-3 w-3" /> Syncing the rollup book…
        </span>
        <span className="ml-auto h-2 w-[64px] rounded-sm bg-[var(--t-surface-3)]" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-start overflow-hidden">{rows("bid")}</div>
    </div>
  );
}
/** Smallest price increment the program will accept, straight from the manifest. */
const tickSize = (Number(TICK_SIZE) / PRICE_SCALE).toFixed(3);

export function OrderBookDisplay() {
  // `status` and `updatedAt` are the point of this hook's return shape: an empty
  // ladder has three different causes and a POPULATED ladder has two — current,
  // or the last good one held on screen while every read since has failed. That
  // second one used to render byte-for-byte identically to a live book, so a
  // trader could price a limit order off quotes that stopped minutes ago.
  const { bids, asks, trades, status, updatedAt, via } = useOrderBook(0);
  // Whether the rollup socket is up (and so the book is subscribed). A quiet
  // book sends no pushes, so `via` alone would call a live feed "polling".
  const streaming = useSyncExternalStore(subscribeSocket, socketOpen, () => false);
  const [tab, setTab] = useState<"book" | "trades">("book");
  // "side:price" of the viewer's resting orders, so the ladder can mark them.
  // Same shared decode as the ladder: no extra read.
  const { publicKey } = useWallet();
  const { orders: mine } = useOpenOrders(publicKey ?? null, 0);
  const own = useMemo(
    () => new Set(mine.map((o) => `${o.isLong ? "bid" : "ask"}:${o.price}`)),
    [mine]
  );

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
        <span className="tk-chip">MagicBlock rollup</span>
        <span
          className="tk-chip"
          title={
            streaming
              ? "Subscribed: the rollup pushes the book over a websocket the moment it changes"
              : "The rollup socket is down; the book is re-read every 2s"
          }
        >
          {streaming ? "Live push" : via === null ? "Connecting" : "Polling"}
        </span>
        <span className="tk-chip">Tick {tickSize}</span>
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
            {empty && status === "loading" ? (
              <BookSkeleton />
            ) : empty ? (
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
                      price={l.price}
                      size={l.size}
                      total={l.total}
                      pct={depthPct(l.total, maxCum)}
                      side="ask"
                      stamp={levelStamps.get(`a:${l.price}`) ?? 0}
                      mine={own.has(`ask:${l.price}`)}
                    />
                  ))}
                </div>

                <MidRow mid={mid} spread={spread} />

                {/* Bids — scrollable, anchored to the top (best bid near the mid) */}
                <div className="flex-1 flex flex-col justify-start min-h-0 overflow-y-auto slim-scroll">
                  {bidRows.map((l) => (
                    <Row
                      key={`b-${l.price}`}
                      price={l.price}
                      size={l.size}
                      total={l.total}
                      pct={depthPct(l.total, maxCum)}
                      side="bid"
                      stamp={levelStamps.get(`b:${l.price}`) ?? 0}
                      mine={own.has(`bid:${l.price}`)}
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
              <div className="h-full flex items-center justify-center gap-2 text-[12px] text-[var(--t-text-2)]">
                {/* Same three-way split as the book: the fill ring comes from the
                    same account and the same read, so "No trades yet" was being
                    printed for a market that is trading whenever that read was
                    failing or had not landed yet. */}
                {status === "loading"
                  ? <><Spinner /> Loading trades…</>
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
                  <span className="text-right tnum text-[var(--t-text)]">{AMOUNT.format(t.size)}</span>
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



/** Cumulative depth as a bar width. Square-root scaled (as Equinox does): on a
 *  linear scale the far levels' totals dwarf the near ones and every bar near
 *  the mid -- the ones a trader reads -- is a sliver. */
function depthPct(total: number, maxCum: number): number {
  return Math.min(100, Math.sqrt(total / maxCum) * 100);
}

/**
 * Flash a row's overlay when its level changes.
 *
 * Web Animations API rather than a CSS class toggle: re-applying the SAME
 * animation name to an element does not restart it, so a class-based flash
 * silently stops firing once a row updates twice in a row -- which is every row,
 * every tick, on a live book. `element.animate()` builds a fresh animation each
 * call, so it always restarts, and it needs no extra state and no re-render.
 *
 * It animates OPACITY over a pre-tinted overlay, not a background colour:
 * opacity runs on the compositor, so a burst of pushes flashing a dozen rows
 * costs no paint on the main thread.
 *
 * Never flashes on FIRST paint unless asked: `prev === null` means "we have not
 * seen a value yet", not "the value changed", and without that distinction the
 * whole ladder strobes on every mount and every tab switch.
 *
 * Honours prefers-reduced-motion by simply not animating -- the numbers still
 * update, they just do not pulse.
 */
function useFlash(signal: number, durationMs = 420, flashOnFirst = false) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef<number | null>(null);
  useEffect(() => {
    const first = prev.current === null;
    // `flashOnFirst` covers a level that appears as a NEW row rather than by
    // re-pricing an existing one: the component mounts already carrying a
    // change stamp, and treating that as "first sight, nothing changed" would
    // swallow the one flash the user most wants to see — a level being ADDED.
    const changed = first ? flashOnFirst : prev.current !== signal;
    prev.current = signal;
    if (!changed) return;
    const el = ref.current;
    if (!el || typeof el.animate !== "function" || reducedMotion()) return;
    el.getAnimations().forEach((a) => a.cancel());
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: durationMs, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    // flashOnFirst is read only on the very first run by construction, so it is
    // deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal, durationMs]);
  return ref;
}

/**
 * Mid / spread, with a direction arrow, a transient tint on the number and a
 * row wash on change (Equinox's treatment). The colour is transient: it encodes
 * the direction of the last move in TIME and fades, so it cannot be read as a
 * standing "bid" or "ask" the way the ladder's side colours are.
 */
function MidRow({ mid, spread }: { mid: number | null; spread: number | null }) {
  // Direction lives in STATE, not in a ref read during render: React may render
  // without committing, so a ref-derived "previous" mid can advance for a paint
  // that never happened (react-hooks/refs).
  const [shown, setShown] = useState<"up" | "down" | null>(null);
  const prevMid = useRef<number | null>(null);
  const priceRef = useRef<HTMLSpanElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const p = prevMid.current;
    prevMid.current = mid;
    if (p === null || mid === null || mid === p) return;
    const direction = mid > p ? "up" : "down";
    setShown(direction);
    if (reducedMotion()) return;
    priceRef.current?.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 200, easing: BOOK_EASE });
    rowRef.current?.animate(
      [
        {
          backgroundColor:
            direction === "up"
              ? "color-mix(in srgb, var(--t-up) 13%, transparent)"
              : "color-mix(in srgb, var(--t-down) 13%, transparent)",
        },
        { backgroundColor: "transparent" },
      ],
      { duration: 320, easing: BOOK_EASE }
    );
  }, [mid]);

  return (
    <div ref={rowRef} className="relative h-[34px] shrink-0 flex items-baseline gap-2 px-3 border-y border-[var(--t-border)]">
      <span
        ref={priceRef}
        className={`relative text-[19px] font-bold tnum leading-[34px] ${
          shown === "up" ? "text-[var(--t-up)]" : shown === "down" ? "text-[var(--t-down)]" : "text-[var(--t-text)]"
        }`}
      >
        {mid !== null ? mid.toFixed(3) : "—"}
      </span>
      <span
        aria-hidden
        className={`inline-flex w-3 shrink-0 self-center ${shown === "up" ? "text-[var(--t-up)]" : "text-[var(--t-down)]"} ${
          shown && mid !== null ? "opacity-100" : "opacity-0"
        }`}
      >
        {shown === "down" ? <ArrowDown size={12} strokeWidth={2} /> : <ArrowUp size={12} strokeWidth={2} />}
      </span>
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

/**
 * One ladder level. Memoised: a push re-renders the panel, but a level whose
 * price, size, total, bar, stamp and ownership are unchanged -- most of them,
 * on most pushes -- skips its render entirely.
 *
 * A button: clicking a level prices the order ticket's limit order there.
 */
const Row = memo(function Row({
  price,
  size,
  total,
  pct,
  side,
  stamp,
  mine,
}: {
  price: number;
  size: number;
  total: number;
  /** Depth bar width, 0-100. */
  pct: number;
  side: "bid" | "ask";
  /** Bumped by useLevelStamps only when THIS price level changed size or appeared. */
  stamp: number;
  /** The viewer has an order resting at this level. */
  mine: boolean;
}) {
  // Keyed off the level stamp, NOT off [price, size]: rows are keyed by price,
  // and the stamp only moves when this PRICE LEVEL actually changed, so a ladder
  // shifting by one slot does not strobe. `stamp > 0` on first sight means the
  // row mounted for a level that had just been added, which should flash.
  const flashRef = useFlash(stamp, 520, stamp > 0);
  const priceText = price.toFixed(3);
  const sizeText = AMOUNT.format(size);

  // A just-placed own order far from the mid: scroll its column (not the page)
  // so the trader sees it land.
  const rowRef = useRef<HTMLButtonElement>(null);
  const wasMine = useRef(mine);
  useEffect(() => {
    const row = rowRef.current;
    const column = row?.parentElement;
    if (mine && !wasMine.current && row && column) {
      const top = row.offsetTop - column.offsetTop;
      if (top < column.scrollTop || top + row.offsetHeight > column.scrollTop + column.clientHeight) {
        column.scrollTo({ top: top - column.clientHeight / 2, behavior: "smooth" });
      }
    }
    wasMine.current = mine;
  }, [mine]);

  return (
    <button
      type="button"
      ref={rowRef}
      onClick={() => pickBookPrice(price)}
      aria-label={`${side === "bid" ? "Bid" : "Ask"} ${priceText} dollars, ${sizeText} SOL; use this limit price`}
      title={mine ? "Your order rests at this price" : "Use this price"}
      data-mine={mine || undefined}
      className="relative grid h-8 w-full shrink-0 cursor-pointer grid-cols-3 items-center px-3 text-left text-[11.5px] hover:bg-[var(--t-surface-3)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)] sm:h-5"
    >
      {/* Cumulative-depth bar, grown from the right edge with a TRANSFORM, not a
          width: scaleX runs on the compositor, so sliding every bar to its new
          depth on a push costs no layout. */}
      <div
        aria-hidden
        className="absolute inset-y-0 right-0 w-full origin-right will-change-transform motion-safe:transition-transform motion-safe:duration-[200ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{
          transform: `scaleX(${pct / 100})`,
          backgroundColor: side === "bid" ? "var(--t-book-bid-fill)" : "var(--t-book-ask-fill)",
        }}
      />
      {/* Flash overlay — full width, above the depth bar, below the text. */}
      <div
        ref={flashRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0"
        style={{ backgroundColor: side === "bid" ? "var(--t-book-bid-flash)" : "var(--t-book-ask-flash)" }}
      />
      <span
        className={`relative flex items-center gap-1 tnum ${side === "bid" ? "text-[var(--t-up)]" : "text-[var(--t-down)]"} ${
          mine ? "font-semibold" : ""
        }`}
      >
        {mine ? <span aria-label="Your order" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--t-accent)]" /> : null}
        {priceText}
      </span>
      <span className="relative text-right tnum text-[var(--t-text)]">{sizeText}</span>
      <span className="relative text-right tnum text-[var(--t-text-2)]">{AMOUNT.format(total)}</span>
    </button>
  );
});
