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
 * That leaks, for two compounding reasons:
 *
 *  1. Every web3.js Connection constructs an RpcWebSocketClient and reconnects
 *     it forever on failure. The browser reaches both layers through the
 *     same-origin HTTP proxy (/api/rpc/*), from which web3.js derives a ws://
 *     URL the proxy does not serve — see the note in lib/confirm.ts, which
 *     exists for exactly this reason. So every Connection ever created is still
 *     retrying a socket that can never open.
 *  2. Connection retries HTTP 429/5xx internally, so each dead instance also
 *     keeps its own independent retry state. Under upstream rate limiting the
 *     request count multiplies per instance.
 *
 * After a few minutes of polling that is hundreds of live zombie clients, and
 * the browser stops opening sockets:
 *
 *     POST /api/rpc/base  net::ERR_INSUFFICIENT_RESOURCES
 *
 * Bounding the poll rate (lib/poll.ts) does not help, because the leak is per
 * instance, not per tick. Two module-scope singletons do: the count is fixed at
 * two for the lifetime of the tab regardless of how long it runs.
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
