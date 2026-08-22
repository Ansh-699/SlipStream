"use client";

import { useEffect, useReducer } from "react";
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

/**
 * ONE socket for the whole app, shared by every caller.
 *
 * useLivePrice is called at five mount points on /trade (market-bar,
 * price-chart, status-panel, status-strip, use-mark-price) and each used to
 * open its own WebSocket and its own accountSubscribe against the same feed —
 * five sockets, five 20 msg/s streams, five setState storms driving five
 * separate render trees, and five independent reconnect loops.
 *
 * The reconnect also had no discipline: a flat 2s retry, no attempt counter, no
 * cap, no jitter. Against an endpoint that accepts TCP and then stalls (what a
 * proxy or LB outage looks like, as opposed to outright refusal) those sockets
 * pile up in CONNECTING against the per-host cap. It now backs off
 * geometrically to a ceiling.
 */
interface FeedState {
  live: LivePrice | null;
  connected: boolean;
}

const feed: FeedState = { live: null, connected: false };
const feedSubscribers = new Set<() => void>();
let feedSocket: WebSocket | null = null;
let feedRetry: ReturnType<typeof setTimeout> | null = null;
let feedFailures = 0;

function publish() {
  feedSubscribers.forEach((f) => f());
}

function openFeed() {
  if (feedSocket) return;
  const wsUrl = ER_RPC_DIRECT.replace(/^http/, "ws");
  const ws = new WebSocket(wsUrl);
  feedSocket = ws;

  ws.onopen = () => {
    feedFailures = 0;
    feed.connected = true;
    publish();
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "accountSubscribe",
        // `processed` is the whole point: waiting for `confirmed` would throw
        // away the 50ms cadence we came here for.
        params: [SOL_USD_FEED, { encoding: "base64", commitment: "processed" }],
      })
    );
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.method !== "accountNotification") return;
      const b64 = msg.params?.result?.value?.data?.[0];
      if (!b64) return;
      const next = decodeFeed(b64);
      if (next) {
        feed.live = next;
        publish();
      }
    } catch {
      /* ignore malformed frame */
    }
  };

  ws.onerror = () => {
    feed.connected = false;
    publish();
  };

  ws.onclose = () => {
    feed.connected = false;
    feedSocket = null;
    publish();
    if (feedSubscribers.size === 0) return; // nobody is listening; stay closed
    feedFailures = Math.min(feedFailures + 1, 5);
    const delay = Math.min(2000 * 2 ** (feedFailures - 1), 30_000);
    feedRetry = setTimeout(openFeed, delay);
  };
}

function closeFeedIfIdle() {
  if (feedSubscribers.size > 0) return;
  if (feedRetry) {
    clearTimeout(feedRetry);
    feedRetry = null;
  }
  const ws = feedSocket;
  feedSocket = null;
  ws?.close();
  feed.connected = false;
}

export function useLivePrice(): { live: LivePrice | null; connected: boolean } {
  const [, rerender] = useReducer((c: number) => c + 1, 0);

  useEffect(() => {
    const notify = () => rerender();
    feedSubscribers.add(notify);
    openFeed();
    return () => {
      feedSubscribers.delete(notify);
      closeFeedIfIdle();
    };
  }, []);

  return { live: feed.live, connected: feed.connected };
}
