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

const DB_PATH = process.env.INDEXER_DB
  ? resolve(process.env.INDEXER_DB)
  : defaultDbPath();

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
                `SELECT * FROM fills WHERE maker = ? OR taker = ?
                 ORDER BY sequence DESC LIMIT ?`
              )
              .all(wallet, wallet, limit)
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
    return Response.json({ fills: [], indexed: false });
  }
}
