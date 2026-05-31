"use client";

import { useEffect, useRef, useState } from "react";

export interface PriceSample {
  /** Unix ms timestamp the sample was recorded. */
  t: number;
  /** Human-readable price. */
  p: number;
}

const STORAGE_KEY = "slipstream:price-history:0";

/**
 * Accumulate an in-memory (and localStorage-persisted) time-series of price
 * samples. Each time `price` changes to a new finite, positive value the sample
 * is appended; the buffer is capped at `maxSamples` (ring-style) to bound memory.
 *
 * Persistence lets the chart survive refreshes / HMR so the candle + timeframe
 * views have history to bucket immediately instead of starting empty every time.
 * No fabricated data — only real mark-price observations are stored.
 */
export function usePriceHistory(
  price: number | null | undefined,
  maxSamples = 2000
): PriceSample[] {
  const [samples, setSamples] = useState<PriceSample[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as PriceSample[];
      return Array.isArray(parsed) ? parsed.slice(-maxSamples) : [];
    } catch {
      return [];
    }
  });
  const lastRef = useRef<number | null>(null);

  useEffect(() => {
    if (price == null || !Number.isFinite(price) || price <= 0) return;
    if (lastRef.current === price) return;
    lastRef.current = price;
    setSamples((prev) => {
      const next = [...prev, { t: Date.now(), p: price }];
      const capped =
        next.length > maxSamples ? next.slice(next.length - maxSamples) : next;
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(capped));
      } catch {
        /* ignore quota */
      }
      return capped;
    });
  }, [price, maxSamples]);

  return samples;
}

export interface Candle {
  t: number; // bucket start (ms)
  o: number;
  h: number;
  l: number;
  c: number;
}

/**
 * Bucket raw samples into OHLC candles of `bucketMs` width. Pure function over
 * the observed samples — gaps simply produce fewer candles (no synthetic fill).
 */
export function bucketCandles(samples: PriceSample[], bucketMs: number): Candle[] {
  if (samples.length === 0) return [];
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const s of samples) {
    const bucket = Math.floor(s.t / bucketMs) * bucketMs;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: s.p, h: s.p, l: s.p, c: s.p };
    } else {
      cur.h = Math.max(cur.h, s.p);
      cur.l = Math.min(cur.l, s.p);
      cur.c = s.p;
    }
  }
  if (cur) out.push(cur);
  return out;
}
