"use client";

import { useMemo } from "react";
import { useOrderBook, type OrderBookLevel } from "@/hooks/use-orderbook";

/**
 * The landing hero's proof-of-life: the same order book the terminal renders,
 * read straight off the Ephemeral Rollup. The product's claim is speed, so the
 * page shows the running market rather than describing it.
 *
 * Depth is capped at the six levels per side the market maker actually quotes;
 * asking for twenty here would render fourteen blank rows on a healthy book.
 */
const DEPTH = 6;

const price2 = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const size2 = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Row({
  level,
  cum,
  maxCum,
  side,
}: {
  level: OrderBookLevel;
  cum: number;
  maxCum: number;
  side: "bid" | "ask";
}) {
  const pct = maxCum > 0 ? Math.min(100, (cum / maxCum) * 100) : 0;
  return (
    <div className="relative grid grid-cols-3 items-center px-3 py-[5px] text-[12px] tnum">
      <div
        aria-hidden
        className={`absolute inset-y-0 right-0 ${side === "bid" ? "depth-bid" : "depth-ask"}`}
        style={{ width: `${pct}%` }}
      />
      <span
        className={`relative font-semibold ${
          side === "bid" ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"
        }`}
      >
        {price2(level.price)}
      </span>
      <span className="relative text-right text-zinc-700 dark:text-white/70">{size2(level.size)}</span>
      <span className="relative text-right text-zinc-600 dark:text-white/55">{size2(cum)}</span>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div aria-hidden className="px-3 py-1 space-y-[9px]">
      {Array.from({ length: DEPTH * 2 + 1 }).map((_, i) => (
        <div key={i} className="h-[13px] rounded bg-white/[0.05]" />
      ))}
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-5 py-10 text-center">
      <p className="text-sm font-semibold text-zinc-800 dark:text-white/80">{title}</p>
      <p className="mx-auto mt-1.5 max-w-[38ch] text-[13px] leading-relaxed text-zinc-600 dark:text-white/50">{body}</p>
    </div>
  );
}

export function LiveBook() {
  const { bids, asks, spread, status, updatedAt } = useOrderBook(0);

  const { askRows, bidRows, maxCum, mid } = useMemo(() => {
    const cumulate = (levels: OrderBookLevel[]) => {
      let total = 0;
      return levels.slice(0, DEPTH).map((l) => {
        total += l.size;
        return { level: l, cum: total };
      });
    };
    const a = cumulate(asks);
    const b = cumulate(bids);
    return {
      askRows: a,
      bidRows: b,
      maxCum: Math.max(a.at(-1)?.cum ?? 0, b.at(-1)?.cum ?? 0),
      mid: bids.length && asks.length ? (bids[0].price + asks[0].price) / 2 : null,
    };
  }, [bids, asks]);

  const live = status === "live";
  // A frozen ladder is still worth showing, but it must not be labelled live.
  const showLadder = live || status === "stale";

  return (
    <figure className="panel mx-auto w-full max-w-[440px] overflow-hidden text-left">
      <figcaption className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-3">
        <span className="text-[13px] font-semibold">SOL-PERP</span>
        <span className="text-[11px] text-zinc-600 dark:text-white/55">Ephemeral Rollup</span>
        <span className="ml-auto flex items-center gap-1.5">
          {live && <span className="live-dot" aria-hidden />}
          {status === "stale" && (
            <span className="h-[7px] w-[7px] rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden />
          )}
          <span className="text-[11px] font-medium text-zinc-600 dark:text-white/50">
            {live
              ? "Live"
              : status === "stale"
                ? "Stale"
                : status === "loading"
                  ? "Connecting"
                  : "Offline"}
          </span>
        </span>
      </figcaption>

      <div className="grid grid-cols-3 px-3 pt-2.5 pb-1 text-[9.5px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-white/55">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Total</span>
      </div>

      {status === "loading" && <SkeletonRows />}

      {status === "unavailable" && (
        <Notice
          title="Can't reach the order book"
          body="Neither the rollup nor the base layer answered. The market may still be running — this page just can't read it right now."
        />
      )}

      {status === "empty" && (
        <Notice
          title="No resting quotes"
          body="The book decoded cleanly but nobody is quoting. The market-maker keeper is likely stopped."
        />
      )}

      {showLadder && (
        <div className="pb-1.5">
          {/* Asks descend toward the mid, so the best ask sits against the spread. */}
          <div className="flex flex-col-reverse">
            {askRows.map((r) => (
              <Row key={`a${r.level.price}`} level={r.level} cum={r.cum} maxCum={maxCum} side="ask" />
            ))}
          </div>

          <div className="my-1 flex items-baseline gap-2 border-y border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <span className="tnum text-[15px] font-bold">{mid !== null ? price2(mid) : "—"}</span>
            <span className="text-[10.5px] font-medium uppercase tracking-wider text-zinc-600 dark:text-white/55">Mid</span>
            {spread !== null && (
              <span className="tnum ml-auto text-[11px] text-zinc-600 dark:text-white/50">{price2(spread)} spread</span>
            )}
          </div>

          {bidRows.map((r) => (
            <Row key={`b${r.level.price}`} level={r.level} cum={r.cum} maxCum={maxCum} side="bid" />
          ))}
        </div>
      )}

      <p className="border-t border-white/[0.06] px-4 py-2.5 text-[10.5px] leading-relaxed text-zinc-600 dark:text-white/55">
        {status === "stale"
          ? "Lost contact with the rollup — these quotes are the last ones received, not current."
          : "Devnet. Liquidity is quoted by Slipstream's own market-maker bot, not organic flow."}
        {updatedAt !== null && (
          <>
            {" "}
            <span className="tnum">
              Updated {new Date(updatedAt).toLocaleTimeString("en-US", { hour12: false })}
            </span>
            .
          </>
        )}
      </p>
    </figure>
  );
}
