// Same-origin proxy for Pyth Benchmarks TradingView history (real historical
// OHLC candles, sourced from Pythnet). The browser calls this; the server
// forwards to benchmarks.pyth.network. Keeps the data source first-party and
// avoids any CORS/edge surprises.
//
//   GET /api/pyth/history?symbol=Crypto.SOL/USD&resolution=60&from=...&to=...
//
// Returns the Benchmarks UDF payload: { s, t[], o[], h[], l[], c[], v[] }.

import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE =
  process.env.PYTH_BENCHMARKS_UPSTREAM ||
  "https://benchmarks.pyth.network/v1/shims/tradingview";

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol") || "Crypto.SOL/USD";
  const resolution = searchParams.get("resolution") || "60";
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (!from || !to) {
    return json({ s: "error", errmsg: "missing from/to" }, 400);
  }

  const url =
    `${BASE}/history?symbol=${encodeURIComponent(symbol)}` +
    `&resolution=${encodeURIComponent(resolution)}&from=${from}&to=${to}`;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      // An HTTP 429/5xx is a SUCCESSFUL fetch, so the catch below never saw it:
      // the loop relayed it on the first try with zero retries. Benchmarks is
      // Cloudflare-fronted and free-tier, and every viewer polls it every 60s,
      // so this is the common failure, not the rare one. Retry it like the
      // transport errors it resembles.
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        // The upstream error body is a Cloudflare HTML page, and relaying it
        // stamped "Content-Type: application/json" made use-pyth-candles'
        // res.json() throw a SyntaxError instead of reading the { s:"error" }
        // shape it knows how to handle. Worse, it carried Cache-Control:
        // public, max-age=15, so the browser served the same failure back to
        // the next poll rather than retrying. Never echo the upstream text:
        // PYTH_BENCHMARKS_UPSTREAM is operator-configurable and may carry an
        // API key — the same reason the log line below is server-side only.
        console.error(`[pyth-proxy] upstream ${res.status}`);
        return json({ s: "error", errmsg: "Price history upstream is unavailable." }, 502);
      }
      // Only an ok response is relayed, so the cache header only ever applies
      // to real candles.
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=15",
        },
      });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  // Server-side only. A fetch failure can embed the upstream URL, and
  // PYTH_BENCHMARKS_UPSTREAM is operator-configurable and may carry an API key
  // — the same reason rpc/[layer] and faucet both refuse to echo lastErr. This
  // route was the one that never got the patch.
  console.error("[pyth-proxy] upstream failed:", lastErr);
  return json({ s: "error", errmsg: "Price history upstream is unavailable." }, 502);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
