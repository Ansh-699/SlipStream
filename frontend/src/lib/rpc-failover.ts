// Shared base-layer RPC failover for SERVER-SIDE routes.
//
// WHY THIS EXISTS: a keyed upstream is a single point of failure, and this
// project has now been taken down by one twice. On 2026-09-01T23:28Z the
// configured provider began answering every base-layer call with
//   HTTP 429 {"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}
// while the free public endpoint answered 200 in ~200ms throughout.
//
// /api/rpc/[layer] had already grown its own failover, so the trading UI stayed
// up — but /api/status and /api/faucet called the upstream DIRECTLY and went
// down with it. That asymmetry is the actual bug: the routes that told the
// operator what was wrong, and the route a new user needs first, were the two
// without a fallback. This module is the one copy they now share.
//
// The proxy in /api/rpc/[layer] keeps its own richer implementation (gzip,
// batch error envelopes, method allowlist); it is not worth contorting either
// to merge them.

/** Where each layer goes when its configured upstream will not serve. */
export const PUBLIC_FALLBACKS: Record<string, string> = {
  base: "https://api.devnet.solana.com",
  er: "https://devnet.magicblock.app",
};

/**
 * A JSON-RPC quota error, matched on the CODE rather than the message text.
 * Length-bounded because an error envelope is a few hundred bytes: without it
 * this would scan an 836 KB order-book reply on every call, and a base64
 * account blob can contain any substring you care to name.
 */
export function isQuotaBody(text: string): boolean {
  return text.length < 4096 && /"code"\s*:\s*-32429/.test(text);
}

/**
 * POST a JSON-RPC body to `primary`, falling back to the public endpoint.
 * Returns the parsed reply plus whether the FALLBACK answered — callers surface
 * that as `degraded`, which is the early warning the last outage lacked: a
 * spent key reads as "up but degraded" while everything still works, instead of
 * surfacing days later as "the site is down".
 */
export async function rpcPost(
  primary: string,
  fallback: string,
  body: unknown,
  timeoutMs = 5_000
): Promise<{ json: unknown; degraded: boolean } | null> {
  const targets = fallback && fallback !== primary ? [primary, fallback] : [primary];
  for (let i = 0; i < targets.length; i++) {
    try {
      const res = await fetch(targets[i], {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      // A 200 can still carry a quota error in the JSON-RPC envelope.
      if (!res.ok || isQuotaBody(text)) continue;
      return { json: JSON.parse(text), degraded: i > 0 };
    } catch {
      // Never log the URL or body: the upstream can carry an API key.
      continue;
    }
  }
  return null;
}

// A quota does not clear until the provider's billing window rolls over, so
// re-probing the primary on every call buys a guaranteed failure at double
// latency. The latch expires on its own so a refilled key resumes with no
// redeploy. Module-scope, therefore per server process — the same lifetime the
// route-level caches in these routes already assume.
const QUOTA_COOLDOWN_MS = 5 * 60_000;
let primaryBlockedUntil = 0;

/**
 * A `fetch` replacement for @solana/web3.js `ConnectionConfig.fetch`, so an
 * existing `new Connection(url)` inherits failover with no call-site changes.
 *
 * NOTE the companion trap: `confirmTransaction()` waits on a signatureSubscribe
 * WEBSOCKET whose endpoint web3.js derives from the HTTP one, and this covers
 * HTTP only. Any caller that confirms must also pin `wsEndpoint` to an endpoint
 * that is actually up, or a transaction that has already succeeded on chain
 * still times out. See keepers/src/shared/connection.ts, where the same trap
 * made landed TWAP cranks read as failures.
 */
export function makeFailoverFetch(primary: string, fallback: string) {
  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    if (Date.now() >= primaryBlockedUntil) {
      try {
        const res = await fetch(input, init);
        if (res.status !== 429 && res.status < 500) {
          const len = Number(res.headers.get("content-length") || "0");
          // An 836 KB account blob is never a quota envelope, and buffering it
          // here would copy it for nothing.
          if (res.ok && len > 4096) return res;
          const text = await res.text();
          if (!isQuotaBody(text)) {
            // The body is consumed; hand the caller an equivalent one.
            return new Response(text, { status: res.status, headers: res.headers });
          }
        }
        primaryBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
        console.error(`[rpc-failover] primary refused (${res.status}); using fallback`);
      } catch {
        primaryBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
        console.error("[rpc-failover] primary unreachable; using fallback");
      }
    }
    return fetch(fallback, init);
  };
}

/** The websocket for a public fallback, for pinning `wsEndpoint`. */
export function fallbackWsEndpoint(fallback: string): string {
  return fallback.replace(/^http/, "ws");
}
