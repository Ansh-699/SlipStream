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

/**
 * Where each layer goes when its configured upstream will not serve.
 *
 * WHY THIS EXISTS: BASE_RPC_UPSTREAM was a single point of failure. The public
 * endpoint below was only ever a DEFAULT for when the env var is unset, so once
 * it was set to a keyed provider and that key ran out, the whole base layer went
 * down with it -- balances, settlement cursor and keeper status all read
 * "unreachable" while the public endpoint sat there answering 200 in 200ms.
 * That is exactly what happened: Helius returned
 *   HTTP 429 {"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}
 * on every call. The ER and the oracle stayed green because neither touches it.
 *
 * The fallback is deliberately the FREE public endpoint, not a second key: it is
 * slower and throttles under load, but it is always there, and a degraded chain
 * read beats a dead one.
 */
const FALLBACKS: Record<string, string> = {
  base: "https://api.devnet.solana.com",
  er: "https://devnet.magicblock.app",
};

type Attempt =
  | { ok: true; res: Response }
  | { ok: false; reason: "quota" | "rate" | "unavailable" | "unreachable" };

/**
 * A JSON-RPC quota error, matched on the CODE rather than the message text.
 * Length-bounded because an error envelope is a few hundred bytes: without it
 * this would scan an 836 KB order-book reply on every single poll, and a base64
 * account blob can contain any substring you care to name.
 */
function isQuotaBody(text: string): boolean {
  return text.length < 4096 && /"code"\s*:\s*-32429/.test(text);
}

/** One upstream, with retries. Never returns the upstream URL to the caller. */
async function attemptUpstream(
  upstream: string,
  body: string,
  accept: string,
  label: string
): Promise<Attempt> {
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

      // 429 is NOT retried here any more. When we hold a second upstream,
      // sleeping on Retry-After is strictly worse than just asking the other
      // one -- and for a quota error (-32429) the wait is guaranteed wasted,
      // because it does not clear until the provider's billing window rolls
      // over. The old loop burned ~900ms per call to arrive at the same
      // failure, on every poll, for every open tab.
      if (res.status === 429) {
        const quota = isQuotaBody(text) || /max usage reached/i.test(text);
        console.error(`[rpc-proxy] ${label} 429 (${quota ? "quota exhausted" : "rate limited"})`);
        return { ok: false, reason: quota ? "quota" : "rate" };
      }
      if (res.status >= 500) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        console.error(`[rpc-proxy] ${label} upstream ${res.status}`);
        return { ok: false, reason: "unavailable" };
      }
      // A 200 can still carry a quota error in the JSON-RPC envelope.
      if (isQuotaBody(text)) {
        console.error(`[rpc-proxy] ${label} quota exhausted (200 body)`);
        return { ok: false, reason: "quota" };
      }

      // Async gzip, never gzipSync: at ~1.5 order-book responses per second per
      // viewer, synchronously compressing 836 KB would block the event loop for
      // ~15 ms each time and stall every other request on the server. undici has
      // already decompressed the upstream reply, so `text` is plaintext here.
      if (text.length >= GZIP_MIN_BYTES && /\bgzip\b/.test(accept)) {
        return {
          ok: true,
          res: new Response(await gz(text), {
            status: res.status,
            headers: {
              "Content-Type": "application/json",
              "Content-Encoding": "gzip",
              Vary: "Accept-Encoding",
            },
          }),
        };
      }
      return {
        ok: true,
        res: new Response(text, {
          status: res.status,
          headers: { "Content-Type": "application/json" },
        }),
      };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  // Log the real error server-side ONLY: a fetch failure can embed the upstream
  // URL, and the base upstream carries a private API key that must never reach
  // the browser.
  console.error(`[rpc-proxy] ${label} unreachable:`, lastErr);
  return { ok: false, reason: "unreachable" };
}

/**
 * Try the configured upstream, then the public one.
 *
 * Re-sending on the fallback is safe for sendTransaction too: a Solana
 * transaction is idempotent by signature, so a duplicate is deduplicated by the
 * cluster rather than executed twice -- and the failures that reach the fallback
 * (429 / 5xx / no connection) are ones where the primary rejected the request
 * before it ever reached the network.
 */
async function forward(layer: string, body: string, accept: string): Promise<Response> {
  const primary = UPSTREAMS[layer];
  const fallback = FALLBACKS[layer];

  const first = await attemptUpstream(primary, body, accept, `${layer}/primary`);
  if (first.ok) return first.res;

  // Skip when they are the same endpoint, or the "fallback" is just a second
  // call to the thing that already failed.
  if (fallback && fallback !== primary) {
    console.error(`[rpc-proxy] ${layer}: primary ${first.reason} -> failing over to public endpoint`);
    const second = await attemptUpstream(fallback, body, accept, `${layer}/fallback`);
    if (second.ok) return second.res;
  }

  const message =
    first.reason === "quota"
      ? "RPC quota is exhausted and the public fallback did not answer."
      : first.reason === "rate"
        ? "Upstream RPC is rate limiting this request."
        : "Upstream RPC is unavailable.";
  // Status 200 with a JSON-RPC error body, not 502: web3.js surfaces a non-2xx
  // as an opaque transport failure, which is what produced "Failed to fetch" in
  // the browser instead of this message.
  return new Response(
    errorEnvelope(body, first.reason === "unreachable" ? -32603 : -32005, message),
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
  return forward(layer, body, req.headers.get("accept-encoding") ?? "");
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
