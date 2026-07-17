// System status: base/ER RPC health + settlement indexer freshness. Server-side
// so upstream URLs (which may carry an API key) never reach the browser; results
// cached briefly to avoid multiplying RPC load by viewer count.
//
//   GET /api/status
//   -> { base: { ok, slot }, er: { ok, slot }, indexer: { lastFillAt | null } }

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

interface StatusPayload {
  base: LayerStatus;
  er: LayerStatus;
  indexer: { lastFillAt: number | null };
  at: number;
}

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

export async function GET(): Promise<Response> {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return Response.json(cached);
  }
  const [base, er, fillTs] = await Promise.all([
    getSlot(UPSTREAMS.base),
    getSlot(UPSTREAMS.er),
    lastFillAt(),
  ]);
  cached = { base, er, indexer: { lastFillAt: fillTs }, at: Date.now() };
  return Response.json(cached);
}
