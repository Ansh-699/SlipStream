import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  getBaseConnection,
  getErConnection,
  loadKeypair,
  sendAndConfirm,
  sleep,
  log,
} from "./shared/connection";
import { getKeeperAddresses } from "./shared/manifest";
import { sendErTx, classifyTxError, errText } from "./shared/ertx";
import { recordSettledFills } from "./shared/fill-db";
import {
  createInitializeFillLogInstruction,
  createDelegateFillLogInstruction,
  createMirrorFillsInstruction,
  createCommitFillLogInstruction,
  createSettleFromLogInstruction,
  createRecordPendingFillInstruction,
} from "../../client/src/instructions";
import { findFillLogPda, findUserAccountPda, findPositionPda } from "../../client/src/pda";
import { DELEGATION_PROGRAM_ID } from "../../client/src/constants";
import { decodeFillLogHeader, decodeFillLogFills } from "../../client/src/accounts";

/**
 * fill-log settlement keeper — the settlement pipeline that actually lands ER
 * fills as L1 Positions, WITHOUT ever committing the 612 KB OrderBook.
 *
 * Pipeline each tick:
 *   1. mirror_fills  (ER): copy new OrderBook fills into the small FillLog.
 *   2. commit_fill_log (ER): flush the FillLog to L1 (each commit consumes 1 of
 *      the account's 10 sponsored commits — proven empirically).
 *   3. settle_from_log (L1): read the committed FillLog and write Positions.
 *
 * EPOCH ROTATION: the sponsored-commit cap is a hard 10 PER delegated account
 * (verified live on two fresh accounts). When the current FillLog nears 10
 * commits, the keeper initializes + delegates the NEXT epoch's FillLog (a fresh
 * PDA with its own fresh 10) and rolls over. Settlement is therefore continuous;
 * old epoch logs are drained then abandoned (each ~8 KB, trivial devnet rent).
 */

const MARKET_INDEX = 0;
const MAX_FILLS_PER_TX = 8;
const POLL_INTERVAL_MS = 4000;
const COMMIT_POLL_TRIES = 15;
const COMMIT_POLL_INTERVAL_MS = 1500;
// Rotate BEFORE the hard cap of 10 so a commit never fails mid-flight.
const COMMITS_BEFORE_ROTATE = 9;
const ERR_FILL_QUEUE_EMPTY = 0x11d;
const ERR_FILL_QUEUE_FULL = 0x11e;
// Bound each mirror_fills call: max_fills=0 (uncapped) scans+copies the whole
// 4096-slot fill ring and blows the CU budget once a backlog builds (observed
// live: "exceeded CUs meter", settlement stalled for days). The on-chain
// FillLog ring holds FILL_LOG_CAPACITY=80 and now refuses (FillQueueFull)
// rather than overwriting once full, so this is a throughput knob, not a
// safety one — kept at FILL_LOG_CAPACITY/2 - MAX_FILLS_PER_TX so two
// consecutive mirrors without an intervening settle still leave headroom.
const MAX_FILLS_PER_MIRROR = 32;
// Ring scan + appends need more than the 200k default; the ER honors
// ComputeBudget (verified live: bounded mirror consumed 83k with headroom).
const MIRROR_CU_LIMIT = 600_000;
// Consecutive mirror failures before assuming the current epoch is unusable
// (full log + spent commit budget) and rotating to a fresh one.
const MIRROR_ERRORS_BEFORE_ROTATE = 3;

// Market::_padding2[0..4] holds the L1 settlement cursor (little-endian u32);
// see programs/slipstream/src/state/market.rs last_settled_sequence().
const MARKET_CURSOR_OFFSET = 2058;

