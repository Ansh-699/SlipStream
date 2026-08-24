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
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gz = promisify(gzip);

export const runtime = "nodejs";
// Always proxy live; never cache RPC responses.
export const dynamic = "force-dynamic";

const UPSTREAMS: Record<string, string> = {
  base: process.env.BASE_RPC_UPSTREAM || "https://api.devnet.solana.com",
  er: process.env.ER_RPC_UPSTREAM || "https://devnet.magicblock.app",
};

/** Echo the caller's JSON-RPC id so the client can match the response.
 *  `id: null` never matches a pending request, and for a BATCH the client
 *  expects an array and gets an object — so the carefully worded error below
 *  never actually reached the user as that error. */
function errorEnvelope(body: string, code: number, message: string): string {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      return JSON.stringify(
        parsed.map((c: { id?: unknown }) => ({
          jsonrpc: "2.0",
          id: c?.id ?? null,
          error: { code, message },
        }))
      );
    }
    return JSON.stringify({ jsonrpc: "2.0", id: parsed?.id ?? null, error: { code, message } });
  } catch {
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } });
  }
}

// Next does NOT compress route-handler responses (its `compress: true` covers
// pages, not these), so every RPC reply left this proxy as plaintext. Measured
// on the prod build: one getAccountInfo on the order book is 835,887 B raw and
// 40,726 B gzipped — a 95% saving on ~99% of the tab's traffic, since the book
// is polled every 2s. Only bodies above this are worth the CPU; a getSlot reply
// is ~100 B and would come out larger.
const GZIP_MIN_BYTES = 1024;

async function forward(upstream: string, body: string, accept: string): Promise<Response> {
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
      // An HTTP 429/5xx is a SUCCESSFUL fetch, so the catch below never saw it
      // and the loop returned immediately without retrying. Worse, the response
      // was stamped Content-Type: application/json regardless — and a public
      // devnet 429 is usually text or HTML, so the client did
      // JSON.parse("Too Many Requests") and reported a generic failure rather
      // than "rate limited". Retry it like the transport failures it resembles,
      // and if it persists, return a WELL-FORMED JSON-RPC error.
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 4_000)
          : 300 * (attempt + 1);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        console.error(`[rpc-proxy] upstream ${res.status}`);
        return new Response(
          errorEnvelope(
            body,
            -32005,
            res.status === 429
              ? "Upstream RPC is rate limiting this request."
              : "Upstream RPC is unavailable."
          ),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // Async gzip, never gzipSync: at ~1.5 order-book responses per second per
      // viewer, synchronously compressing 836 KB would block the event loop for
      // ~15 ms each time and stall every other request on the server. undici has
      // already decompressed the upstream reply, so `text` is plaintext here.
      // Only the success path is compressed — the error envelope, 403, 413 and
      // 404 below are a few hundred bytes each.
      if (text.length >= GZIP_MIN_BYTES && /\bgzip\b/.test(accept)) {
        return new Response(await gz(text), {
          status: res.status,
          headers: {
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
            Vary: "Accept-Encoding",
          },
        });
      }
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
  // Status 200 with a JSON-RPC error body, not 502: web3.js surfaces a non-2xx
  // as an opaque transport failure, which is what produced "Failed to fetch" in
  // the browser instead of this message.
  return new Response(
    errorEnvelope(body, -32603, "RPC proxy failed: upstream unreachable"),
    { status: 200, headers: { "Content-Type": "application/json" } }
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
  // getProgramAccounts is deliberately NOT here. It used to be, for
  // use-positions.ts, but that hook now derives the Position PDA and does a
  // single getAccountInfo, so nothing in frontend/src calls it any more (the
  // keepers reach their RPC directly — clientRpc only returns this proxy URL in
  // the browser). Left in the allowlist it was an unfiltered, unauthenticated,
  // retry-amplified full-program scan — 20 per request, >600 KB of upstream
  // egress each — pointed at the deployer's paid RPC quota: exactly what the
  // comment above says burned that quota once already. If a feature ever needs
  // it back, re-add it gated on a required non-empty `filters` array plus a
  // `dataSlice`, and cap batches containing it at 1 — not as a bare entry.
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

/**
 * Read the request body, refusing anything over `max` bytes. Returns null when
 * the body is too large.
 *
 * WHY not `await req.text()` plus a length check: `text()` buffers the WHOLE
 * body before any check can run, so the cap was decoration. An unauthenticated
 * 500 MB POST is ~1 GB of heap here (Node holds the decoded string as UTF-16),
 * and a few concurrent ones OOM the Next process — which takes the dashboard,
 * both RPC proxies, the faucet and /api/status down together.
 *
 * Content-Length is used only to reject before reading a single byte; it is
 * never trusted as the actual size, because it is absent on a chunked request
 * and caller-supplied in any case. `return` out of the for-await cancels the
 * underlying stream, so an oversized body stops arriving instead of being
 * drained into memory.
 */
async function readCapped(req: NextRequest, max: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return null;
  if (!req.body) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

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
  const body = await readCapped(req, MAX_BODY_BYTES);
  if (body === null) {
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
  return forward(upstream, body, req.headers.get("accept-encoding") ?? "");
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
