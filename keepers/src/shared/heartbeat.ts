import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Keeper liveness heartbeat.
 *
 * WHY: /api/status derives `stalled` from `Market.last_funding_ts` alone, so it
 * only ever sees the FUNDING keeper. A dead twap / liquidation / expiry /
 * fill-log keeper is invisible to it — settlement has been stopped since the
 * fill-log keeper was killed and the status endpoint still reports healthy, the
 * same blind spot that let a 2.7-day outage pass unnoticed.
 *
 * Each keeper drops one small JSON file per successful loop iteration; the
 * status route reads the directory and reports anything whose `ts` is old (or
 * whose `ok` is false) as down. No new dependency, no daemon, no network.
 *
 * The file shape is a CONTRACT with the status route — do not change it:
 *   { "name": string, "ts": number /* unix seconds *\/, "ok": boolean,
 *     "lastError": string | null }
 */

export interface Heartbeat {
  name: string;
  /** Unix SECONDS of the write (not millis). */
  ts: number;
  ok: boolean;
  lastError: string | null;
}

/** Where heartbeats live. Override with KEEPER_HEARTBEAT_DIR. */
export const HEARTBEAT_DIR = process.env.KEEPER_HEARTBEAT_DIR || os.tmpdir();

export function heartbeatPath(name: string): string {
  return path.join(HEARTBEAT_DIR, `${name}.json`);
}

/** Truncate so one pathological error message can't fill the disk. */
const MAX_ERROR_CHARS = 500;

/**
 * Write this keeper's heartbeat. NEVER throws: a keeper must not die because a
 * disk is full or the directory is read-only.
 */
export function beat(name: string, ok: boolean, lastError: string | null = null): void {
  try {
    const hb: Heartbeat = {
      name,
      ts: Math.floor(Date.now() / 1000),
      ok,
      lastError: lastError === null ? null : String(lastError).slice(0, MAX_ERROR_CHARS),
    };
    const file = heartbeatPath(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename: the reader is a separate process, and a plain
    // writeFileSync truncates before it writes, so a poll landing in that
    // window gets an empty file and reports a live keeper as broken.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(hb));
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort by design — see above */
  }
}
