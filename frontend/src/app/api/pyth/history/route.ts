// Same-origin proxy for historical OHLC candles, in the TradingView UDF shape
// the chart already speaks: { s, t[], o[], h[], l[], c[], v[], src }.
//
//   GET /api/pyth/history?symbol=Crypto.SOL/USD&resolution=60&from=...&to=...
//
// WHY THIS IS NO LONGER PYTH BY DEFAULT
// Pyth retired the free Benchmarks TradingView shim in the Pyth Core upgrade on
// 2026-08-26 16:00 UTC. Every /v1/shims/tradingview/* path now returns 404 (the
// host is still up: /v1/price_feeds/ answers 200), and the rest of the v1 API
// plus Hermes now answer 401 unauthorized — Pyth moved to an API-key model. So
// this route did not break; its upstream was switched off underneath it, which
// is why the chart read "Couldn't load price history" while the live price kept
// streaming (that comes from MagicBlock, not Pyth).
//
// The documented replacement is the Pyth Pro History API, which implements the
// SAME UDF spec — so it is a drop-in for the fetch below, and this route reaches
// it whenever PYTH_HISTORY_UPSTREAM is set. The exact Pro path is not hardcoded
// here on purpose: it is not in the public docs, and guessing a URL that then
// 404s is exactly the failure being fixed. Point the env var at the base URL
// from your Pro dashboard and set PYTH_HISTORY_API_KEY.
//
// With no key configured the fallback is Coinbase Exchange's public candles —
// no key, no CORS concern (this is server-side), and measured at 6/6 successful
// calls where Kraken managed 5/6. The response carries `src` so the chart can
// name the source it is actually drawing instead of claiming Pyth.

import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Set to a UDF-compatible base (e.g. the Pyth Pro History API) to use it. */
const UDF_UPSTREAM = process.env.PYTH_HISTORY_UPSTREAM || process.env.PYTH_BENCHMARKS_UPSTREAM || "";
const UDF_API_KEY = process.env.PYTH_HISTORY_API_KEY || "";

const COINBASE = "https://api.exchange.coinbase.com";

/** UDF resolution code -> bucket width in seconds. */
const SECONDS: Record<string, number> = {
  "1": 60, "5": 300, "15": 900, "60": 3600, "240": 14400,
  D: 86400, "1D": 86400,
};

/**
 * Coinbase granularities are a fixed set: 60, 300, 900, 3600, 21600, 86400.
 * 14400 (4H) is NOT one of them, so 4H is fetched at 1H and folded into 4H
 * buckets below. Everything else maps 1:1.
 */
const CB_GRANULARITY: Record<number, number> = {
  60: 60, 300: 300, 900: 900, 3600: 3600, 14400: 3600, 86400: 86400,
};

/** Coinbase returns at most ~300-350 buckets per call, whatever window you ask for. */
const CB_MAX_BUCKETS = 300;

interface Udf {
  s: "ok" | "no_data" | "error";
  t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[];
  src?: string;
  errmsg?: string;
}

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol") || "Crypto.SOL/USD";
  const resolution = searchParams.get("resolution") || "60";
  const from = Number(searchParams.get("from"));
  const to = Number(searchParams.get("to"));

  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= from) {
    return json({ s: "error", errmsg: "missing or invalid from/to" }, 400);
  }
  const bucket = SECONDS[resolution];
  if (!bucket) {
    return json({ s: "error", errmsg: `unsupported resolution ${resolution}` }, 400);
  }

  if (UDF_UPSTREAM) {
    const viaPyth = await fetchUdf(symbol, resolution, from, to);
    if (viaPyth) return ok(viaPyth);
    // Fall through rather than fail: a misconfigured or rate-limited Pro
    // endpoint should degrade to a chart, not to an empty panel.
  }

  const viaCoinbase = await fetchCoinbase(bucket, from, to);
  if (viaCoinbase) return ok(viaCoinbase);

  return json({ s: "error", errmsg: "Price history is unavailable right now." }, 502);
}

