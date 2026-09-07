// Settled-fills history, read from the SQLite DB the fill-log keeper writes
// (keepers/src/shared/fill-db.ts). Read-only; an absent DB (fresh checkout,
// keeper not running) returns an empty list rather than an error.
//
//   GET /api/trades?wallet=<base58>&limit=<n>
//
// Rows are newest-first. When `wallet` is given, only fills where it was maker
// or taker are returned.

import { NextRequest } from "next/server";
import { existsSync } from "fs";
import { join, dirname, resolve } from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same walk-up default as the keeper: repo-root/keepers/data/fills.db.
// Override with INDEXER_DB (absolute path).
function defaultDbPath(): string | null {
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

// Resolved per-request: the keeper creates the DB lazily on its first settled
// fill, which can be after this server process started.
function dbPath(): string | null {
  return process.env.INDEXER_DB ? resolve(process.env.INDEXER_DB) : defaultDbPath();
}

interface FillRow {
  sequence: number;
  market_index: number;
  price: number;
  quantity: number;
  maker: string;
  taker: string;
  maker_side: number;
  taker_fee_bps: number;
  maker_rebate_bps: number;
  settled_at: number;
}

export async function GET(req: NextRequest): Promise<Response> {
  const wallet = req.nextUrl.searchParams.get("wallet");
  const limit = Math.min(
    Math.max(parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10) || 50, 1),
    500
  );

  const DB_PATH = dbPath();
  if (!DB_PATH || !existsSync(DB_PATH)) {
    return Response.json({ fills: [], indexed: false });
  }

  try {
    // Dynamic import keeps better-sqlite3 (a native module) out of module-eval
    // during next build page collection.
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    try {
      const rows = (
        wallet
          ? db
              .prepare(
                // UNION ALL of two index-driven halves, each with its own LIMIT.
                //
                // `WHERE maker = ? OR taker = ?` does reach both indexes on a
                // current SQLite (MULTI-INDEX OR), but the LIMIT cannot apply
                // until after the sort, so the plan is
                // `MULTI-INDEX OR -> USE TEMP B-TREE FOR ORDER BY` over EVERY
                // fill that wallet has ever been party to, on every 10s poll
                // from every open tab, to return 60 rows. Cost grows with the
                // wallet's whole history.
                //
                // Because `sequence` is the rowid, idx_fills_maker is really
                // (maker, sequence): each arm below seeks its index in reverse
                // and stops at LIMIT rows with no sort at all, so the only sort
                // left is over the two 60-row halves. Measured on a 300k-row
                // book where one market maker is party to 200k fills: 31.8ms ->
                // 0.13ms. `AND maker != ?` on the taker arm drops the
                // self-match row UNION ALL would otherwise return twice.
                `SELECT * FROM (
                   SELECT * FROM fills WHERE maker = ?
                   ORDER BY sequence DESC LIMIT ?
                 )
                 UNION ALL
                 SELECT * FROM (
                   SELECT * FROM fills WHERE taker = ? AND maker != ?
                   ORDER BY sequence DESC LIMIT ?
                 )
                 ORDER BY sequence DESC LIMIT ?`
              )
              .all(wallet, limit, wallet, wallet, limit, limit)
          : db
              .prepare(`SELECT * FROM fills ORDER BY sequence DESC LIMIT ?`)
              .all(limit)
      ) as FillRow[];
      return Response.json({ fills: rows, indexed: true });
    } finally {
      db.close();
    }
  } catch (e) {
    console.error("[api/trades] read failed:", e);
    // Distinct from the absent-DB reply above. Both are `indexed: false`, but a
    // corrupt/locked/unreadable DB used to return the SAME empty success as
    // "the keeper has not written a fill yet", so a broken index read as an
    // account with no trade history. `error` is the only bit that separates
    // them. Fixed string — never `e`, which can carry a filesystem path.
    return Response.json({ fills: [], indexed: false, error: "unavailable" });
  }
}
