// System status: base/ER RPC health + settlement indexer freshness. Server-side
// so upstream URLs (which may carry an API key) never reach the browser; results
// cached briefly to avoid multiplying RPC load by viewer count.
//
//   GET /api/status
//   -> { base: { ok, slot }, er: { ok, slot }, indexer: { lastFillAt | null },
//        keepers: { lastFundingTs, ageSecs, stalled } }
//
// S7-01/S8-05: the base/er blocks measure whether an RPC answers, which is not
// whether a keeper is running -- both read healthy right through a 17-day keeper
// outage. `indexer.lastFillAt` was the only freshness field and it reads a local
// SQLite file, so on any deployed frontend it is structurally null. The
// `keepers` block below is the actual liveness signal: `Market.last_funding_ts`
// is advanced only by compute_funding, which only a keeper sends, so its age is
// a direct measure of whether the fleet is alive. It is on-chain, needs no new
// infrastructure, and is the same read that surfaced the live outage.

import { existsSync } from "fs";
import { join, dirname, resolve } from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAMS = {
  base: process.env.BASE_RPC_UPSTREAM || "https://api.devnet.solana.com",
  er: process.env.ER_RPC_UPSTREAM || "https://devnet.magicblock.app",
};

const CACHE_MS = 5_000;

interface LayerStatus {
  ok: boolean;
  slot: number | null;
}

interface KeeperStatus {
  /** Unix seconds of the last compute_funding, or null if unreadable. */
  lastFundingTs: number | null;
  /** Seconds since that call. */
  ageSecs: number | null;
  /** True once age exceeds STALE_FACTOR funding intervals. Null = unknown. */
  stalled: boolean | null;
}

interface StatusPayload {
  base: LayerStatus;
  er: LayerStatus;
  indexer: { lastFillAt: number | null };
  keepers: KeeperStatus;
  at: number;
}

// A funding keeper that misses this many intervals is not merely late. Three
// leaves room for one retry plus the poll cadence without crying wolf; the
// interval itself comes from the market, so no threshold is hardcoded here.
const STALE_FACTOR = 3;

let cached: StatusPayload | null = null;

async function getSlot(upstream: string): Promise<LayerStatus> {
  try {
    const res = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
      signal: AbortSignal.timeout(5_000),
    });
    const json = await res.json();
    if (typeof json?.result === "number") return { ok: true, slot: json.result };
    return { ok: false, slot: null };
  } catch {
    return { ok: false, slot: null };
  }
}

function dbPath(): string | null {
  if (process.env.INDEXER_DB) return resolve(process.env.INDEXER_DB);
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "keepers", "data", "fills.db");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function lastFillAt(): Promise<number | null> {
  const p = dbPath();
  if (!p || !existsSync(p)) return null;
  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(p, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare("SELECT MAX(settled_at) AS ts FROM fills")
        .get() as { ts: number | null };
      return row?.ts ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function keeperStatus(upstream: string): Promise<KeeperStatus> {
  const unknown: KeeperStatus = { lastFundingTs: null, ageSecs: null, stalled: null };
  try {
    // Imported inside the try, not at module scope: `@/lib/manifest` THROWS on
    // evaluation when deploy.json is absent, and a health endpoint that 500s
    // when the thing it reports on is misconfigured is the failure it exists to
    // report. Same reason the keepers now resolve their feed lazily (S7-02).
    const { MARKET } = await import("@/lib/manifest");
    const { decodeMarket } = await import("@/lib/slipstream");
    const res = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [MARKET.toBase58(), { encoding: "base64" }],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const json = await res.json();
    const b64 = json?.result?.value?.data?.[0];
    if (typeof b64 !== "string") return unknown;
    const market = decodeMarket(Buffer.from(b64, "base64"));
    const lastFundingTs = Number(market.lastFundingTs);
    const interval = Number(market.fundingIntervalSecs);
    const ageSecs = Math.floor(Date.now() / 1000) - lastFundingTs;
    // A zero/absent interval would make every reading "stalled"; report unknown
    // rather than a threshold this market never defined.
    const stalled = interval > 0 ? ageSecs > interval * STALE_FACTOR : null;
    return { lastFundingTs, ageSecs, stalled };
  } catch {
    return unknown;
  }
}

export async function GET(): Promise<Response> {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return Response.json(cached);
  }
  const [base, er, fillTs, keepers] = await Promise.all([
    getSlot(UPSTREAMS.base),
    getSlot(UPSTREAMS.er),
    lastFillAt(),
    keeperStatus(UPSTREAMS.base),
  ]);
  cached = { base, er, indexer: { lastFillAt: fillTs }, keepers, at: Date.now() };
  return Response.json(cached);
}
