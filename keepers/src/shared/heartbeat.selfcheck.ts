/**
 * Self-check for the heartbeat file CONTRACT (/api/status reads these).
 * Run:  npx tsx src/shared/heartbeat.selfcheck.ts
 */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-selfcheck-"));
process.env.KEEPER_HEARTBEAT_DIR = dir;

// Imported AFTER the env var is set — HEARTBEAT_DIR is resolved at module load.
const { beat, heartbeatPath } = require("./heartbeat");

beat("twap", true);
const ok = JSON.parse(fs.readFileSync(heartbeatPath("twap"), "utf-8"));
assert.deepStrictEqual(Object.keys(ok).sort(), ["lastError", "name", "ok", "ts"]);
assert.strictEqual(ok.name, "twap");
assert.strictEqual(ok.ok, true);
assert.strictEqual(ok.lastError, null);
assert.ok(Number.isInteger(ok.ts), "ts must be integer unix SECONDS");
assert.ok(Math.abs(ok.ts - Date.now() / 1000) < 5, "ts must be seconds, not millis");

beat("fill-log", false, new Error("boom").message);
const bad = JSON.parse(fs.readFileSync(heartbeatPath("fill-log"), "utf-8"));
assert.strictEqual(bad.ok, false);
assert.strictEqual(bad.lastError, "boom");

// Must never throw into a keeper loop.
assert.doesNotThrow(() => beat("expiry", true));

// No .tmp left behind by the write-then-rename.
assert.deepStrictEqual(
  fs.readdirSync(dir).sort(),
  ["expiry.json", "fill-log.json", "twap.json"]
);

fs.rmSync(dir, { recursive: true, force: true });
console.log("heartbeat selfcheck OK");
