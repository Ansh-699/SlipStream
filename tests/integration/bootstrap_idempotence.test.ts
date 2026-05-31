#!/usr/bin/env tsx

/**
 * Bootstrap idempotence property test (spec task 5.4).
 *
 * **Property 1: Bootstrap idempotence**
 *   For any on-chain bootstrap state, running the Bootstrap_Script and then
 *   running it again SHALL leave every already-existing PDA (GlobalState,
 *   Market, OrderBook) byte-identical to its state after the first run —
 *   re-running mutates nothing for targets that already exist.
 *   Formally: bootstrap(bootstrap(x)) == bootstrap(x).
 *
 * **Validates: Requirements 4.3, 4.6, 4.7**
 *
 * Strategy (the deploy is ALREADY done on devnet — deploy.json holds the live
 * addresses; the program/global/market/orderbook all exist):
 *
 *   (a) Read the current GlobalState, Market, and OrderBook account DATA from
 *       devnet (the post-first-run state) — this is the "before" snapshot.
 *   (b) Re-run the idempotent bootstrap (scripts/deploy.ts) with SKIP_DEPLOY=1
 *       and the existing USDC_MINT/USDC_VAULT so it does NOT redeploy the program
 *       or recreate the mint. Every init step (initialize_global,
 *       initialize_market, grow_orderbook, delegate_orderbook) is guarded by an
 *       existence check, so on an already-bootstrapped state the re-run sends NO
 *       transactions and makes NO on-chain changes.
 *   (c) Re-read the three accounts — the "after" snapshot.
 *   (d) Assert the on-chain account data is BYTE-IDENTICAL before vs after.
 *
 * IDEMPOTENCE DETAIL: deploy.ts writes deploy.json with a fresh `deployedAt`
 * timestamp each run. That manifest file is NOT on-chain state, so it does not
 * violate Property 1 (which is about the on-chain PDAs). We therefore assert
 * byte-identity of the ON-CHAIN GlobalState/Market/OrderBook accounts ONLY. To
 * avoid clobbering the existing manifest (it carries an extra
 * `lastUpgradeSignature` field deploy.ts does not re-emit), we snapshot
 * deploy.json before the re-run and restore it afterward.
 *
 * The OrderBook is delegated to the ER (owned by the delegation program on L1).
 * Reading its L1 account data is fine — a delegated account's L1 data is a frozen
 * snapshot until it commits, so snapshotting and comparing it is well-defined.
 *
 * Run (live; cheap — the idempotent re-run sends no txs, just RPC reads + the
 * guarded bootstrap):
 *   BASE_RPC=https://api.devnet.solana.com \
 *   ER_RPC=https://devnet.magicblock.app \
 *   npx tsx bootstrap_idempotence.test.ts
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { getBaseConnection, log } from "./setup";

// Repo layout: this file is at slipstream/tests/integration/, repo root is 3 up.
const REPO_ROOT = path.resolve(__dirname, "../../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "deploy.json");
const DEPLOY_SCRIPT = path.join("scripts", "deploy.ts"); // relative to REPO_ROOT
// deploy.ts imports @solana/web3.js / @solana/spl-token transitively; resolve
// them from the integration-tests node_modules via NODE_PATH (matches how the
// bootstrap was run in prior tasks).
const NODE_MODULES = path.join(__dirname, "node_modules");
const TSX_BIN = path.join(NODE_MODULES, ".bin", "tsx");

// The three on-chain PDAs whose byte-identity defines Property 1.
const TARGET_FIELDS = ["globalState", "market", "orderBook"] as const;
type TargetField = (typeof TARGET_FIELDS)[number];

interface Snapshot {
  field: TargetField;
  address: string;
  exists: boolean;
  owner: string | null;
  byteLength: number;
  sha256: string;
  data: Buffer;
}

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function assert(cond: boolean, step: string, detail: string): void {
  if (!cond) throw new Error(`[${step}] assertion failed: ${detail}`);
}

async function snapshotAccount(
  conn: Connection,
  field: TargetField,
  address: PublicKey
): Promise<Snapshot> {
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info) {
    return {
      field,
      address: address.toBase58(),
      exists: false,
      owner: null,
      byteLength: 0,
      sha256: "",
      data: Buffer.alloc(0),
    };
  }
  const data = Buffer.from(info.data);
  return {
    field,
    address: address.toBase58(),
    exists: true,
    owner: info.owner.toBase58(),
    byteLength: data.length,
    sha256: sha256(data),
    data,
  };
}

async function snapshotAll(
  conn: Connection,
  targets: Record<TargetField, PublicKey>
): Promise<Record<TargetField, Snapshot>> {
  const out = {} as Record<TargetField, Snapshot>;
  for (const field of TARGET_FIELDS) {
    out[field] = await snapshotAccount(conn, field, targets[field]);
  }
  return out;
}

function printSnapshotTable(label: string, snaps: Record<TargetField, Snapshot>): void {
  log(`  ${label}:`);
  for (const field of TARGET_FIELDS) {
    const s = snaps[field];
    log(
      `    ${field.padEnd(11)} ${s.address}  exists=${s.exists}  ` +
        `len=${s.byteLength}  owner=${s.owner ?? "-"}  sha256=${s.sha256.slice(0, 16)}…`
    );
  }
}

/**
 * Re-run the idempotent bootstrap with SKIP_DEPLOY=1 and the existing mint/vault.
 * Returns the child's combined stdout+stderr so the caller can confirm no txs
 * were sent (the guarded re-run logs a tx signature only when it actually mutates
 * on-chain state).
 */