async function main() {
  const base = getBaseConnection();
  const er = getErConnection();
  const keeper = loadKeypair();
  const { programId, marketIndex, market } = getKeeperAddresses();

  /** Read Market.last_settled_sequence from L1 (0 if the account is unreadable). */
  async function readMarketCursor(): Promise<bigint> {
    const info = await base.getAccountInfo(market);
    if (!info || info.data.length < MARKET_CURSOR_OFFSET + 4) return 0n;
    return BigInt(info.data.readUInt32LE(MARKET_CURSOR_OFFSET));
  }

  log("FILLLOG-KEEPER", `keeper ${keeper.publicKey.toBase58()} market=${marketIndex}`);

  let epoch = parseInt(process.env.FILL_LOG_START_EPOCH ?? "0", 10);
  let commitsThisEpoch = 0;
  // L1 settlement cursor mirror (Market.last_settled_sequence is the source of truth).
  let lastSettledSeq: bigint | null = null;

  /**
   * Discover the current live epoch: the highest epoch whose FillLog already
   * exists. Rotation state is in-memory only, so a restart that blindly
   * resumed at FILL_LOG_START_EPOCH landed on a long-abandoned epoch (full
   * log, spent commit budget) and settlement deadlocked. Probes the ER, which
   * knows every delegated FillLog, so discovery works even when the base RPC
   * is rate-limited.
   */
  async function discoverEpoch(startEpoch: number): Promise<number> {
    let ep = startEpoch;
    for (;;) {
      const [nextFl] = findFillLogPda(marketIndex, ep + 1, programId);
      if (!(await er.getAccountInfo(nextFl))) return ep;
      ep += 1;
    }
  }

  /** Ensure the FillLog for `epoch` exists + is delegated to the ER. Idempotent. */
  async function ensureEpochReady(ep: number): Promise<void> {
    const [fillLog] = findFillLogPda(marketIndex, ep, programId);
    const info = await base.getAccountInfo(fillLog);
    if (!info) {
      const ix = createInitializeFillLogInstruction(keeper.publicKey, marketIndex, ep, programId);
      const sig = await sendAndConfirm(base, new Transaction().add(ix), [keeper]);
      log("FILLLOG-KEEPER", `epoch ${ep}: initialize_fill_log ${sig}`);
    }
    const after = await base.getAccountInfo(fillLog);
    const delegated = after?.owner.toBase58() === DELEGATION_PROGRAM_ID.toBase58();
    if (!delegated) {
      const ix = createDelegateFillLogInstruction(keeper.publicKey, marketIndex, ep, programId);
      const sig = await sendAndConfirm(base, new Transaction().add(ix), [keeper]);
      log("FILLLOG-KEEPER", `epoch ${ep}: delegate_fill_log ${sig}`);
      await sleep(3000);
    }
  }

  /** Rotate to the next epoch (fresh commit budget). */
  async function rotate(): Promise<void> {
    const next = epoch + 1;
    log("FILLLOG-KEEPER", `rotating epoch ${epoch} -> ${next} (commit budget exhausted)`);
    await ensureEpochReady(next);
    epoch = next;
    commitsThisEpoch = 0;
  }

  /** mirror_fills on the ER: append new orderbook fills to the current FillLog. */
  async function mirror(): Promise<"mirrored" | "empty" | "error"> {
    try {
      const ix = createMirrorFillsInstruction(
        marketIndex,
        epoch,
        MAX_FILLS_PER_MIRROR,
        programId
      );
      const sig = await sendErTx(er, ix, keeper, { computeUnits: MIRROR_CU_LIMIT });
      log("FILLLOG-KEEPER", `epoch ${epoch}: mirror_fills ${sig}`);
      return "mirrored";
    } catch (e: any) {
      const c = classifyTxError(e);
      if (c.code === ERR_FILL_QUEUE_EMPTY) return "empty"; // nothing new
      if (c.code === ERR_FILL_QUEUE_FULL) {
        log("FILLLOG-KEEPER", `epoch ${epoch}: FillLog ring full; needs settle+rotate`);
        return "error"; // reuses the same rotate-after-N-failures path below
      }
      log("FILLLOG-KEEPER", `mirror_fills error: ${c.name ?? c.raw}`);
      return "error";
    }
  }

  /** commit_fill_log on the ER; rotate first if at the budget edge. Returns the
   *  ER FillLog header count we expect to see committed on L1. */
  async function commit(): Promise<boolean> {
    if (commitsThisEpoch >= COMMITS_BEFORE_ROTATE) {
      await rotate();
    }
    const [fillLog] = findFillLogPda(marketIndex, epoch, programId);
    const erInfo = await er.getAccountInfo(fillLog);
    if (!erInfo) return false;
    const erHeader = decodeFillLogHeader(erInfo.data as Buffer);
    if (erHeader.count === 0) return false;

    // Fast-forward guard: a fresh epoch's FillLog re-mirrors the ring from
    // sequence 0, so right after a rotation everything mirrored may already be
    // settled on L1. Committing those burns the epoch's 10-commit budget on
    // no-op settles and forces an endless rotate loop. Keep mirroring (which
    // advances last_mirrored_sequence) but skip the commit until the mirror
    // passes the market's settlement cursor.
    const cursor = await readMarketCursor();
    if (erHeader.lastMirroredSequence <= cursor) return false;

    try {
      const ix = createCommitFillLogInstruction(keeper.publicKey, marketIndex, epoch, programId);
      const sig = await sendErTx(er, ix, keeper);
      commitsThisEpoch += 1;
      log(
        "FILLLOG-KEEPER",
        `epoch ${epoch}: commit_fill_log #${commitsThisEpoch} ${sig} (count=${erHeader.count})`
      );
    } catch (e: any) {
      const c = classifyTxError(e);
      // Defensive: if we somehow hit the cap, rotate and retry next tick.
      if (c.raw.includes("sponsored commit limit")) {
        log("FILLLOG-KEEPER", `hit commit cap on epoch ${epoch}; rotating`);
        await rotate();
        return false;
      }
      log("FILLLOG-KEEPER", `commit_fill_log error: ${c.name ?? c.raw}`);
      return false;
    }

    // Poll L1 until the committed FillLog reflects the ER count.
    for (let i = 0; i < COMMIT_POLL_TRIES; i++) {
      await sleep(COMMIT_POLL_INTERVAL_MS);
      const l1 = await base.getAccountInfo(fillLog);
      if (!l1) continue;
      try {
        const l1Header = decodeFillLogHeader(l1.data as Buffer);
        if (l1Header.count >= erHeader.count) return true;
      } catch {
        /* not yet a valid committed copy */
      }
    }
    log("FILLLOG-KEEPER", `commit for epoch ${epoch} did not land within poll window`);
    return false;
  }

  /** settle_from_log on L1: read the committed FillLog, write Positions. Drains
   *  all NEW fills (sequence > cursor) in windows of MAX_FILLS_PER_TX. */
  async function settle(): Promise<void> {
    const [fillLog] = findFillLogPda(marketIndex, epoch, programId);
    const l1 = await base.getAccountInfo(fillLog);
    if (!l1) return;

    let header;
    try {
      header = decodeFillLogHeader(l1.data as Buffer);
    } catch {
      return;
    }
    if (header.count === 0) return;
    const fills = decodeFillLogFills(l1.data as Buffer);

    // `Market.last_settled_sequence` is the ONLY authority on what has settled.
    // Reading it once at startup and thereafter trusting the WINDOW maximum is
    // what let a partial settle skip the unsettled remainder forever while the
    // keeper logged "settled N fills" and indexed them as settled.
    let cursor = await readMarketCursor();

    let progressed = true;
    while (progressed) {
      progressed = false;

      // Mirror settle_from_log's OWN stop rules, so the window submitted is
      // exactly the set it will consume. `decodeFillLogFills` walks the ring in
      // the same `(head + i) % capacity` order the program does, so the two
      // walks see the same sequence.
      //
      // Rule (a): the CONTIGUOUS run from cursor + 1. The program breaks at the
      // first gap (R4's S4-01 fix) and writes only the prefix maximum.
      const windowFills: typeof fills = [];
      let next = cursor + 1n;
      for (const f of fills) {
        if (f.sequence < next) continue; // already settled
        if (f.sequence !== next) break; // gap — the program stops here too
        windowFills.push(f);
        next += 1n;
        if (windowFills.length >= MAX_FILLS_PER_TX) break;
      }
      if (windowFills.length === 0) return;

      // Rule (b): the program also breaks at the first fill any of whose four
      // L1 accounts is absent, and 75% of live fills have no L1 Position
      // (s4.md), so a partial settle is the EXPECTED case. Drop the tail from
      // the first such fill rather than submitting a window that cannot settle.
      const pdasFor = (f: (typeof fills)[number]) =>
        [new PublicKey(f.maker), new PublicKey(f.taker)].flatMap((owner) => [
          findUserAccountPda(owner, programId)[0],
          findPositionPda(owner, MARKET_INDEX, programId)[0],
        ]);
      const probe = new Map<string, PublicKey>();
      for (const f of windowFills) for (const pk of pdasFor(f)) probe.set(pk.toBase58(), pk);
      const probeKeys = Array.from(probe.values());
      const live = new Set<string>();
      // MAX_FILLS_PER_TX is 8, so this is at most 32 keys — one batched call.
      const infos = await base.getMultipleAccountsInfo(probeKeys);
      infos.forEach((info, i) => {
        if (info && info.owner.equals(programId) && info.data.length > 0) {
          live.add(probeKeys[i].toBase58());
        }
      });
      const firstOrphan = windowFills.findIndex(
        (f) => !pdasFor(f).every((pk) => live.has(pk.toBase58()))
      );
      if (firstOrphan >= 0) windowFills.length = firstOrphan;
      if (windowFills.length === 0) {
        // The queue is blocked on an orphan fill. R4 made this a liveness
        // problem with an operator fix (supply the accounts or rotate the
        // epoch) rather than unauthenticated destruction of settled trades.
        // Say so instead of bumping pending_fills for a window that cannot
        // settle and then silently skipping past it.
        log(
          "FILLLOG-KEEPER",
          `epoch ${epoch}: seq ${cursor + 1n} has no L1 UserAccount/Position — queue blocked, not skipped`
        );
        return;
      }

      const userSet = new Map<string, PublicKey>();
      const posSet = new Map<string, PublicKey>();
      for (const f of windowFills) {
        for (const owner of [new PublicKey(f.maker), new PublicKey(f.taker)]) {
          const [u] = findUserAccountPda(owner, programId);
          userSet.set(u.toBase58(), u);
          const [p] = findPositionPda(owner, MARKET_INDEX, programId);
          posSet.set(p.toBase58(), p);
        }
      }
      const users = Array.from(userSet.values());
      // record_pending_fill bumps once per listed account; settle_from_log
      // decrements once per (fill, side). Listing the deduplicated set here is
      // what left 13 live accounts permanently stuck behind the withdrawal gate
      // (S4-04), so list one entry per (fill, side) instead — duplicates are
      // intentional and cost one byte each in the compiled message. The
      // remaining-account set below stays deduplicated; settlement resolves it
      // by key.
      //
      // The bump is symmetric ONLY because `windowFills` is now the truncated,
      // will-actually-settle set. Bumping a whole window against a settlement
      // that stops at the first gap or orphan left 2 x (window - settled)
      // outstanding, and re-bumped the same fills on every retry.
      const bumps = windowFills.flatMap((f) =>
        [new PublicKey(f.maker), new PublicKey(f.taker)].map(
          (owner) => findUserAccountPda(owner, programId)[0]
        )
      );
      const remaining = [
        ...users.map((pk) => ({ pubkey: pk, isSigner: false, isWritable: true })),
        ...Array.from(posSet.values()).map((pk) => ({
          pubkey: pk,
          isSigner: false,
          isWritable: true,
        })),
      ];

      const tx = new Transaction()
        .add(createRecordPendingFillInstruction(bumps, keeper.publicKey, programId))
        .add(
          createSettleFromLogInstruction(
            marketIndex,
            epoch,
            windowFills.length,
            remaining,
            programId
          )
        );

      try {
        const sig = await sendAndConfirm(base, tx, [keeper]);
        // What settled is what the CHAIN cursor says settled, never the window
        // maximum. settle_from_log also returns (settled_count, cursor) now; the
        // cursor read here is one RPC either way and needs no getTransaction.
        const after = await readMarketCursor();
        const settledFills = windowFills.filter((f) => f.sequence <= after);
        log(
          "FILLLOG-KEEPER",
          `epoch ${epoch}: settled ${settledFills.length}/${windowFills.length} fills ` +
            `(cursor ${cursor} -> ${after}) ${sig}`
        );
        lastSettledSeq = after;
        if (after <= cursor) return; // no forward progress — do not spin
        cursor = after;
        progressed = true;
        // Index only what actually settled (best-effort; never breaks settlement).
        recordSettledFills(
          settledFills.map((f) => ({
            sequence: f.sequence,
            marketIndex: MARKET_INDEX,
            price: f.price,
            quantity: f.quantity,
            maker: new PublicKey(f.maker).toBase58(),
            taker: new PublicKey(f.taker).toBase58(),
            makerSide: f.makerSide,
            filledMargin: f.filledMargin,
            takerFeeBps: f.takerFeeBpsSnapshot,
            makerRebateBps: f.makerRebateBpsSnapshot,
          }))
        );
      } catch (e: any) {
        const c = classifyTxError(e);
        if (c.code === ERR_FILL_QUEUE_EMPTY) {
          // The tx reverted, so the bump rolled back with it. Re-read rather
          // than assuming the window settled.
          lastSettledSeq = await readMarketCursor();
          return;
        }
        log("FILLLOG-KEEPER", `settle_from_log error: ${c.name ?? c.raw}`);
        return;
      }
    }
  }

  // A stuck epoch (full FillLog whose commit budget is spent) fails mirror
  // forever, and tick() returning early meant the rotate path in commit()
  // could never run — the exact live deadlock this replaces. Rotate directly
  // after repeated mirror failures instead.
  let mirrorErrors = 0;

  async function tick(): Promise<void> {
    const mirrored = await mirror();
    if (mirrored === "error") {
      mirrorErrors += 1;
      if (mirrorErrors >= MIRROR_ERRORS_BEFORE_ROTATE) {
        log(
          "FILLLOG-KEEPER",
          `mirror failed ${mirrorErrors}x on epoch ${epoch}; rotating to a fresh epoch`
        );
        mirrorErrors = 0;
        await rotate();
      }
    } else {
      mirrorErrors = 0;
      if (mirrored === "mirrored") await commit();
    }
    // Always attempt to drain whatever is already committed on L1, independent
    // of what mirror/commit did this tick: settle_from_log is exactly-once via
    // Market.last_settled_sequence (safe to call with nothing to do), and
    // gating it behind a fresh mirror+commit success left already-committed
    // fills stranded whenever either step merely had nothing new to report.
    await settle();
  }

  epoch = await discoverEpoch(epoch);
  // Seed the local settle cursor from chain so restart doesn't re-send settle
  // windows for fills the program will just report as already settled.
  try {
    lastSettledSeq = await readMarketCursor();
    log("FILLLOG-KEEPER", `L1 settlement cursor: ${lastSettledSeq}`);
  } catch {
    /* base may be unreachable at boot; settle() copes with a null cursor */
  }
  // Startup needs base-RPC writes (init/delegate). Retry with backoff instead
  // of crashing: the old exit(1)-into-pm2-restart loop burned RPC quota on
  // every relaunch (33k restarts observed).
  for (;;) {
    try {
      await ensureEpochReady(epoch);
      break;
    } catch (e: any) {
      log("FILLLOG-KEEPER", `startup not ready: ${errText(e)}; retrying in 30s`);
      await sleep(30_000);
    }
  }
  log("FILLLOG-KEEPER", `ready on epoch ${epoch}; entering loop`);

  let consecutiveErrors = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tick();
      consecutiveErrors = 0;
    } catch (e: any) {
      consecutiveErrors += 1;
      log("FILLLOG-KEEPER", `tick error (${consecutiveErrors}): ${errText(e)}`);
      if (consecutiveErrors > 10) {
        log("FILLLOG-KEEPER", "too many consecutive errors, backing off 60s");
        await sleep(60_000);
        consecutiveErrors = 0;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  log("FILLLOG-KEEPER", `crashed: ${errText(err)}`);
  process.exit(1);
});
