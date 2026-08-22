import { Connection } from "@solana/web3.js";
import { RPC_URL, ER_RPC } from "@/lib/manifest";

/**
 * The ONE base-layer and ER Connection for the whole app.
 *
 * Sixteen call sites used to do `new Connection(url, "confirmed")` inline, and
 * most of them sat INSIDE a poll callback: use-orderbook built two per tick
 * every 2s, use-er-position three, use-open-orders two, use-session five more
 * per refresh. None was ever closed.
 *
 * CORRECTION, recorded because the first version of this comment asserted it:
 * these instances did NOT leak WebSockets. In the pinned @solana/web3.js
 * 1.98.4 the Connection constructor builds its RpcWebSocketClient with
 * `autoconnect: false` (lib/index.cjs.js:6104-6106) and only calls connect()
 * from _updateSubscriptions, reached solely via onAccountChange / onLogs /
 * onSignature / onProgramAccountChange — and this app makes zero subscriptions
 * (lib/confirm.ts exists precisely to avoid confirmTransaction's
 * signatureSubscribe). An unsubscribed Connection holds no socket and no timer.
 *
 * What per-instance construction did cost: independent HTTP retry state, so a
 * 429 was retried by each instance separately rather than once, multiplying
 * load during exactly the rate limiting it should have backed off from.
 *
 * The real cause of ERR_INSUFFICIENT_RESOURCES was elsewhere — an unstable
 * effect dependency re-firing fetches ~20x/second (see use-positions.ts and
 * use-er-position.ts). Singletons are still the right shape, and this file is
 * kept for the retry-state reason above, but it is not what stopped the errors.
 *
 * `disableRetryOnRateLimit` is on deliberately. The callers here are pollers
 * that will ask again in a second or two anyway, so a silent internal retry
 * only multiplies load during exactly the outage it is meant to survive —
 * lib/poll.ts backs off instead, where the decision is visible.
 */
export const baseConnection = new Connection(RPC_URL, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});

export const erConnection = new Connection(ER_RPC, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});
