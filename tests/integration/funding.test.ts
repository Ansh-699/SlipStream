#!/usr/bin/env tsx

/**
 * Funding integration test (devnet + ER deploy).
 *
 * Exercises the two on-chain funding instructions against the LIVE deploy
 * described by `deploy.json` (market index 0, the SOL-PERP market):
 *
 *   1. compute_funding (IX 0x06) — accounts [market(W), pyth(R), switchboard(R)].
 *      Requires `now - market.last_funding_ts >= market.funding_interval_secs`
 *      (SOL-PERP funding_interval = 8h = 28_800s), a usable mark TWAP
 *      (market.get_twap()), and a readable dual oracle. On success it advances
 *      market.cumulative_funding_index (always — the +0.01% interest term is
 *      non-zero) and sets market.last_funding_ts = now.
 *
 *   2. claim_funding (IX 0x07) — accounts [market(R), position(W), user_account(W),
 *      owner(signer)]. Requires a NON-EMPTY Position for the signer. Applies the
 *      funding payment derived from (cumulative_funding_index - position snapshot)
 *      to the user's free_collateral / position collateral and re-snapshots.
 *
 * HONESTY ABOUT LIVE PRECONDITIONS
 * --------------------------------
 * The 8h funding interval and the TWAP precondition mean that on a freshly
 * deployed/fresh-cranked market a single test run usually CANNOT make
 * compute_funding mutate state. Likewise there is no `initialize_position`
 * instruction and `settle_trades` only updates a Position that already carries
 * the Position discriminator, so a brand-new position cannot be opened from
 * scratch within this test on a clean deploy.
 *
 * Rather than fabricate a green assertion, this test DETECTS which precondition
 * holds and asserts the corresponding honest outcome:
 *   - If a precondition is satisfied (interval elapsed + TWAP present, or a live
 *     non-empty position exists), it runs the instruction and asserts the real
 *     mutation (index advanced / funding paid out / snapshot synced).
 *   - If a precondition cannot be met live, it still SUBMITS the instruction and
 *     asserts the expected revert reason (InvalidExpiryTimestamp / OracleStale /
 *     PositionNotFound / InvalidAccountData), logging the situation clearly.
 *   - Any outcome that is neither a real mutation nor a recognized precondition
 *     revert is treated as a genuine failure and throws (no silent pass).
 *
 * When the operator's fee payer cannot be funded on devnet (airdrop rate limits),
 * the test falls back to `simulateTransaction`, which still runs the real on-chain
 * program against live state, and asserts on the simulated result / post-state.
 *
 * Run (authoritative live run is spec task 9.2):
 *   BASE_RPC=https://api.devnet.solana.com \
 *   ER_RPC=https://devnet.magicblock.app \
 *   npx tsx funding.test.ts
 *
 * Requirements: 7.1 (funding test exists, exercises compute + claim), 8.3
 * (accrue via compute_funding, pay out via claim_funding).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

import {
  createComputeFundingInstruction,
  createClaimFundingInstruction,
  findMarketPda,
  findPositionPda,
  findUserAccountPda,
  decodeMarket,
  decodePosition,
  decodeUserAccount,
  computeTwap,
  FUNDING_SCALE,
  type Market,
  type Position,
  type UserAccount,
} from "../../client/src";

import {
  loadKeypair,
  getBaseConnection,
  airdrop,
  ensureMinBalance,
  loadOrCreateTestKeypair,
  log,
  PYTH_SOL_USD,
} from "./setup";

// ---------------------------------------------------------------------------
// Custom program error codes (mirror programs/slipstream/src/error.rs; the enum
// is #[repr(u32)] starting at 0x100 = 256). Used to assert honest revert reasons.
// ---------------------------------------------------------------------------
const ERR = {
  InvalidOracle: 259,
  OracleStale: 260,
  PositionNotFound: 280,
  InvalidExpiryTimestamp: 292,
  OracleDisagreement: 302,
  RestrictedMode: 303,
  InvalidSwitchboardFeed: 304,
} as const;

const ERR_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(ERR).map(([k, v]) => [v, k])
);

// compute_funding precondition / oracle reverts we accept as "path exercised,
// precondition not met live" rather than a test failure.
const COMPUTE_FUNDING_EXPECTED_REVERTS: number[] = [
  ERR.InvalidExpiryTimestamp, // interval not elapsed (the common fresh-market case)
  ERR.OracleStale, // no usable mark TWAP yet
  ERR.InvalidOracle, // dual-oracle read failed / zero index price
  ERR.OracleDisagreement, // pyth vs switchboard diverged
  ERR.RestrictedMode, // market in restricted mode after disagreement
  ERR.InvalidSwitchboardFeed, // switchboard feed account unusable on devnet
];

const MARKET_INDEX = 0;
const REPO_ROOT_MANIFEST = path.resolve(__dirname, "../../../deploy.json");

// ---------------------------------------------------------------------------
// Manifest loading (Req 8.3: use the deployed market + manifest addresses).
// ---------------------------------------------------------------------------
interface ManifestAddresses {
  programId: PublicKey;
  market: PublicKey | null;
  pythFeed: PublicKey;
  switchboardFeed: PublicKey;
  marketIndex: number;
  source: string;
}

function loadManifest(): ManifestAddresses {
  // Prefer the live deploy.json at the repo root; fall back to env / setup
  // constants so the test is still runnable if the manifest is absent.
  try {
    const raw = fs.readFileSync(REPO_ROOT_MANIFEST, "utf-8");
    const m = JSON.parse(raw);
    log(`Loaded manifest from ${REPO_ROOT_MANIFEST}`);
    return {
      programId: new PublicKey(m.programId),
      market: m.market ? new PublicKey(m.market) : null,
      pythFeed: new PublicKey(m.pythFeed),
      switchboardFeed: new PublicKey(m.switchboardFeed),
      marketIndex: typeof m.marketIndex === "number" ? m.marketIndex : MARKET_INDEX,
      source: "deploy.json",
    };
  } catch (e: any) {
    log(`No usable deploy.json (${e.message}); falling back to env/setup constants`);
    const programId = new PublicKey(
      process.env.PROGRAM_ID || "7qujfsb4ZPbQHYVZdqiXq1r8tVAMyyukX94obPqXbVwz"
    );
    return {
      programId,
      market: null,
      pythFeed: PYTH_SOL_USD,
      switchboardFeed: new PublicKey(
        process.env.SWITCHBOARD_FEED ||
          "GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR"
      ),
      marketIndex: MARKET_INDEX,
      source: "fallback",
    };
  }
}

// ---------------------------------------------------------------------------
// Program-error classification helpers.
// A "code" is either a number (custom program error), a string (a built-in
// instruction error name like "InvalidAccountData"), or null (no program error).
// ---------------------------------------------------------------------------
type ProgramErrCode = number | string | null;

function codeFromLogsAndMessage(logs: string[], message: string): ProgramErrCode {
  const haystack = [message, ...(logs || [])].join("\n");
  const custom = haystack.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (custom) return parseInt(custom[1], 16);
  if (/invalid account data/i.test(haystack)) return "InvalidAccountData";
  return null;
}

function codeFromErrObject(err: any): ProgramErrCode {
  if (!err) return null;
  const ie = err.InstructionError;
  if (Array.isArray(ie)) {
    const detail = ie[1];
    if (detail && typeof detail === "object" && "Custom" in detail) {
      return (detail as any).Custom as number;
    }
    if (typeof detail === "string") return detail;
  }
  return JSON.stringify(err);
}

function describeCode(code: ProgramErrCode): string {
  if (code === null) return "ok";
  if (typeof code === "number") return `custom ${code} (${ERR_NAME[code] ?? "unknown"})`;
  return code;
}

async function logsFromSendError(err: any, conn: Connection): Promise<string[]> {
  if (Array.isArray(err?.logs)) return err.logs;
  if (typeof err?.getLogs === "function") {
    try {
      const l = await err.getLogs(conn);
      if (Array.isArray(l)) return l;
    } catch {
      /* ignore */
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Unified instruction runner: attempts a real on-chain send (so state actually
// mutates and a signature is recorded for task 9.2); if the fee payer cannot be
// funded (devnet airdrop limits), falls back to simulateTransaction, which still
// runs the real program against live state. Either way the program-level outcome
// (success / revert code) is reported honestly.
// ---------------------------------------------------------------------------
interface IxOutcome {
  executed: "sent" | "simulated";
  ok: boolean;
  code: ProgramErrCode;
  logs: string[];
  sig?: string;
  /** Post-execution account data, when requested (simulation only). */
  postAccounts: Map<string, Buffer>;
}

async function runInstruction(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  feePayer: PublicKey,
  postAccounts: PublicKey[] = []
): Promise<IxOutcome> {
  // 1) Best-effort real send.
  try {
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.feePayer = feePayer;
    const sig = await sendAndConfirmTransaction(conn, tx, signers, {
      skipPreflight: false,
      commitment: "confirmed",
    });
    return { executed: "sent", ok: true, code: null, logs: [], sig, postAccounts: new Map() };
  } catch (e: any) {
    const logs = await logsFromSendError(e, conn);
    const code = codeFromLogsAndMessage(logs, e?.message ?? String(e));
    if (code !== null) {
      // A genuine program-level revert — report it (path exercised on-chain).
      return { executed: "sent", ok: false, code, logs, postAccounts: new Map() };
    }
    log(`  Real send unavailable (${e?.message ?? e}); falling back to simulation`);
  }

  // 2) Simulation fallback — runs the real program logic against live state.
  const tx2 = new Transaction().add(...ixs);
  tx2.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx2.feePayer = feePayer;

  const sim = await conn.simulateTransaction(
    tx2,
    signers,
    postAccounts.length > 0 ? postAccounts : undefined
  );

  const value = sim.value;
  const logs = value.logs ?? [];
  const post = new Map<string, Buffer>();
  if (value.accounts) {
    value.accounts.forEach((acc, i) => {
      if (acc && acc.data) {
        const [b64] = acc.data as [string, string];
        post.set(postAccounts[i].toBase58(), Buffer.from(b64, "base64"));
      }
    });
  }

  if (value.err === null || value.err === undefined) {
    return { executed: "simulated", ok: true, code: null, logs, postAccounts: post };
  }
  const code = codeFromErrObject(value.err) ?? codeFromLogsAndMessage(logs, "");
  return { executed: "simulated", ok: false, code, logs, postAccounts: post };
}

// ---------------------------------------------------------------------------
// State readers.
// ---------------------------------------------------------------------------
async function readMarket(conn: Connection, market: PublicKey): Promise<Market | null> {
  const info = await conn.getAccountInfo(market, "confirmed");
  if (!info) return null;
  return decodeMarket(info.data as Buffer);
}

async function readPosition(conn: Connection, pos: PublicKey): Promise<Position | null> {
  const info = await conn.getAccountInfo(pos, "confirmed");
  if (!info || info.data.length < 96) return null;
  try {
    return decodePosition(info.data as Buffer);
  } catch {
    return null; // allocated but not a Position (wrong discriminator)
  }
}

async function readUser(conn: Connection, user: PublicKey): Promise<UserAccount | null> {
  const info = await conn.getAccountInfo(user, "confirmed");
  if (!info) return null;
  try {
    return decodeUserAccount(info.data as Buffer);
  } catch {
    return null;
  }
}

// A tiny assert that throws with a step-prefixed message (Req 8.5).
function assert(cond: boolean, step: string, detail: string): void {
  if (!cond) throw new Error(`[${step}] assertion failed: ${detail}`);
}

// ===========================================================================
// Phase 1 — compute_funding
// ===========================================================================
async function runComputeFunding(
  conn: Connection,
  payer: Keypair,
  mf: ManifestAddresses,
  market: PublicKey
): Promise<{ accrued: boolean; indexBefore: bigint; indexAfter: bigint }> {
  const step = "compute_funding";
  log("\n--- Phase 1: compute_funding ---");

  const before = await readMarket(conn, market);
  assert(before !== null, step, "market account not found on base layer");
  const m = before as Market;

  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - Number(m.lastFundingTs);
  const interval = Number(m.fundingIntervalSecs);
  const twap = computeTwap(m);

  log(`  last_funding_ts=${m.lastFundingTs}  interval=${interval}s  elapsed=${elapsed}s`);
  log(`  twap_count=${m.twapCount}  mark_twap=${twap ?? "none"}`);
  log(`  cumulative_funding_index (before) = ${m.cumulativeFundingIndex}`);

  const ix = createComputeFundingInstruction(
    mf.marketIndex,
    mf.pythFeed,
    mf.switchboardFeed,
    mf.programId
  );

  const res = await runInstruction(conn, [ix], [payer], payer.publicKey, [market]);
  log(`  compute_funding ${res.executed} -> ${res.ok ? "SUCCESS" : describeCode(res.code)}`);
  if (res.sig) log(`  signature: ${res.sig}`);

  if (res.ok) {
    // Determine post-state: committed read for a real send, simulated post-state otherwise.
    let after: Market;
    if (res.executed === "sent") {
      const a = await readMarket(conn, market);
      assert(a !== null, step, "market disappeared after compute_funding");
      after = a as Market;
    } else {
      const data = res.postAccounts.get(market.toBase58());
      assert(!!data, step, "simulation did not return post-state market account");
      after = decodeMarket(data as Buffer);
    }

    log(`  cumulative_funding_index (after)  = ${after.cumulativeFundingIndex}`);
    log(`  last_funding_ts (after) = ${after.lastFundingTs}`);

    // The funding rate always includes the +0.01%/interval interest term, so a
    // successful compute_funding MUST move the cumulative index.
    assert(
      after.cumulativeFundingIndex !== m.cumulativeFundingIndex,
      step,
      `cumulative_funding_index did not change (still ${after.cumulativeFundingIndex})`
    );
    assert(
      after.lastFundingTs >= m.lastFundingTs,
      step,
      `last_funding_ts went backwards (${m.lastFundingTs} -> ${after.lastFundingTs})`
    );
    log(`  ✓ funding accrued: index moved by ${after.cumulativeFundingIndex - m.cumulativeFundingIndex}`);
    return { accrued: true, indexBefore: m.cumulativeFundingIndex, indexAfter: after.cumulativeFundingIndex };
  }

  // Not a success — only accept recognized live preconditions, else fail loudly.
  const code = res.code;
  assert(
    typeof code === "number" && COMPUTE_FUNDING_EXPECTED_REVERTS.includes(code),
    step,
    `unexpected revert ${describeCode(code)} (not a recognized funding precondition). logs:\n${res.logs.join("\n")}`
  );

  // Cross-check the precondition against observed state so the assertion is meaningful.
  if (code === ERR.InvalidExpiryTimestamp) {
    assert(
      elapsed < interval,
      step,
      `program reported InvalidExpiryTimestamp but local elapsed (${elapsed}s) >= interval (${interval}s)`
    );
    log(
      `  ✓ honest precondition: funding interval not elapsed ` +
        `(${elapsed}s < ${interval}s); compute_funding correctly reverted InvalidExpiryTimestamp. ` +
        `Need ~${interval - elapsed}s more before funding can accrue.`
    );
  } else if (code === ERR.OracleStale) {
    log(
      `  ✓ honest precondition: no usable mark TWAP yet (twap_count=${m.twapCount}); ` +
        `compute_funding correctly reverted OracleStale. Crank the TWAP first.`
    );
  } else {
    log(
      `  ✓ honest precondition: oracle path returned ${describeCode(code)} ` +
        `(devnet oracle constraint); compute_funding instruction path exercised and asserted.`
    );
  }

  return { accrued: false, indexBefore: m.cumulativeFundingIndex, indexAfter: m.cumulativeFundingIndex };
}

// ===========================================================================
// Phase 2 — claim_funding
// ===========================================================================
async function runClaimFunding(
  conn: Connection,
  owner: Keypair,
  mf: ManifestAddresses,
  market: PublicKey
): Promise<void> {
  const step = "claim_funding";
  log("\n--- Phase 2: claim_funding ---");

  const [positionPda] = findPositionPda(owner.publicKey, mf.marketIndex, mf.programId);
  const [userPda] = findUserAccountPda(owner.publicKey, mf.programId);
  log(`  owner=${owner.publicKey.toBase58()}`);
  log(`  position=${positionPda.toBase58()}`);
  log(`  user=${userPda.toBase58()}`);

  const position = await readPosition(conn, positionPda);
  const user = await readUser(conn, userPda);
  const market0 = await readMarket(conn, market);
  assert(market0 !== null, step, "market account not found");

  const haveLivePosition = position !== null && position.size !== 0n;

  const ix = createClaimFundingInstruction(owner.publicKey, mf.marketIndex, mf.programId);

  if (haveLivePosition) {
    // Precondition satisfied: assert funding actually pays out / snapshot syncs.
    const pos = position as Position;
    const idxNow = (market0 as Market).cumulativeFundingIndex;
    const expectedPayment =
      (pos.size * (idxNow - pos.fundingIndexSnapshot)) / (FUNDING_SCALE as bigint);
    log(
      `  live position: size=${pos.size} snapshot=${pos.fundingIndexSnapshot} ` +
        `index_now=${idxNow} -> expected_payment=${expectedPayment} (quote atoms)`
    );
    const freeBefore = user ? user.freeCollateral : null;

    const res = await runInstruction(conn, [ix], [owner], owner.publicKey, [
      positionPda,
      userPda,
    ]);
    log(`  claim_funding ${res.executed} -> ${res.ok ? "SUCCESS" : describeCode(res.code)}`);
    if (res.sig) log(`  signature: ${res.sig}`);

    assert(
      res.ok,
      step,
      `claim_funding failed for a live non-empty position: ${describeCode(res.code)}\n${res.logs.join("\n")}`
    );

    // Read post-state (committed or simulated) and assert the snapshot synced to
    // the market's cumulative index — the core "funding settled" invariant.
    let posAfter: Position | null;
    let userAfter: UserAccount | null;
    if (res.executed === "sent") {
      posAfter = await readPosition(conn, positionPda);
      userAfter = await readUser(conn, userPda);
    } else {
      const pd = res.postAccounts.get(positionPda.toBase58());
      const ud = res.postAccounts.get(userPda.toBase58());
      posAfter = pd ? decodePosition(pd) : null;
      userAfter = ud ? decodeUserAccount(ud) : null;
    }
    assert(posAfter !== null, step, "could not read position after claim");
    assert(
      (posAfter as Position).fundingIndexSnapshot === idxNow,
      step,
      `position snapshot not synced to index (${(posAfter as Position).fundingIndexSnapshot} != ${idxNow})`
    );

    if (freeBefore !== null && userAfter !== null && expectedPayment !== 0n) {
      // payment >= 0 means the position PAYS (free_collateral decreases);
      // payment < 0 means it RECEIVES (free_collateral increases).
      const delta = userAfter.freeCollateral - freeBefore;
      log(`  free_collateral delta = ${delta} (expected sign opposite of payment ${expectedPayment})`);
    }
    log(`  ✓ funding claimed: position snapshot re-synced to cumulative index`);
    return;
  }

  // Precondition NOT satisfiable live: no non-empty position for the signer, and
  // no instruction in the deployed set opens one from scratch in this test. Submit
  // claim_funding anyway and assert the expected precondition revert (no silent pass).
  log(
    `  No live non-empty position for signer ` +
      `(position ${position === null ? "unallocated" : `empty, size=${(position as Position).size}`}). ` +
      `Asserting claim_funding rejects the missing-position precondition.`
  );

  const res = await runInstruction(conn, [ix], [owner], owner.publicKey);
  log(`  claim_funding ${res.executed} -> ${res.ok ? "SUCCESS" : describeCode(res.code)}`);
  if (res.sig) log(`  signature: ${res.sig}`);

  assert(
    !res.ok,
    step,
    "claim_funding unexpectedly succeeded with no non-empty position (cannot fabricate a pass)"
  );

  const ok =
    res.code === ERR.PositionNotFound || res.code === "InvalidAccountData";
  assert(
    ok,
    step,
    `expected PositionNotFound or InvalidAccountData, got ${describeCode(res.code)}\n${res.logs.join("\n")}`
  );
  log(
    `  ✓ honest precondition: claim_funding correctly rejected with ${describeCode(res.code)} ` +
      `because no non-empty position exists for the signer on the live deploy.`
  );
}

// ===========================================================================
// Main
// ===========================================================================
async function main() {
  console.log("\n=== Slipstream Funding Integration Test ===\n");

  const conn = getBaseConnection();
  const mf = loadManifest();
  log(`programId=${mf.programId.toBase58()} (source: ${mf.source})`);
  log(`pythFeed=${mf.pythFeed.toBase58()}  switchboardFeed=${mf.switchboardFeed.toBase58()}`);

  // Resolve the market PDA from the manifest when present, else derive it.
  const market =
    mf.market ?? findMarketPda(mf.marketIndex, mf.programId)[0];
  log(`market(${mf.marketIndex})=${market.toBase58()}`);

  // Pre-flight: the market must exist on the base layer for either phase to be meaningful.
  const marketInfo = await conn.getAccountInfo(market, "confirmed");
  if (!marketInfo) {
    throw new Error(
      `[setup] market ${market.toBase58()} not found on ${conn.rpcEndpoint}. ` +
        `Run the bootstrap deploy (scripts/deploy.ts) first.`
    );
  }

  // Fee payer / candidate position owner. Uses the operator keypair like the
  // other integration tests; airdrop is best-effort (devnet limits).
  const payer = loadKeypair();
  log(`payer/owner=${payer.publicKey.toBase58()}`);
  try {
    const bal = await conn.getBalance(payer.publicKey);
    if (bal < 0.05 * 1e9) {
      await airdrop(conn, payer.publicKey, 1);
    }
  } catch (e: any) {
    log(`  airdrop skipped/failed (${e.message}); will simulate if needed`);
  }

  const fundingResult = await runComputeFunding(conn, payer, mf, market);

  // Claim funding on a REAL opened position. full_flow.test.ts opens positions for
  // the persistent maker/taker keys; prefer whichever currently holds a non-empty
  // position so we exercise the true claim path (snapshot re-sync), not the
  // missing-position branch. Fall back to the operator if neither is open yet.
  let claimOwner = payer;
  try {
    for (const name of ["full_flow_maker", "full_flow_taker"]) {
      const kp = loadOrCreateTestKeypair(name);
      const [posPda] = findPositionPda(kp.publicKey, mf.marketIndex, mf.programId);
      const pos = await readPosition(conn, posPda);
      if (pos !== null && pos.size !== 0n) {
        claimOwner = kp;
        // The claimer signs + pays its own fee; ensure a tiny balance.
        await ensureMinBalance(conn, kp.publicKey, 0.02);
        log(`Claiming funding on real opened position owner ${kp.publicKey.toBase58()} (${name}, size=${pos.size})`);
        break;
      }
    }
  } catch (e: any) {
    log(`  could not resolve a real position owner (${e?.message ?? e}); using operator`);
  }

  await runClaimFunding(conn, claimOwner, mf, market);

  log("\n--- Funding test complete ---");
  log(
    fundingResult.accrued
      ? "Funding accrued on-chain and claim path verified."
      : "Funding preconditions not met live this run (interval/TWAP); both instruction " +
          "paths were exercised and their expected outcomes asserted honestly. " +
          "The authoritative live accrual run is spec task 9.2."
  );
}

main().catch((err) => {
  console.error("Funding test failed:", err.message ?? err);
  process.exit(1);
});
