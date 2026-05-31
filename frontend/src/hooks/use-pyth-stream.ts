"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Live SOL/USD price via Pyth Hermes Server-Sent Events — a real push stream,
 * NOT polling. Hermes pushes a new price-update event whenever the aggregate
 * moves, so the UI reflects the oracle in real time with no fixed interval.
 *
 * Source of truth: Pyth (the same oracle this market settles against). Feed id
 * is the canonical Crypto.SOL/USD price feed.
 */
const SOL_USD_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const HERMES_SSE =
  `https://hermes.pyth.network/v2/updates/price/stream` +
  `?ids[]=${SOL_USD_FEED_ID}&parsed=true`;

export interface LivePrice {
  /** Human price (USD). */
  price: number;
  /** Pyth confidence interval (USD). */
  conf: number;
  /** Publish time (unix seconds). */
  publishTime: number;
}

export function usePythStream(): { live: LivePrice | null; connected: boolean } {
  const [live, setLive] = useState<LivePrice | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const es = new EventSource(HERMES_SSE);
      esRef.current = es;

      es.onopen = () => !cancelled && setConnected(true);

      es.onmessage = (ev) => {
        if (cancelled) return;
        try {
          const data = JSON.parse(ev.data);
          const p = data?.parsed?.[0]?.price;
          if (!p) return;
          // price.price is an integer; price.expo is the (negative) exponent.
          const expo = p.expo as number;
          const raw = Number(p.price);
          const conf = Number(p.conf);
          const scale = Math.pow(10, expo);
          setLive({
            price: raw * scale,
            conf: conf * scale,
            publishTime: p.publish_time as number,
          });
        } catch {
          /* ignore malformed event */
        }
      };

      es.onerror = () => {
        // EventSource auto-reconnects, but if the browser closed it, re-open.
        setConnected(false);
        if (es.readyState === EventSource.CLOSED && !cancelled) {
          es.close();
          setTimeout(connect, 2000);
        }
      };
    }

    connect();
    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  return { live, connected };
}
