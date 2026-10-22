/**
 * Operator script: move the settlement cursor past the ONE fill it is stuck on,
 * via skip_unsettleable_fill (0x2B). Authority key only.
 *
 * When to use it: the fill-log keeper logs
 *   "settlement wedged at seq N — next fill IS committed but will not settle"
 * because the fill's maker or taker has no L1 UserAccount / Position (an old
 * bot key, say), or the fill breaks the margin bound. settle_from_log stops on
 * such a fill forever, and every fill behind it waits.
 *
 * The program re-checks everything this script reports and refuses a fill it
 * can still settle, so the script cannot discard a real trade. But a skip is
 * IRREVERSIBLE — the fill is never applied on L1 — and a missing Position is
 * curable by its owner with one initialize_position. Decide which it is first;
 * this script only sends with --send.
 *
 * Usage (from keepers/):
 *   npx tsx --env-file=.env src/skip-unsettleable-fill.ts --epoch <n>          # report only
 *   npx tsx --env-file=.env src/skip-unsettleable-fill.ts --epoch <n> --send   # skip it
 */
import { Transaction } from "@solana/web3.js";
import { getBaseConnection, loadKeypair, sendAndConfirm, log } from "./shared/connection";
import { getKeeperAddresses } from "./shared/manifest";
import { findFillLogPda, findPositionPda, findUserAccountPda } from "../../client/src/pda";
import { decodeFillLogFills } from "../../client/src/accounts";
import { createSkipUnsettleableFillInstruction } from "../../client/src/instructions";

/** Market.last_settled_sequence (u32 window), as the keepers read it. */
const MARKET_CURSOR_OFFSET = 2058;
const BASE_SCALE = 1_000_000_000n;
const TAG = "SKIP-FILL";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const epochArg = arg("--epoch");
  if (epochArg === undefined || !/^\d+$/.test(epochArg)) {
    throw new Error("usage: skip-unsettleable-fill.ts --epoch <n> [--send]");
  }
  const epoch = Number(epochArg);
  const send = process.argv.includes("--send");
  const base = getBaseConnection();
  const { programId, marketIndex, market } = getKeeperAddresses();

  const marketInfo = await base.getAccountInfo(market);
  if (!marketInfo) throw new Error(`market ${market.toBase58()} not found`);
  const cursor = BigInt(marketInfo.data.readUInt32LE(MARKET_CURSOR_OFFSET));

  const [fillLog] = findFillLogPda(marketIndex, epoch, programId);
  const logInfo = await base.getAccountInfo(fillLog);
  if (!logInfo) throw new Error(`FillLog epoch ${epoch} (${fillLog.toBase58()}) has no committed L1 copy`);
  // The fill settlement stops on: the first entry above the cursor, in ring order.
  const fill = decodeFillLogFills(logInfo.data as Buffer).find((f) => f.sequence > cursor);

  log(TAG, `market ${market.toBase58()} cursor ${cursor}, FillLog epoch ${epoch}`);
  if (!fill) {
    log(TAG, "no committed fill above the cursor — nothing is blocked in this epoch");
    return;
  }
  if (fill.sequence !== cursor + 1n) {
    log(TAG, `first fill above the cursor is ${fill.sequence}, not ${cursor + 1n}: a GAP, not a stuck fill.`);
    log(TAG, "settlement already stops at gaps without reverting, and a missing sequence may still arrive; not skippable");
    return;
  }

  const notional = (fill.quantity * fill.price) / BASE_SCALE;
  const invalid = fill.filledMargin > notional;
  const accounts = [
    ["maker UserAccount", findUserAccountPda(fill.maker, programId)[0]],
    ["taker UserAccount", findUserAccountPda(fill.taker, programId)[0]],
    ["maker Position", findPositionPda(fill.maker, marketIndex, programId)[0]],
    ["taker Position", findPositionPda(fill.taker, marketIndex, programId)[0]],
  ] as const;
  const infos = await base.getMultipleAccountsInfo(accounts.map(([, pk]) => pk));
  const missing = accounts.filter((_, i) => !infos[i] || !infos[i]!.owner.equals(programId));

  log(TAG, `blocking fill ${fill.sequence}: maker ${fill.maker.toBase58()} taker ${fill.taker.toBase58()}`);
  log(TAG, `  qty ${fill.quantity} @ ${fill.price}, filled_margin ${fill.filledMargin} (notional ${notional})`);
  for (const [name, pk] of missing) log(TAG, `  MISSING ${name} ${pk.toBase58()}`);
  if (invalid) log(TAG, "  INVALID: filled_margin exceeds the fill's own notional; settlement reverts on it");

  if (!invalid && missing.length === 0) {
    log(TAG, "all four accounts exist and the margin is in bounds: this fill is settleable, the program will refuse to skip it");
    return;
  }
  if (!invalid && missing.every(([name]) => name.endsWith("Position"))) {
    log(TAG, "  note: only Position accounts are missing; the owner can create them with initialize_position and the fill would settle");
  }
  if (!send) {
    log(TAG, "report only — re-run with --send to skip this fill (irreversible)");
    return;
  }

  const authority = loadKeypair();
  const ix = createSkipUnsettleableFillInstruction(
    authority.publicKey, marketIndex, epoch, fill.sequence, fill.maker, fill.taker, programId
  );
  const sig = await sendAndConfirm(base, new Transaction().add(ix), [authority]);
  log(TAG, `sent ${sig}`);

  const after = await base.getAccountInfo(market);
  const nowCursor = BigInt(after!.data.readUInt32LE(MARKET_CURSOR_OFFSET));
  log(TAG, `cursor now ${nowCursor}`);
  if (nowCursor !== fill.sequence) throw new Error("verification FAILED: the cursor did not move to the skipped fill");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
