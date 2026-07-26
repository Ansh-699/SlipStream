import { PublicKey, Transaction } from "@solana/web3.js";
import {
  getBaseConnection,
  getErConnection,
  loadKeypair,
  sendAndConfirm,
  sleep,
  log,
} from "./shared/connection";
import { AccountSubscriber } from "./shared/subscriber";
import { getKeeperAddresses } from "./shared/manifest";
import { sendErTx, classifyTxError } from "./shared/ertx";
import {
  createSettleTradesInstruction,
  createRecordPendingFillInstruction,
  createCommitOrderbookInstruction,
} from "../../client/src/instructions";
import {
  findUserAccountPda,
  findPositionPda,
} from "../../client/src/pda";
import {
  decodeFillEvent,
  decodeOrderBookHeader,
  FILL_EVENT_SIZE,
  ORDER_BOOK_HEADER_SIZE,
  ORDER_SLOT_SIZE,
  PRICE_LEVEL_SIZE,
} from "../../client/src/accounts";

const MARKET_INDEX = 0;
const MAX_FILLS_PER_TX = 8; // Conservative; settle_trades CU usage scales linearly
const SETTLEMENT_DEBOUNCE_MS = 200;
// How long to wait for the scheduled ER->L1 commit to land on the base layer.
const COMMIT_POLL_TRIES = 20;
const COMMIT_POLL_INTERVAL_MS = 1_500;

// FillQueueEmpty = error.rs index 29 (base 0x100) -> 0x11d. settle_trades returns
// this when there is nothing NEW to settle (count==0 or every queued fill is at or
// below the program's owned cursor). It is an idempotent no-op signal, not a real
// error, so the keeper treats it as "nothing to do yet" instead of spamming.
const ERR_FILL_QUEUE_EMPTY = 0x11d;

/** Byte offset of the FillEvent ring within the OrderBook account data. */
function fillsBaseOffset(
  maxOrderSlots: number,
  maxPriceLevelsPerSide: number
): number {
  return (
    ORDER_BOOK_HEADER_SIZE +
    maxOrderSlots * ORDER_SLOT_SIZE +
    maxPriceLevelsPerSide * PRICE_LEVEL_SIZE * 2
  );
}

