"use client";

import { useMemo } from "react";
import { useMarket } from "@/hooks/use-market";
import { useLivePrice } from "@/hooks/use-live-price";
import { usePythCandles, RESOLUTIONS } from "@/hooks/use-pyth-candles";

const PRICE_SCALE = 1_000_000;

/** 1H candles, so the last 24 buckets are exactly a rolling day. */
const DAY_RESOLUTION = RESOLUTIONS.find((r) => r.code === "60") ?? RESOLUTIONS[3];

/** Mark is allowed to drift from the oracle; past this it is a fault, not noise. */
const MARK_DIVERGENCE_WARN = 0.01;

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
  const { live } = useLivePrice();
  const { candles } = usePythCandles(DAY_RESOLUTION);

  const markPrice = market ? Number(market.lastMarkPrice) / PRICE_SCALE : null;
  const spot = live?.price ?? null;

  const day = useMemo(() => {
    if (candles.length < 2) return null;
    const window = candles.slice(-24);
    const high = Math.max(...window.map((c) => c.h));
    const low = Math.min(...window.map((c) => c.l));
    const open = window[0].o;
    const last = window[window.length - 1].c;
    return { high, low, change: last - open, changePct: open > 0 ? ((last - open) / open) * 100 : 0 };
  }, [candles]);

  // The headline is the oracle price, not the on-chain mark. Mark only moves when
  // the TWAP crank runs; if the keepers stop, mark freezes while the market does
  // not, and showing the frozen number as "the price" would be a lie.
  const headline = spot ?? markPrice;
  const up = (day?.change ?? 0) >= 0;

  const divergence =
    markPrice !== null && spot !== null && spot > 0
      ? Math.abs(markPrice - spot) / spot
      : null;
  const markStale = divergence !== null && divergence > MARK_DIVERGENCE_WARN;

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
        <span
          className={`tnum text-[22px] font-semibold leading-none tracking-tight ${
            up ? "text-[var(--t-up)]" : "text-[var(--t-down)]"
          }`}
        >
          {headline !== null ? headline.toFixed(2) : "—"}
        </span>
        {day && (
          <span className={`tnum text-[12px] font-medium ${up ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>
            {up ? "+" : ""}
            {day.change.toFixed(2)} {up ? "+" : ""}
            {day.changePct.toFixed(2)}%
          </span>
        )}
      </div>

      <div className="h-7 w-px shrink-0 bg-[var(--t-border)]" />

      <div className="flex items-center gap-6">
        <Stat
          label={markStale ? "Mark (stale)" : "Mark"}
          value={markPrice !== null && markPrice > 0 ? markPrice.toFixed(3) : "—"}
          tone={markStale ? "down" : undefined}
        />
        <Stat label="24h High" value={day ? day.high.toFixed(2) : "—"} />
        <Stat label="24h Low" value={day ? day.low.toFixed(2) : "—"} />
        <Stat
          label="OI Long"
          value={market ? (Number(market.openInterestLong) / 1e9).toFixed(2) : "—"}
        />
        <Stat
          label="OI Short"
          value={market ? (Number(market.openInterestShort) / 1e9).toFixed(2) : "—"}
        />
      </div>

      {markStale && (
        <div
          role="status"
          className="ml-auto shrink-0 rounded border border-[var(--t-warn)]/40 bg-[var(--t-warn)]/10 px-2.5 py-1 text-[11px] font-medium text-[var(--t-warn)]"
        >
          Mark is {(divergence! * 100).toFixed(1)}% off the oracle — the TWAP crank has stopped.
        </div>
      )}

      {status === "unavailable" && !markStale && (
        <span className="ml-auto shrink-0 text-[11px] text-[var(--t-text-2)]">
          Can&apos;t reach Solana — retrying.
        </span>
      )}
    </div>
  );
}
