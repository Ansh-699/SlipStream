// Same-origin JSON-RPC proxy for the Solana base layer and the MagicBlock ER.
//
// WHY: the browser calling the MagicBlock ER (https://devnet.magicblock.app)
// directly fails with "TypeError: Failed to fetch" / "failed to get recent
// blockhash" — a cross-origin (CORS) / browser-network issue. Node processes
// (bots, keepers) reach the ER fine, which is why they trade but the browser
// can't even fetch a blockhash. Routing RPC through this same-origin API route
// removes CORS entirely (the request is same-origin to the Next app; the server
// forwards it to the upstream RPC) and lets us add a small retry for the ER's
// occasional flakiness.
//
// Routes:
//   POST /api/rpc/base  -> https://api.devnet.solana.com  (base layer)
//   POST /api/rpc/er    -> https://devnet.magicblock.app   (Ephemeral Rollup)
//
// Override upstreams via BASE_RPC_UPSTREAM / ER_RPC_UPSTREAM (server env).

import { NextRequest } from "next/server";

export const runtime = "nodejs";
// Always proxy live; never cache RPC responses.
export const dynamic = "force-dynamic";

const UPSTREAMS: Record<string, string> = {
  base: process.env.BASE_RPC_UPSTREAM || "https://api.devnet.solana.com",
  er: process.env.ER_RPC_UPSTREAM || "https://devnet.magicblock.app",
};

async function forward(upstream: string, body: string): Promise<Response> {
  // A couple of quick retries smooth over the ER's occasional transient errors
  // (the same flakiness that surfaced as "Failed to fetch" in the browser).
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(upstream, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        // Server-side fetch: no CORS, generous timeout via AbortSignal.
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  // Log the real error server-side only: fetch failures can embed the upstream
  // URL, and the base upstream carries a private API key that must never reach
  // the browser.
  console.error("[rpc-proxy] upstream failed:", lastErr);
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "RPC proxy failed: upstream unreachable" },
    }),
    { status: 502, headers: { "Content-Type": "application/json" } }
  );
}

// This proxy is unauthenticated and forwards to an upstream that carries a private
// API key, so it is a free relay onto the deployer's paid RPC quota unless it is
// bounded. Two cheap bounds: cap the body, and only allow the JSON-RPC methods the
// dApp actually calls (an unfiltered getProgramAccounts against a 612 KB orderbook
// program, looped, is exactly how this project burned its quota before).
const MAX_BODY_BYTES = 100_000;

const ALLOWED_METHODS = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  // Required by use-positions.ts (memcmp-filtered scan for the user's Positions).
  // This is the expensive one the comment above warns about, so it stays behind
  // the body/batch caps; bounding it properly needs a rate limiter or an
  // indexer-backed endpoint, not removal — dropping it breaks the positions table.
  "getProgramAccounts",
  "getBalance",
  "getLatestBlockhash",
  "getSignatureStatuses",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTransaction",
  "getMinimumBalanceForRentExemption",
  "getFeeForMessage",
  "sendTransaction",
  "simulateTransaction",
  "getHealth",
  "getVersion",
  "getEpochInfo",
  "getBlockHeight",
  "getRecentPrioritizationFees",
]);

function methodsAllowed(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0 || calls.length > 20) return false;
  return calls.every(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as { method?: unknown }).method === "string" &&
      ALLOWED_METHODS.has((c as { method: string }).method)
  );
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ layer: string }> }
): Promise<Response> {
  const { layer } = await ctx.params;
  // Own-property lookup: a plain `UPSTREAMS[layer]` also resolves inherited keys
  // ("toString", "constructor", "__proto__"), which are truthy and would sail past
  // an `if (!upstream)` guard.
  const upstream = Object.hasOwn(UPSTREAMS, layer) ? UPSTREAMS[layer] : undefined;
  if (!upstream) {
    return new Response(
      JSON.stringify({ error: `unknown rpc layer "${layer}"` }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }
  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "request body too large" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!methodsAllowed(body)) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32601, message: "method not permitted by proxy" },
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }
  return forward(upstream, body);
}

// Some web3.js paths probe with GET (health). Return a simple OK.
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ layer: string }> }
): Promise<Response> {
  const { layer } = await ctx.params;
  return new Response(JSON.stringify({ ok: true, layer }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