async function main() {
  const baseConnection = getBaseConnection();
  const erConnection = getErConnection();
  const keeper = loadKeypair();
  log("SETTLEMENT", `keeper ${keeper.publicKey.toBase58()}`);

  // Req 6.1: resolve the orderbook + program addresses from the Deploy_Manifest
  // (with the SDK-derived PDA as the configured fallback). Throws a descriptive
  // error if the manifest is missing (Req 6.3).
  const { orderBook: orderBookPda, programId } = getKeeperAddresses();

  // Local mirror of the program's owned settlement cursor (Market.last_settled_
  // sequence). settle_trades reads the committed OrderBook READ-ONLY and tracks
  // settlement progress itself, so repeated calls are safe; we mirror the cursor
  // here only to build the correct remaining-account set for the NEXT batch and
  // to walk forward window-by-window. Advanced in lockstep with the program on a
  // successful settle (and on a FillQueueEmpty no-op for the attempted window).
  let lastProcessedSeq: bigint | null = null;
  let inFlight = false;
  let pendingTrigger: NodeJS.Timeout | null = null;

  const subscriber = new AccountSubscriber(erConnection);

  /**
   * BUG 3 fix — commit the ER OrderBook to L1 before settling.
   *
   * The OrderBook is delegated to the ER; fills accumulate in the ER copy while
   * the L1 copy stays stale (the program commits only on explicit commit, since
   * commit_frequency = u32::MAX). Calling record_pending_fill + settle_trades on
   * L1 while its fill queue is empty reverts with FillQueueEmpty (0x11d).
   *
   * So: when fills are present on the ER, schedule a commit_orderbook on the ER
   * (it CPIs the magic program's ScheduleCommit — the SDK's top-level commit
   * cannot make the program-owned PDA sign), then poll the L1 OrderBook until the
   * committed fills land, and only then settle on L1.
   *
   * Returns true if the L1 fill queue now reflects the ER fills, false otherwise.
   */
  async function commitErToL1(): Promise<boolean> {
    const erInfo = await erConnection.getAccountInfo(orderBookPda);
    if (!erInfo) return false;
    const erHeader = decodeOrderBookHeader(erInfo.data as Buffer);
    if (erHeader.fillEventCount === 0) return false;

    try {
      const commitIx = createCommitOrderbookInstruction(
        keeper.publicKey,
        MARKET_INDEX,
        programId
      );
      const sig = await sendErTx(erConnection, commitIx, keeper);
      log("SETTLEMENT", `commit_orderbook scheduled on ER: ${sig}`);
    } catch (e: any) {
      log("SETTLEMENT", `commit_orderbook failed on ER: ${e?.message ?? e}`);
      return false;
    }

    // Poll L1 until the committed fills land (queue never pops on L1, so the L1
    // count converges up to the ER count once the commit is applied).
    for (let i = 0; i < COMMIT_POLL_TRIES; i++) {
      await sleep(COMMIT_POLL_INTERVAL_MS);
      const l1 = await baseConnection.getAccountInfo(orderBookPda);
      if (!l1) continue;
      const l1Header = decodeOrderBookHeader(l1.data as Buffer);
      if (i % 4 === 0) {
        log(
          "SETTLEMENT",
          `waiting for commit: L1 fillEventCount=${l1Header.fillEventCount} (ER=${erHeader.fillEventCount})`
        );
      }
      if (l1Header.fillEventCount >= erHeader.fillEventCount) {
        log(
          "SETTLEMENT",
          `commit landed on L1: fillEventCount=${l1Header.fillEventCount}`
        );
        return true;
      }
    }
    log("SETTLEMENT", "commit did not land on L1 within poll window");
    return false;
  }

  /**
   * Settle the next batch of NEW fills from the (committed) L1 OrderBook.
   * Reads the L1 fill ring READ-ONLY, selects up to MAX_FILLS_PER_TX fills with
   * sequence > lastProcessedSeq (strictly in queue order), builds the user +
   * position remaining-account set for exactly those fills, and bundles
   * record_pending_fill + settle_trades atomically so the pending_fills bump
   * rolls back with the settle if the queue turns out empty.
   */
  async function settleFromL1(): Promise<void> {
    const l1 = await baseConnection.getAccountInfo(orderBookPda);
    if (!l1) return;
    const data = l1.data as Buffer;
    const header = decodeOrderBookHeader(data);
    const count = header.fillEventCount;
    const maxFills = header.maxFillEvents;
    if (count === 0 || maxFills === 0) return;

    const base = fillsBaseOffset(header.maxOrderSlots, header.maxPriceLevelsPerSide);
    const head = header.fillEventHead;

    // Walk the queue from the head, skipping fills already settled (sequence at or
    // below our mirrored cursor), and collect the next window of NEW fills.
    const newFills: { sequence: bigint; maker: PublicKey; taker: PublicKey }[] = [];
    let maxSeqInWindow: bigint | null = null;
    for (let i = 0; i < count && newFills.length < MAX_FILLS_PER_TX; i++) {
      const idx = (head + i) % maxFills;
      const fill = decodeFillEvent(data, base + idx * FILL_EVENT_SIZE);
      if (lastProcessedSeq !== null && fill.sequence <= lastProcessedSeq) {
        continue;
      }
      newFills.push({
        sequence: fill.sequence,
        maker: new PublicKey(fill.maker),
        taker: new PublicKey(fill.taker),
      });
      if (maxSeqInWindow === null || fill.sequence > maxSeqInWindow) {
        maxSeqInWindow = fill.sequence;
      }
    }

    if (newFills.length === 0) {
      // Everything currently in the queue is already settled per our cursor.
      return;
    }

    // Build the unique UserAccount + Position remaining-account set for the batch.
    const userAccountSet = new Map<string, PublicKey>();
    const positionSet = new Map<string, PublicKey>();
    for (const fill of newFills) {
      for (const owner of [fill.maker, fill.taker]) {
        const [u] = findUserAccountPda(owner, programId);
        userAccountSet.set(u.toBase58(), u);
        const [p] = findPositionPda(owner, MARKET_INDEX, programId);
        positionSet.set(p.toBase58(), p);
      }
    }

    const userAccounts = Array.from(userAccountSet.values());
    const remainingForSettle = [
      ...userAccounts.map((pk) => ({ pubkey: pk, isSigner: false, isWritable: true })),
      ...Array.from(positionSet.values()).map((pk) => ({
        pubkey: pk,
        isSigner: false,
        isWritable: true,
      })),
    ];

    const numFills = newFills.length;
    const firstSeq = newFills[0].sequence;

    // Bundle: record_pending_fill (bumps pending_fills) + settle_trades. Atomic —
    // both land in one tx so a FillQueueEmpty revert also rolls back the bump.
    const tx = new Transaction()
      .add(createRecordPendingFillInstruction(userAccounts, keeper.publicKey, programId))
      .add(createSettleTradesInstruction(MARKET_INDEX, numFills, remainingForSettle, programId));

    try {
      const sig = await sendAndConfirm(baseConnection, tx, [keeper]);
      log(
        "SETTLEMENT",
        `settled ${numFills} fills (seq ${firstSeq}..${maxSeqInWindow}): ${sig}`
      );
      if (maxSeqInWindow !== null) lastProcessedSeq = maxSeqInWindow;
    } catch (e: any) {
      const classified = classifyTxError(e);
      if (classified.code === ERR_FILL_QUEUE_EMPTY) {
        // No-op: the program's cursor is already at/past this window (e.g. another
        // keeper settled it, or we restarted). Advance our mirror so we walk
        // forward to genuinely-new fills instead of retrying the same window.
        log(
          "SETTLEMENT",
          `FillQueueEmpty for seq ${firstSeq}..${maxSeqInWindow} — already settled, advancing cursor`
        );
        if (maxSeqInWindow !== null) lastProcessedSeq = maxSeqInWindow;
      } else {
        log("SETTLEMENT", `settle error: ${classified.name ?? classified.raw}`);
      }
    }
  }

  /**
   * One end-to-end pass: commit the ER book to L1 (if it has fills), then drain
   * the L1 queue batch-by-batch until no new fills remain.
   */
  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const committed = await commitErToL1();
      if (!committed) return;

      // Drain all currently-committed new fills in MAX_FILLS_PER_TX windows.
      let prevSeq: bigint | null = null;
      // Guard against an infinite loop: stop once the cursor stops advancing.
      for (let pass = 0; pass < 64; pass++) {
        await settleFromL1();
        if (lastProcessedSeq === prevSeq) break;
        prevSeq = lastProcessedSeq;
      }
    } catch (e: any) {
      log("SETTLEMENT", `tick error: ${e?.message ?? e}`);
    } finally {
      inFlight = false;
    }
  }

  function scheduleTick(): void {
    if (pendingTrigger !== null) return;
    pendingTrigger = setTimeout(() => {
      pendingTrigger = null;
      void tick();
    }, SETTLEMENT_DEBOUNCE_MS);
  }

  // Subscribe to the OrderBook on the ER endpoint — fills land there first.
  subscriber.subscribe(orderBookPda, () => {
    scheduleTick();
  });

  log("SETTLEMENT", "subscribed; waiting for fill events");

  // Initial pass in case there are pending fills from before keeper start.
  await tick();

  // Keep alive
  // eslint-disable-next-line no-constant-condition
  while (true) await sleep(60_000);
}

main().catch((err) => {
  console.error("settlement keeper crashed:", err);
  process.exit(1);
});