/** A UDF-spec upstream (Pyth Pro, or the retired Benchmarks shim). */
async function fetchUdf(
  symbol: string, resolution: string, from: number, to: number
): Promise<Udf | null> {
  const url =
    `${UDF_UPSTREAM.replace(/\/$/, "")}/history?symbol=${encodeURIComponent(symbol)}` +
    `&resolution=${encodeURIComponent(resolution)}&from=${from}&to=${to}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (UDF_API_KEY) headers.Authorization = `Bearer ${UDF_API_KEY}`;

  const text = await getWithRetry(url, headers, "udf");
  if (text === null) return null;
  try {
    const d = JSON.parse(text) as Udf;
    if (d.s !== "ok" || !Array.isArray(d.t) || d.t.length === 0) return null;
    return { ...d, src: "Pyth" };
  } catch {
    // Never echo the body: the upstream may be a Cloudflare HTML error page,
    // and UDF_UPSTREAM can carry a key.
    console.error("[history] udf upstream returned non-JSON");
    return null;
  }
}

/** Coinbase Exchange public candles -> UDF. Rows are [time, low, high, open, close, volume]. */
async function fetchCoinbase(bucket: number, from: number, to: number): Promise<Udf | null> {
  const granularity = CB_GRANULARITY[bucket];
  if (!granularity) return null;

  // Ask for a window this granularity can actually return in one call. Asking
  // wider does not error — Coinbase just truncates, and it truncates the OLD
  // end, so an over-wide request silently costs you the left of the chart.
  const span = Math.min(to - from, granularity * CB_MAX_BUCKETS);
  const start = new Date((to - span) * 1000).toISOString();
  const end = new Date(to * 1000).toISOString();

  const url =
    `${COINBASE}/products/SOL-USD/candles?granularity=${granularity}` +
    `&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;

  const text = await getWithRetry(url, { Accept: "application/json", "User-Agent": "slipstream" }, "coinbase");
  if (text === null) return null;

  let rows: number[][];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    rows = parsed as number[][];
  } catch {
    console.error("[history] coinbase returned non-JSON");
    return null;
  }
  if (rows.length === 0) return null;

  // Coinbase returns newest first; UDF wants oldest first and strictly ascending.
  rows.sort((a, b) => a[0] - b[0]);

  const out: Udf = { s: "ok", t: [], o: [], h: [], l: [], c: [], v: [], src: "Coinbase" };

  if (bucket === granularity) {
    for (const r of rows) {
      out.t.push(r[0]); out.l.push(r[1]); out.h.push(r[2]);
      out.o.push(r[3]); out.c.push(r[4]); out.v.push(r[5]);
    }
    return out;
  }

  // 4H: fold 1H rows into epoch-aligned buckets. Open is the FIRST row's open
  // and close the LAST row's close, so the candle body is the real move across
  // the bucket rather than the first or last hour of it.
  let cur = -1;
  for (const r of rows) {
    const b = Math.floor(r[0] / bucket) * bucket;
    if (b !== cur) {
      cur = b;
      out.t.push(b); out.l.push(r[1]); out.h.push(r[2]);
      out.o.push(r[3]); out.c.push(r[4]); out.v.push(r[5]);
      continue;
    }
    const i = out.t.length - 1;
    out.l[i] = Math.min(out.l[i], r[1]);
    out.h[i] = Math.max(out.h[i], r[2]);
    out.c[i] = r[4];
    out.v[i] += r[5];
  }
  return out;
}

/**
 * GET with retry. A 429/5xx is a SUCCESSFUL fetch, so a plain try/catch never
 * sees it — that was the original bug here, and both upstreams rate-limit.
 * Returns the body text, or null when every attempt failed.
 */
async function getWithRetry(
  url: string, headers: Record<string, string>, label: string
): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        // Status only, never the body: it may be an HTML error page, and the
        // URL can carry an API key.
        console.error(`[history] ${label} upstream ${res.status}`);
        return null;
      }
      return await res.text();
    } catch (e) {
      // Server-side only — a fetch failure can embed the upstream URL.
      console.error(`[history] ${label} attempt ${attempt + 1} failed:`, e instanceof Error ? e.message : e);
      await sleep(250 * (attempt + 1));
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ok(body: Udf): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Only ever applied to real candles — an error must not be cached, or the
      // browser serves the same failure back to the next poll.
      "Cache-Control": "public, max-age=15",
    },
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
