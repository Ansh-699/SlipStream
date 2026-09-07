// System status: base/ER RPC health + settlement indexer freshness. Server-side
// so upstream URLs (which may carry an API key) never reach the browser; results
// cached briefly to avoid multiplying RPC load by viewer count.
//
//   GET /api/status
//   -> { base: { ok, slot }, er: { ok, slot }, indexer: { lastFillAt | null },
//        keepers: { lastFundingTs, ageSecs, stalled,
//                   fleet: [{ name, ageSecs, ok, lastError, stale }], fleetOk } }
//
// S7-01/S8-05: the base/er blocks measure whether an RPC answers, which is not
// whether a keeper is running -- both read healthy right through a 17-day keeper
// outage. `indexer.lastFillAt` was the only freshness field and it reads a local
// SQLite file, so on any deployed frontend it is structurally null. The
// `keepers` block below is the actual liveness signal: `Market.last_funding_ts`
// is advanced only by compute_funding, which only a keeper sends, so its age is
// a direct measure of whether the fleet is alive. It is on-chain, needs no new
// infrastructure, and is the same read that surfaced the live outage.
//
// ...but it measures ONE keeper. `last_funding_ts` is advanced by
// compute_funding alone, so a dead TWAP, liquidation, expiry or fill-log keeper
// is invisible to it: the endpoint reports healthy while settlement is stopped.
// `keepers.fleet` below reads the per-keeper heartbeat files the keepers write
// (see KEEPER_HEARTBEAT_DIR), which is the only signal that covers the loops
// that touch no market field.

import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { PUBLIC_FALLBACKS, rpcPost } from "@/lib/rpc-failover";
import { join, dirname, resolve } from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAMS = {
  base: process.env.BASE_RPC_UPSTREAM || "https://api.devnet.solana.com",
  er: process.env.ER_RPC_UPSTREAM || "https://devnet.magicblock.app",
};

/**
 * Same fallbacks as /api/rpc/[layer]. This route was calling UPSTREAMS
 * DIRECTLY, so when the keyed base provider hit its quota on 2026-09-01 this
 * endpoint reported `base.ok: false` for 2.7 days while the app itself kept
 * working through the proxy's failover. A health endpoint that reports an
 * outage the product is not having is worse than no health endpoint: it sends
 * whoever is on call after the wrong thing.
 */
const FALLBACKS = PUBLIC_FALLBACKS;

const CACHE_MS = 5_000;

interface LayerStatus {
  ok: boolean;
  slot: number | null;
  /**
   * True when the configured upstream refused and the public fallback answered.
   * This is the early warning the last outage lacked: a spent key shows up here
   * as `ok: true, degraded: true` while everything still works, instead of
   * surfacing days later as "the site is down".
   */
  degraded?: boolean;
}

/** One keeper's self-report, from `<KEEPER_HEARTBEAT_DIR>/<name>.json`. */
interface HeartbeatStatus {
  name: string;
  /** Seconds since that keeper last wrote its file. */
  ageSecs: number;
  /** What the keeper said about itself at that write. */
  ok: boolean;
  lastError: string | null;
  /** True once ageSecs exceeds HEARTBEAT_STALE_SECS — the loop stopped writing. */
  stale: boolean;
}

