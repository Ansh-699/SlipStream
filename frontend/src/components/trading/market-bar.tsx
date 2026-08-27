"use client";

import { useMemo } from "react";
import { useMarket } from "@/hooks/use-market";
import { useMarkPrice } from "@/hooks/use-mark-price";
import { usePythCandles, RESOLUTIONS } from "@/hooks/use-pyth-candles";

/** 1H candles, so the last 24 buckets are exactly a rolling day. */
const DAY_RESOLUTION = RESOLUTIONS.find((r) => r.code === "60") ?? RESOLUTIONS[3];

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  const color =
    tone === "up" ? "text-[var(--t-up)]" : tone === "down" ? "text-[var(--t-down)]" : "text-[var(--t-text)]";
  return (
    <div className="flex shrink-0 flex-col justify-center gap-0.5">
      <span className="text-[10.5px] leading-none text-[var(--t-text-3)]">{label}</span>
      <span className={`tnum text-[13px] font-medium leading-none ${color}`}>{value}</span>
    </div>
  );
}

export function MarketBar() {
  const { market, status } = useMarket(0);
  // useMarkPrice mounts useMarket(0) itself; both go through useSharedSource on
  // the same `market:0` key, so this is the same poller, not a second one.
  const { nowSec, mark, reference, stale, reason } = useMarkPrice(0);
  const { candles } = usePythCandles(DAY_RESOLUTION);

  const day = useMemo(() => {
    if (candles.length < 2) return null;
    const window = candles.slice(-24);
    const high = Math.max(...window.map((c) => c.h));
    const low = Math.min(...window.map((c) => c.l));
    const open = window[0].o;
    const newest = window[window.length - 1];
    const last = newest.c;
    return {
      high,
      low,
      t: newest.t,
      change: last - open,
      changePct: open > 0 ? ((last - open) / open) * 100 : 0,
    };
  }, [candles]);

  // usePythCandles deliberately KEEPS the last good series when a refresh fails
  // (a 15s Benchmarks blip must not blank the bar), so nothing in `candles`
  // announces an outage — during a multi-hour one this bar would keep printing
  // 6-hour-old buckets as "24h High / Low / +2.42%". Age of the newest bucket,
  // not the hook's `error`, is the right test: `error` is cleared at the start
  // of every retry, so it flickers null once a minute throughout an outage,
  // and it also fires for blips that cost nothing. Two full buckets missed
  // means the poll has been failing for over an hour.
  // CEILING: at 1H buckets that is a ~2h detection lag; the recompute rides the
  // 5s tick useMarkPrice already re-renders this component with.
  const dayStale = day !== null && nowSec - day.t > 2 * DAY_RESOLUTION.seconds;

  // The headline is `reference`: the oracle while its stream is actually
  // delivering, else a mark the program itself would still accept, else
  // nothing. Mark only moves when the TWAP crank runs; if the keepers stop,
  // mark freezes while the market does not, and showing a frozen number as
  // "the price" is a lie — so when neither price can be trusted this renders an
  // em dash rather than substituting one that can't.
  //
  // This used to be `spot ?? markPrice` off a raw useLivePrice read, and both
  // halves were wrong. `live` was handed out whether or not the socket was up,
  // so a dropped feed left the 22px headline printing its last frame while the
  // 24h change beside it kept refreshing from the Pyth history poll — the
  // header read "97.55 +2.30 +2.42%" over a price that stopped minutes ago. And
  // when the socket never connected at all it fell through to the raw on-chain
  // mark with no freshness test, headlining a 23%-wrong mark with `markStale`
  // false, because the divergence check needed the very oracle that was down.
  // Both gates (socket up, reading recent, stamp fresh) now live in
  // useMarkPrice, which is the one place that owns them.
  const headline = reference;
  // Null means "the direction is unknown", and it has to stay null rather than
  // collapse to a boolean: `(day?.change ?? 0) >= 0` read an absent 24h change
  // as "up", which painted the 22px em dash --t-up green on every cold load and
  // kept tinting the headline from a stale delta during a history outage.
  const up = day && !dayStale ? day.change >= 0 : null;

  return (
    <div className="flex h-[56px] shrink-0 items-center gap-5 overflow-x-auto border-b border-[var(--t-border)] px-4">
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[14px] font-semibold tracking-tight text-[var(--t-text)]">SOL-PERP</span>
        {market?.circuitBreakerActive ? (
          <span className="rounded bg-[var(--t-down-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--t-down)]">
            PAUSED
          </span>
        ) : market?.restrictedMode ? (
          <span className="rounded bg-[var(--t-down-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--t-down)]">
            CLOSES ONLY
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-baseline gap-2.5">
        {/* Colour is a directional claim, so it branches on the value being
            known before it branches on the sign — the shape positions-table
            uses for uPnL. A green em dash asserts a rise on the one element
            that is admitting it has no price. */}
        <span
          className={`tnum text-[22px] font-semibold leading-none tracking-tight ${
            headline === null
              ? "text-[var(--t-text-3)]"
              : up === null
                ? "text-[var(--t-text)]"
                : up
                  ? "text-[var(--t-up)]"
                  : "text-[var(--t-down)]"
          }`}
        >
          {headline !== null ? headline.toFixed(2) : "—"}
        </span>
        {day && up !== null && (
          <span className={`tnum text-[12px] font-medium ${up ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>
            {/* The absolute change carries a $ and the percentage is bracketed.
                Printed bare and side by side as "+11.30 +11.78%", the first
                number has no unit and reads as a second percentage — two
                signed figures of the same magnitude, one of which silently
                means dollars. */}
            {up ? "+" : "−"}${Math.abs(day.change).toFixed(2)}{" "}
            ({up ? "+" : "−"}{Math.abs(day.changePct).toFixed(2)}%)
          </span>
        )}
      </div>

      <div className="h-7 w-px shrink-0 bg-[var(--t-border)]" />

      <div className="flex items-center gap-6">
        <Stat
          label={stale ? "Mark (stale)" : "Mark"}
          value={mark !== null ? mark.toFixed(3) : "—"}
          tone={stale ? "down" : undefined}
        />
        {/* Kept and labelled rather than blanked, exactly as the Mark stat
            beside them: these are real measured buckets, just old ones. */}
        <Stat label={dayStale ? "24h High (stale)" : "24h High"} value={day ? day.high.toFixed(2) : "—"} />
        <Stat label={dayStale ? "24h Low (stale)" : "24h Low"} value={day ? day.low.toFixed(2) : "—"} />
        <Stat
          label="OI Long"
          value={market ? (Number(market.openInterestLong) / 1e9).toFixed(2) : "—"}
        />
        <Stat
          label="OI Short"
          value={market ? (Number(market.openInterestShort) / 1e9).toFixed(2) : "—"}
        />
      </div>

      {/* One banner, `reason` straight from useMarkPrice. The old text asserted
          "the TWAP crank has stopped" for ANY mark/oracle gap, which is only one
          of the causes and was false whenever the mark was drifting for some
          other reason. `reason` also covers the case that had no banner at all:
          the oracle stream being down, which is why the headline above may be
          showing the on-chain mark. That case is not a fault, so it is stated
          plainly rather than in the amber warning box. */}
      {reason ? (
        <div
          role="status"
          className={`ml-auto shrink-0 rounded px-2.5 py-1 text-[11px] font-medium ${
            stale
              ? "border border-[var(--t-warn)]/40 bg-[var(--t-warn)]/10 text-[var(--t-warn)]"
              : "text-[var(--t-text-2)]"
          }`}
        >
          {reason.charAt(0).toUpperCase() + reason.slice(1)}
        </div>
      ) : status === "unavailable" ? (
        <span className="ml-auto shrink-0 text-[11px] text-[var(--t-text-2)]">
          Can&apos;t reach Solana — retrying.
        </span>
      ) : null}
    </div>
  );
}
