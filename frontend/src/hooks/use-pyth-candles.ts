"use client";

import { startPoll } from "@/lib/poll";
import { useCallback, useEffect, useRef, useState } from "react";

export interface Candle {
  t: number; // bucket start (unix seconds)
  o: number;
  h: number;
  l: number;
  c: number;
}

/** TradingView-style resolution codes the Benchmarks API accepts. */
export interface Resolution {
  label: string;
  /** UDF resolution code (e.g. "1", "60", "D"). */
  code: string;
  /** Bucket width in seconds (for live-candle bucketing of the streamed price). */
  seconds: number;
  /** How far back to load, in seconds. */
  lookback: number;
}

export const RESOLUTIONS: Resolution[] = [
  { label: "1m", code: "1", seconds: 60, lookback: 60 * 60 * 3 },
  { label: "5m", code: "5", seconds: 300, lookback: 60 * 60 * 12 },
  { label: "15m", code: "15", seconds: 900, lookback: 60 * 60 * 36 },
  { label: "1H", code: "60", seconds: 3600, lookback: 60 * 60 * 24 * 7 },
  { label: "4H", code: "240", seconds: 14400, lookback: 60 * 60 * 24 * 30 },
  { label: "1D", code: "D", seconds: 86400, lookback: 60 * 60 * 24 * 180 },
];

/** Stable identity, so clearing on a resolution switch hands consumers the same
 *  reference the hook started with instead of invalidating their memos. */
const NO_CANDLES: Candle[] = [];

/**
 * Load REAL historical OHLC candles for SOL/USD from Pyth Benchmarks (via the
 * same-origin /api/pyth/history proxy). These are genuine measured candles from
 * Pythnet — not client-accumulated samples.
 */
export function usePythCandles(resolution: Resolution) {
  const [candles, setCandles] = useState<Candle[]>(NO_CANDLES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);
  /** The resolution `candles` was measured at. */
  const loadedRes = useRef<Resolution | null>(null);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    // The ONLY place the series is cleared. A resolution switch must drop it —
    // candles measured at the previous bucket width must not sit under the new
    // interval's label and time axis, and if this request then fails they must
    // not sit there indefinitely. A 60s REFRESH must not: nothing was lost, the
    // history we hold is still the same measured history.
    //
    // Both failure paths below used to clear it, so one 15s Benchmarks blip
    // blanked the chart, the OHLC legend, the market bar's 24h high/low and the
    // header change% to "Couldn't load price history" for a full minute — while
    // the data sat in the closure that had just wiped it. The live stream keeps
    // driving the right edge in the meantime, so the worst case on screen is a
    // series up to 60s stale at its left end. `error` is still set on failure;
    // price-chart surfaces it only when it has fewer than 2 candles to draw,
    // which is exactly the case where there is nothing worth keeping.
    if (loadedRes.current !== resolution) {
      loadedRes.current = resolution;
      setCandles(NO_CANDLES); // same reference on mount, so React bails out
    }
    setLoading(true);
    setError(null);
    try {
      const to = Math.floor(Date.now() / 1000);
      const from = to - resolution.lookback;
      const url =
        `/api/pyth/history?symbol=${encodeURIComponent("Crypto.SOL/USD")}` +
        `&resolution=${resolution.code}&from=${from}&to=${to}`;
      const res = await fetch(url);
      const data = await res.json();
      if (id !== reqId.current) return; // a newer request superseded this one
      if (data.s !== "ok" || !Array.isArray(data.t)) {
        setError(data.errmsg || "no data");
        return;
      }
      const out: Candle[] = data.t.map((t: number, i: number) => ({
        t,
        o: data.o[i],
        h: data.h[i],
        l: data.l[i],
        c: data.c[i],
      }));
      setCandles(out);
    } catch (e) {
      if (id === reqId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [resolution]);

  useEffect(() => {
    load();
    // Refresh history periodically so closed candles stay accurate; the live
    // stream handles the forming candle in between.
    return startPoll(load, 60_000);
  }, [load]);

  return { candles, loading, error, reload: load };
}
