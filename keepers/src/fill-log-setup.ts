import { Connection } from "@solana/web3.js";
import {
  getBaseConnection,
  getErConnection,
  loadKeypair,
  sendAndConfirm,
  sleep,
  log,
} from "./shared/connection";
import { getKeeperAddresses } from "./shared/manifest";
import { sendErTx } from "./shared/ertx";
import {
  createInitializeFillLogInstruction,
  createDelegateFillLogInstruction,
  createCommitFillLogInstruction,
} from "../../client/src/instructions";
import { findFillLogPda } from "../../client/src/pda";
import { DELEGATION_PROGRAM_ID } from "../../client/src/constants";
import { decodeFillLogHeader } from "../../client/src/accounts";
import { Transaction } from "@solana/web3.js";

/**
 * fill-log-setup — initialize + delegate the small FillLog for a market+epoch,
 * then PROVE the core assumption of the whole settlement redesign: that a fresh
 * delegated account carries its OWN sponsored-commit budget (i.e. it can be
 * committed many times, NOT capped at the orderbook's exhausted nonce of 10).
 *
 *   FILL_LOG_EPOCH=0 npx tsx src/fill-log-setup.ts [numCommits]
 *
 * Steps:
 *   1. initialize_fill_log on BASE (creates the small ~8 KB PDA)
 *   2. delegate_fill_log   on BASE (delegates it to the ER)
 *   3. commit_fill_log     on the ER, `numCommits` times (default 14 > old cap 10)
 *      — each commit must succeed; if we sail past 10 the assumption holds.
 */
async function main() {
  const numCommits = parseInt(process.argv[2] ?? "14", 10);
  const epoch = parseInt(process.env.FILL_LOG_EPOCH ?? "0", 10);

  const base = getBaseConnection();
  const er = getErConnection();
  const keeper = loadKeypair();
  const { programId, marketIndex } = getKeeperAddresses();
  const [fillLog] = findFillLogPda(marketIndex, epoch, programId);

  log("FILLLOG", `keeper ${keeper.publicKey.toBase58()}`);
  log("FILLLOG", `market index=${marketIndex} epoch=${epoch}`);
  log("FILLLOG", `fill_log PDA: ${fillLog.toBase58()}`);

  // Step 1: initialize on base (skip if it already exists).
  const existing = await base.getAccountInfo(fillLog);
  if (existing) {
    log("FILLLOG", `fill_log already exists (owner ${existing.owner.toBase58()})`);
  } else {
    const ix = createInitializeFillLogInstruction(keeper.publicKey, marketIndex, epoch, programId);
    const sig = await sendAndConfirm(base, new Transaction().add(ix), [keeper]);
    log("FILLLOG", `initialize_fill_log: ${sig}`);
  }

  // Step 2: delegate to the ER (skip if already delegated).
  const afterInit = await base.getAccountInfo(fillLog);
  const isDelegated = afterInit?.owner.toBase58() === DELEGATION_PROGRAM_ID.toBase58();
  if (isDelegated) {
    log("FILLLOG", `fill_log already delegated to ER`);
  } else {
    const ix = createDelegateFillLogInstruction(keeper.publicKey, marketIndex, epoch, programId);
    const sig = await sendAndConfirm(base, new Transaction().add(ix), [keeper]);
    log("FILLLOG", `delegate_fill_log: ${sig}`);
    await sleep(3000);
  }

  // Confirm it is readable on the ER.
  const erInfo = await er.getAccountInfo(fillLog);
  if (!erInfo) {
    log("FILLLOG", `WARNING: fill_log not yet visible on ER; waiting…`);
    await sleep(3000);
  }

  // Step 3: PROVE the commit budget — commit the FillLog `numCommits` times.
  log("FILLLOG", `--- proving commit budget: committing ${numCommits}x (old cap was 10) ---`);
  let ok = 0;
  for (let i = 1; i <= numCommits; i++) {
    try {
      const ix = createCommitFillLogInstruction(keeper.publicKey, marketIndex, epoch, programId);
      const sig = await sendErTx(er, ix, keeper);
      ok = i;
      log("FILLLOG", `commit #${i} OK: ${sig}`);
    } catch (e: any) {
      log("FILLLOG", `commit #${i} FAILED: ${e?.message ?? e}`);
      log("FILLLOG", `=> commit budget ran out at ${i - 1} successful commits.`);
      break;
    }
    await sleep(1500);
  }

  console.log("\n=== fill-log-setup summary ===");
  console.log(`fill_log: ${fillLog.toBase58()} (epoch ${epoch})`);
  console.log(`successful commits: ${ok}/${numCommits}`);
  if (ok > 10) {
    console.log(
      `RESULT: PASS — committed ${ok} times (> old cap of 10). A fresh delegated ` +
        `account has its own commit budget. The fill-log settlement design is viable.`
    );
  } else {
    console.log(
      `RESULT: INCONCLUSIVE/FAIL — only ${ok} commits succeeded. The per-account ` +
        `sponsored cap may also apply here; epoch rotation would be needed sooner.`
    );
  }
}

main().catch((err) => {
  console.error("fill-log-setup crashed:", err?.message ?? err);
  process.exit(1);
});