interface KeeperStatus {
  /** Unix seconds of the last compute_funding, or null if unreadable. */
  lastFundingTs: number | null;
  /** Seconds since that call. */
  ageSecs: number | null;
  /** True once age exceeds STALE_FACTOR funding intervals. Null = unknown. */
  stalled: boolean | null;
  /**
   * Every keeper that has written a heartbeat, by name. EMPTY is "we cannot
   * see them", not "there are none": the frontend may run on a different host
   * from the keepers, in which case the directory simply is not here.
   */
  fleet: HeartbeatStatus[];
  /** Every heartbeat fresh and self-reporting ok. Null = nothing to read. */
  fleetOk: boolean | null;
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

// Where the keepers drop `<name>.json`. Defaults to the OS temp dir so a
// single-box deployment needs no configuration; set it to a real directory if
// /tmp is wiped under the process.
const HEARTBEAT_DIR = process.env.KEEPER_HEARTBEAT_DIR || tmpdir();
// ponytail: ONE threshold for every keeper. The loops beat on their own
// cadences (fill-log 4s, liquidation 5s, twap 8s, funding and expiry 60s), so
// this is 3x the SLOWEST of them - the same "three misses, not one" slack
// STALE_FACTOR above already uses - rather than a per-keeper SLO. Env knob
// because the right number is a property of the running fleet, not of this
// file. Upgrade path: a `staleAfter` field in the heartbeat itself, so each
// keeper declares its own deadline and this route stops guessing.
const HEARTBEAT_STALE_SECS = Number(process.env.KEEPER_HEARTBEAT_STALE_SECS) || 180;

let cached: StatusPayload | null = null;

async function getSlot(layer: "base" | "er"): Promise<LayerStatus> {
  const out = await rpcPost(UPSTREAMS[layer], FALLBACKS[layer], { jsonrpc: "2.0", id: 1, method: "getSlot" });
  if (!out) return { ok: false, slot: null };
  const result = (out.json as { result?: unknown })?.result;
  if (typeof result !== "number") return { ok: false, slot: null };
  return { ok: true, slot: result, degraded: out.degraded };
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

/**
 * Read every `<name>.json` in HEARTBEAT_DIR. A missing directory, a missing
 * file, a half-written file and a foreign .json are all the SAME answer here:
 * omitted, and therefore unknown. None of them may be reported as a dead
 * keeper — the frontend is routinely deployed away from the keeper host, and a
 * health endpoint that cries outage because it cannot see the fleet is the
 * exact failure the `base.ok:false` episode already taught this route.
 */
async function heartbeats(): Promise<HeartbeatStatus[]> {
  let files: string[];
  try {
    files = (await readdir(HEARTBEAT_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const now = Math.floor(Date.now() / 1000);
  const out: HeartbeatStatus[] = [];
  for (const f of files) {
    try {
      const hb = JSON.parse(await readFile(join(HEARTBEAT_DIR, f), "utf8")) as {
        name?: unknown;
        ts?: unknown;
        ok?: unknown;
        lastError?: unknown;
      };
      // All three, not just `ts`: the default directory is the OS temp dir,
      // which on any real box also holds other programs' JSON. Requiring the
      // full shape is what keeps someone else's scratch file out of the fleet.
      if (typeof hb?.name !== "string" || typeof hb.ts !== "number" || typeof hb.ok !== "boolean") {
        continue;
      }
      const ageSecs = now - hb.ts;
      out.push({
        name: hb.name,
        ageSecs,
        ok: hb.ok,
        lastError: typeof hb.lastError === "string" ? hb.lastError : null,
        stale: ageSecs > HEARTBEAT_STALE_SECS,
      });
    } catch {
      // Unreadable or mid-write: skip this one, keep the rest.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function keeperStatus(layer: "base" | "er"): Promise<Omit<KeeperStatus, "fleet" | "fleetOk">> {
  const unknown: Omit<KeeperStatus, "fleet" | "fleetOk"> = {
    lastFundingTs: null,
    ageSecs: null,
    stalled: null,
  };
  try {
    // Imported inside the try, not at module scope: `@/lib/manifest` THROWS on
    // evaluation when deploy.json is absent, and a health endpoint that 500s
    // when the thing it reports on is misconfigured is the failure it exists to
    // report. Same reason the keepers now resolve their feed lazily (S7-02).
    const { MARKET } = await import("@/lib/manifest");
    const { decodeMarket } = await import("@/lib/slipstream");
    const out = await rpcPost(UPSTREAMS[layer], FALLBACKS[layer], {
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [MARKET.toBase58(), { encoding: "base64" }],
    });
    if (!out) return unknown;
    const json = out.json as { result?: { value?: { data?: unknown[] } } };
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
  const [base, er, fillTs, funding, fleet] = await Promise.all([
    getSlot("base"),
    getSlot("er"),
    lastFillAt(),
    keeperStatus("base"),
    heartbeats(),
  ]);
  // Nothing read = unknown, NOT healthy and NOT down. `every` on [] is true,
  // which would have reported a perfect fleet on a host that has never seen a
  // keeper — the same false all-clear this whole block exists to end.
  const fleetOk = fleet.length ? fleet.every((h) => h.ok && !h.stale) : null;
  cached = {
    base,
    er,
    indexer: { lastFillAt: fillTs },
    keepers: { ...funding, fleet, fleetOk },
    at: Date.now(),
  };
  return Response.json(cached);
}