function rerunBootstrap(): { output: string; status: number | null } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_PATH: NODE_MODULES,
    SKIP_DEPLOY: "1",
    BASE_RPC: process.env.BASE_RPC || "https://api.devnet.solana.com",
    ER_RPC: process.env.ER_RPC || "https://devnet.magicblock.app",
    AUTHORITY_KEYPAIR:
      process.env.AUTHORITY_KEYPAIR ||
      path.join(process.env.HOME || "~", ".config/solana/id.json"),
    USDC_MINT:
      process.env.USDC_MINT || "Fakb9gPACMBbfQgepdAEmPCYmNU4iKAqQhFKfrDU6gDr",
    USDC_VAULT:
      process.env.USDC_VAULT || "BTWVG5oDmomaMkpdX4xYgfjr1gpEGodW5oPe3k5P71qr",
  };

  log(`  spawning: ${TSX_BIN} ${DEPLOY_SCRIPT}  (cwd=${REPO_ROOT}, SKIP_DEPLOY=1)`);
  const res = spawnSync(TSX_BIN, [DEPLOY_SCRIPT], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf-8",
    timeout: 240_000,
    maxBuffer: 32 * 1024 * 1024,
  });

  if (res.error) {
    throw new Error(`[rerun] failed to spawn bootstrap: ${res.error.message}`);
  }
  const output = `${res.stdout || ""}${res.stderr || ""}`;
  return { output, status: res.status };
}

/**
 * Scan the bootstrap output for evidence that it sent any transaction. deploy.ts
 * logs "  → <signature>" exactly when an init/grow/delegate step actually fired.
 * On a fully-bootstrapped target the re-run hits the existence guards and emits
 * none. We return the detected signature lines (should be empty for idempotence).
 */
function extractSignatureLines(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^→\s+[1-9A-HJ-NP-Za-km-z]{32,}$/.test(l));
}

