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

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ layer: string }> }
): Promise<Response> {
  const { layer } = await ctx.params;
  const upstream = UPSTREAMS[layer];
  if (!upstream) {
    return new Response(
      JSON.stringify({ error: `unknown rpc layer "${layer}"` }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }
  const body = await req.text();
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
