import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { log } from "./connection";

/**
 * SQLite fills indexer. The fill-log keeper appends every fill it settles on
 * L1; the frontend's /api/trades and /api/status routes read the same file.
 *
 * The DB is strictly best-effort: every write is wrapped so an indexer failure
 * can never break settlement. `settled_at` is the keeper's ingest time —
 * FillEvent carries no on-chain timestamp.
 *
 * Retention: unbounded by default (matches the previous behavior — nothing
 * here EVER deleted a row). Set INDEXER_RETENTION_DAYS to opt into pruning
 * fills older than that many days; checked at most once/day so it never adds
 * meaningful overhead to the settlement hot path.
 */

export interface IndexedFill {
  sequence: bigint;
  marketIndex: number;
  price: bigint;
  quantity: bigint;
  maker: string;
  taker: string;
  makerSide: number;
  filledMargin: bigint;
  takerFeeBps: number;
  makerRebateBps: number;
}

// Default lives under keepers/data/ next to this package, resolved like
// manifest.ts: walk up from __dirname until the keepers package root is found
// (works under both tsx src/ and compiled dist/ layouts). Override: INDEXER_DB.
function defaultDbPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return path.join(dir, "data", "fills.db");
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, "../../data/fills.db");
}

export const FILL_DB_PATH = process.env.INDEXER_DB || defaultDbPath();

let db: Database.Database | null = null;
let insertStmt: Database.Statement | null = null;
let failed = false;

const PRUNE_CHECK_INTERVAL_MS = 24 * 60 * 60_000; // at most once/day
let lastPruneCheckAt = 0;

/** Delete fills older than INDEXER_RETENTION_DAYS, if set. Best-effort, rate-limited. */
function maybePrune(): void {
  const retentionDays = Number(process.env.INDEXER_RETENTION_DAYS || "0");
  if (!(retentionDays > 0)) return; // unset/0 = keep everything
  const now = Date.now();
  if (now - lastPruneCheckAt < PRUNE_CHECK_INTERVAL_MS) return;
  lastPruneCheckAt = now;
  try {
    const cutoff = now - retentionDays * 24 * 60 * 60_000;
    const info = db!.prepare("DELETE FROM fills WHERE settled_at < ?").run(cutoff);
    if (info.changes > 0) {
      log("FILL-DB", `pruned ${info.changes} fill(s) older than ${retentionDays}d`);
    }
  } catch (e: any) {
    log("FILL-DB", `prune failed (non-fatal): ${e?.message ?? e}`);
  }
}

function open(): boolean {
  if (db) return true;
  if (failed) return false;
  try {
    fs.mkdirSync(path.dirname(FILL_DB_PATH), { recursive: true });
    db = new Database(FILL_DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS fills (
      sequence        INTEGER PRIMARY KEY,
      market_index    INTEGER NOT NULL,
      price           INTEGER NOT NULL,
      quantity        INTEGER NOT NULL,
      maker           TEXT    NOT NULL,
      taker           TEXT    NOT NULL,
      maker_side      INTEGER NOT NULL,
      filled_margin   INTEGER NOT NULL,
      taker_fee_bps   INTEGER NOT NULL,
      maker_rebate_bps INTEGER NOT NULL,
      settled_at      INTEGER NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_fills_maker ON fills(maker)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_fills_taker ON fills(taker)");
    insertStmt = db.prepare(`INSERT OR IGNORE INTO fills
      (sequence, market_index, price, quantity, maker, taker, maker_side,
       filled_margin, taker_fee_bps, maker_rebate_bps, settled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    log("FILL-DB", `indexing settled fills to ${FILL_DB_PATH}`);
    return true;
  } catch (e: any) {
    failed = true; // don't retry-spam every tick
    log("FILL-DB", `disabled — failed to open ${FILL_DB_PATH}: ${e?.message ?? e}`);
    return false;
  }
}

/** Record a batch of settled fills. Never throws. */
export function recordSettledFills(fills: IndexedFill[]): void {
  if (fills.length === 0 || !open()) return;
  try {
    const now = Date.now();
    const insertAll = db!.transaction((rows: IndexedFill[]) => {
      for (const f of rows) {
        insertStmt!.run(
          f.sequence,
          f.marketIndex,
          f.price,
          f.quantity,
          f.maker,
          f.taker,
          f.makerSide,
          f.filledMargin,
          f.takerFeeBps,
          f.makerRebateBps,
          now
        );
      }
    });
    insertAll(fills);
  } catch (e: any) {
    log("FILL-DB", `insert failed (settlement unaffected): ${e?.message ?? e}`);
  }
  maybePrune();
}