async function main(): Promise<void> {
  console.log("\n=== Slipstream Bootstrap Idempotence Property Test (Property 1) ===\n");
  log("Validates: Requirements 4.3, 4.6, 4.7");

  // ---- Load the live manifest for the target addresses -------------------
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(
      `[setup] ${MANIFEST_PATH} not found. The deploy must already be done on devnet ` +
        `(run scripts/deploy.ts first).`
    );
  }
  const manifestRaw = fs.readFileSync(MANIFEST_PATH, "utf-8");
  const manifest = JSON.parse(manifestRaw);
  const targets: Record<TargetField, PublicKey> = {
    globalState: new PublicKey(manifest.globalState),
    market: new PublicKey(manifest.market),
    orderBook: new PublicKey(manifest.orderBook),
  };
  log(`programId=${manifest.programId}`);
  log(`globalState=${targets.globalState.toBase58()}`);
  log(`market=${targets.market.toBase58()}`);
  log(`orderBook=${targets.orderBook.toBase58()}`);

  const conn = getBaseConnection();
  log(`base RPC: ${conn.rpcEndpoint}`);

  // ---- (a) BEFORE snapshot ----------------------------------------------
  log("\n--- (a) Snapshot on-chain state BEFORE the bootstrap re-run ---");
  const before = await snapshotAll(conn, targets);
  printSnapshotTable("before", before);

  for (const field of TARGET_FIELDS) {
    assert(
      before[field].exists,
      "setup",
      `${field} (${before[field].address}) does not exist on-chain; ` +
        `Property 1 only constrains already-existing targets — run the initial bootstrap first`
    );
  }

  // ---- Preserve the existing manifest (deploy.ts rewrites deploy.json with a
  //      fresh deployedAt and drops extra fields like lastUpgradeSignature). The
  //      manifest is NOT on-chain state, so restoring it keeps this test
  //      non-destructive without affecting Property 1. ----------------------
  const manifestBackup = manifestRaw;

  // ---- (b) Re-run the idempotent bootstrap -------------------------------
  log("\n--- (b) Re-run the idempotent bootstrap (SKIP_DEPLOY=1) ---");
  let rerun: { output: string; status: number | null };
  try {
    rerun = rerunBootstrap();
  } finally {
    // Restore the original manifest regardless of the re-run outcome.
    fs.writeFileSync(MANIFEST_PATH, manifestBackup);
    log(`  restored original deploy.json (manifest is not on-chain state)`);
  }

  // Echo the child output (indented) so the live run is fully auditable.
  console.log("\n----- bootstrap re-run output -----");
  console.log(
    rerun.output
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n")
  );
  console.log("----- end bootstrap re-run output -----\n");

  assert(
    rerun.status === 0,
    "rerun",
    `bootstrap re-run exited with status ${rerun.status} (expected 0). See output above.`
  );

  // The guarded re-run must send NO transactions for already-existing targets.
  const sigLines = extractSignatureLines(rerun.output);
  log(`  transaction signatures emitted by the re-run: ${sigLines.length}`);
  for (const s of sigLines) log(`    ${s}`);
  assert(
    sigLines.length === 0,
    "rerun",
    `idempotent re-run emitted ${sigLines.length} transaction signature(s); ` +
      `it should mutate nothing for already-existing targets:\n${sigLines.join("\n")}`
  );

  // ---- (c) AFTER snapshot ------------------------------------------------
  log("\n--- (c) Snapshot on-chain state AFTER the bootstrap re-run ---");
  const after = await snapshotAll(conn, targets);
  printSnapshotTable("after", after);

  // ---- (d) Assert byte-identity (Property 1) -----------------------------
  log("\n--- (d) Assert byte-identical on-chain state (Property 1) ---");
  for (const field of TARGET_FIELDS) {
    const b = before[field];
    const a = after[field];

    assert(
      a.exists,
      "property-1",
      `${field} disappeared after the re-run (existed before at ${b.address})`
    );
    assert(
      a.byteLength === b.byteLength,
      "property-1",
      `${field} byte-length changed: ${b.byteLength} -> ${a.byteLength}`
    );
    assert(
      a.owner === b.owner,
      "property-1",
      `${field} owner changed: ${b.owner} -> ${a.owner}`
    );
    assert(
      a.sha256 === b.sha256,
      "property-1",
      `${field} sha256 changed: ${b.sha256} -> ${a.sha256}`
    );
    assert(
      b.data.equals(a.data),
      "property-1",
      `${field} account data is not byte-identical (lengths match but bytes differ)`
    );
    log(
      `  ✓ ${field.padEnd(11)} byte-identical  (len=${a.byteLength}, ` +
        `owner=${a.owner}, sha256=${a.sha256.slice(0, 16)}…)`
    );
  }

  log("\n--- Property 1 holds: bootstrap(bootstrap(x)) == bootstrap(x) ---");
  log(
    "The idempotent re-run sent 0 transactions and left GlobalState, Market, and " +
      "OrderBook byte-identical on-chain."
  );
  console.log("\n=== PASS: Bootstrap idempotence (Property 1) ===\n");
}

main().catch((err) => {
  console.error("\n=== FAIL: Bootstrap idempotence (Property 1) ===");
  console.error(err?.message ?? err);
  process.exit(1);
});
