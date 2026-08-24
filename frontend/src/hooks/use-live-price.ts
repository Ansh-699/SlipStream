"use client";

import { useMemo, useSyncExternalStore } from "react";
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
  /**
   * The last reading the CURRENT connection delivered. Cleared when a new
   * socket is opened, and never handed to a consumer while `connected` is
   * false — see `getLive`.
   */
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
  // A socket that has not connected yet has delivered nothing, so the previous
  // connection's last frame is not this connection's price. Clearing it HERE
  // rather than at close is what closes the reconnect window: `onopen` flips
  // `connected` true the instant the WS handshake completes, which on a slow ER
  // is seconds before the first accountNotification arrives — long enough for
  // the pre-outage number to read as live again. Same window on remount, since
  // closeFeedIfIdle leaves the last frame behind when the last subscriber goes.
  feed.live = null;
  const wsUrl = ER_RPC_DIRECT.replace(/^http/, "ws");
  const ws = new WebSocket(wsUrl);
  feedSocket = ws;

  // Identity guard on all four handlers. WebSocket.close() dispatches onclose
  // on a LATER task, so a socket opened between close() and that delivery had
  // its only reference erased by the PREVIOUS socket's handler — and since
  // closeFeedIfIdle can only ever close `feedSocket`, the orphan became
  // unreachable while still streaming at 50ms. onclose then saw subscribers
  // remaining and opened a third. React StrictMode's cleanup-then-setup in one
  // commit triggers this on every dev page load (next.config.ts sets no
  // reactStrictMode, which defaults it ON), and in production any remount
  // inside the close handshake does it: error-boundary reset, bfcache restore,
  // fast back/forward.
  ws.onopen = () => {
    if (feedSocket !== ws) return;
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
    if (feedSocket !== ws) return;
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
    if (feedSocket !== ws) return;
    feed.connected = false;
    publish();
  };

  ws.onclose = () => {
    // An orphan closing must not report the LIVE socket as disconnected, which
    // rendered "Oracle stream reconnecting" over a working stream, nor schedule
    // a redundant reconnect.
    if (feedSocket !== ws) return;
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
  // The guards above make ordering non-load-bearing, but closing a socket whose
  // handlers can no longer see it is the clearer statement of intent.
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.close();
  }
  feed.connected = false;
}

function subscribeFeed(cb: () => void): () => void {
  feedSubscribers.add(cb);
  openFeed();
  return () => {
    feedSubscribers.delete(cb);
    closeFeedIfIdle();
  };
}

/**
 * A price is handed out only while the socket is UP.
 *
 * Nothing clears `feed.live` on its own when the stream dies — a laptop
 * sleep/wake, a network change, an ER blip — so every consumer that read `live`
 * without ALSO reading `connected` rendered a frozen number as the live price:
 * market-bar's 22px headline, price-chart's header price and forming candle,
 * and status-panel's "Mark freshness" row, which scored a green "0.05% off
 * oracle" directly beneath its own "Oracle stream: disconnected". Only
 * useMarkPrice remembered the guard.
 *
 * Worse than the frozen number itself: every divergence check on the page is
 * mark-vs-spot, so it went blind at exactly the moment it mattered. A mark
 * drifting away from a dead spot reads as agreement (false negative), and if
 * the TWAP crank kept running while the stream was down, the amber banner
 * eventually fired blaming "the TWAP crank has stopped" for an oracle outage.
 *
 * Gating at the store rather than at the four call sites is the point: a
 * consumer cannot get an unguarded stale price by forgetting the guard. Both
 * branches return an existing reference (the object, or null), so
 * useSyncExternalStore's Object.is bail-out still holds, and `publish()`
 * already fires from onerror/onclose so consumers re-render on the transition.
 *
 * NOT covered here: a socket that stays OPEN and stops delivering. `connected`
 * is true for that, and a getSnapshot read has nothing to notify it as time
 * passes, so an age gate needs a timer — see MAX_SPOT_AGE_SECS in useMarkPrice.
 */
const getLive = () => (feed.connected ? feed.live : null);
const getConnected = () => feed.connected;
const serverLive = () => null;
const serverConnected = () => false;

/**
 * useSyncExternalStore rather than a forced re-render, for two reasons:
 *
 *  1. It bails out when the snapshot is unchanged (Object.is), so a consumer of
 *     `connected` alone stops re-rendering at the 20 msg/s feed rate. The
 *     previous version called every subscriber's useReducer increment on every
 *     notification, which never bails — so a footer boolean, the whole positions
 *     table and the chart all re-rendered together, fifty times a second.
 *  2. It reads the store during render, closing the window where a component
 *     that mounted while a tick was in flight showed the pre-tick value until
 *     the next one.
 */
export function useLivePrice(): { live: LivePrice | null; connected: boolean } {
  const live = useSyncExternalStore(subscribeFeed, getLive, serverLive);
  const connected = useSyncExternalStore(subscribeFeed, getConnected, serverConnected);
  return useMemo(() => ({ live, connected }), [live, connected]);
}

/**
 * For consumers that need only the connection state — the footer indicator, a
 * status row. Subscribing through the price snapshot would re-render them on
 * every tick for a boolean that changes on connect and disconnect only.
 */
export function useOracleConnected(): boolean {
  return useSyncExternalStore(subscribeFeed, getConnected, serverConnected);
}
