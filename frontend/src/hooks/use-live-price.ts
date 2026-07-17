"use client";

import { useEffect, useRef, useState } from "react";
import { ER_RPC_DIRECT } from "@/lib/manifest";

/**
 * Live SOL/USD price from the MagicBlock Pyth-Lazer feed inside the Ephemeral
 * Rollup, via a raw `accountSubscribe` WebSocket — a push stream, no polling.
 *
 * Source: Pyth Lazer data, pushed to the ER by MagicBlock's chain pusher at a
 * fixed 50ms cadence (~20 updates/sec, vs the ~1/sec Hermes SSE this replaced).
 *
 * WHY a direct WS instead of the same-origin /api/rpc/er proxy: the proxy exists
 * because browser *fetch* to the ER fails CORS (see manifest.ts). WebSockets are
 * not subject to CORS, so the browser can open this socket directly. The ER
 * endpoint is public and carries no API key, so nothing is leaked by doing so.
 *
 * NOTE this is the DISPLAY price only. The market still settles against the Pyth
 * oracle on L1 (`market.pyth_feed`); this feed has no on-chain signature
 * verification and a single MagicBlock-controlled writer, so it must not be used
 * for anything custodial. See docs/research/magicblock-price-feed.md.
 */

/**
 * SOL/USD Pyth-Lazer feed PDA, owned by MagicBlock's ephemeral-oracle program
 * `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`.
 * Derivation: seeds ["price_feed", "pyth-lazer", "6"] where "6" is the decimal
 * pyth_lazer_id for SOLUSD. Constant, so hardcoded rather than derived at runtime.
 */
const SOL_USD_FEED = "ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu";

/**
 * Byte offsets into the feed account. The layout is MagicBlock's `PriceUpdateV3`,
 * which is field-for-field identical to Pyth's `PriceUpdateV2`:
 *   8 disc | 32 write_authority | 1 verification_level | price_message{ feed_id[32],
 *   price i64, conf u64, exponent i32, publish_time i64, ... } | posted_slot u64
 */
const PRICE_OFFSET = 73;
const EXPO_OFFSET = 89;
const PUBLISH_TIME_OFFSET = 93;

export interface LivePrice {
  /** Human price (USD). */
  price: number;
  /** Publish time (unix seconds). */
  publishTime: number;
}

/** ER account data (base64) -> LivePrice, or null if the bytes are unusable. */
function decodeFeed(b64: string): LivePrice | null {
  const bin = atob(b64);
  if (bin.length < PUBLISH_TIME_OFFSET + 8) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dv = new DataView(bytes.buffer);

  const raw = dv.getBigInt64(PRICE_OFFSET, true);
  if (raw <= 0n) return null; // zeroed/uninitialised feed

  // GOTCHA: MagicBlock stores the exponent with the OPPOSITE sign to Pyth — it
  // writes +8 where Pyth writes -8, so the scale is 10^(-exponent), not
  // 10^(exponent). Their own on-chain sample does the same (`10f64.powi(-expo)`).
  const expo = dv.getInt32(EXPO_OFFSET, true);
  const price = Number(raw) * Math.pow(10, -expo);
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    price,
    publishTime: Number(dv.getBigInt64(PUBLISH_TIME_OFFSET, true)),
  };
}

export function useLivePrice(): { live: LivePrice | null; connected: boolean } {
  const [live, setLive] = useState<LivePrice | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const wsUrl = ER_RPC_DIRECT.replace(/^http/, "ws");

    function connect() {
      if (cancelled) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "accountSubscribe",
            // `processed` is the whole point: waiting for `confirmed` would
            // throw away the 50ms cadence we came here for.
            params: [SOL_USD_FEED, { encoding: "base64", commitment: "processed" }],
          })
        );
      };

      ws.onmessage = (ev) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.method !== "accountNotification") return;
          const b64 = msg.params?.result?.value?.data?.[0];
          if (!b64) return;
          const next = decodeFeed(b64);
          if (next) setLive(next);
        } catch {
          /* ignore malformed frame */
        }
      };

      ws.onerror = () => !cancelled && setConnected(false);

      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        retry = setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  return { live, connected };
}
