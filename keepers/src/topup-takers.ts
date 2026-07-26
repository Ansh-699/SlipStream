import { Connection, Transaction, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import {
  getBaseConnection,
  getErConnection,
  sendAndConfirm,
  sleep,
  log,
} from "./shared/connection";
import { getKeeperAddresses, loadManifest, MANIFEST_PATH } from "./shared/manifest";
import { loadBotWallets, getOperator, readTradingCredit, fmtUsdc } from "./shared/bot-wallets";
import { sendErTx } from "./shared/ertx";
import {
  createDepositCollateralInstruction,
  createFundTradingCreditInstruction,
  createDelegateTradingCreditInstruction,
  createUndelegateTradingCreditInstruction,
} from "../../client/src/instructions";
import { findTradingCreditPda } from "../../client/src/pda";
import { MAGIC_CONTEXT_ID, PROGRAM_ID } from "../../client/src/constants";

/**
 * Top up bot trading credit so they can keep quoting / crossing the book (credit
 * drains into positions over time, then they go idle).
 *
 *   TOPUP_USDC=3000 npx tsx src/topup-takers.ts                # takers (default)
 *   TOPUP_ROLES=mm,taker TOPUP_USDC=5000 npx tsx src/topup-takers.ts
 *   TOPUP_ROLES=mm TOPUP_USDC=5000 npx tsx src/topup-takers.ts --dry-run
 *
 * IMPORTANT: `fund_trading_credit` requires the TradingCredit to be owned by THIS
 * program, i.e. NOT delegated (see fund_trading_credit.rs:40 -> CreditStillActive).
 * A live bot's credit is normally delegated to the ER, so a top-up has to
 * undelegate first and re-delegate afterwards. An earlier version of this script
 * claimed fund_trading_credit "works on already-delegated credits" — it does not,
 * and every top-up against a live bot failed with 0x12b.
 *
 * Undelegation is only safe when the credit has no active orders; we check
 * active_orders/committed before touching anything and skip the bot otherwise.
 */

/** Poll L1 until the credit account is owned by the program again. */
async function waitForUndelegation(
  base: Connection,
  creditPda: PublicKey,
  tries = 30
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const info = await base.getAccountInfo(creditPda, "confirmed");
    if (info && info.owner.equals(PROGRAM_ID)) return true;
    await sleep(2_000);
  }
  return false;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const base = getBaseConnection();
  const er = getErConnection();
  const operator = getOperator();
  const { marketIndex, usdcVault } = getKeeperAddresses();
  const topup = BigInt(Math.round(Number(process.env.TOPUP_USDC || "3000") * 1e6));

  const roles = (process.env.TOPUP_ROLES || "taker")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  const manifest = loadManifest();
  if (!manifest.usdcMint) throw new Error(`usdcMint missing from ${MANIFEST_PATH}`);
  const mint = new PublicKey(manifest.usdcMint);

  const selected = loadBotWallets().filter((w) => roles.includes(w.role));
  if (selected.length === 0) {
    throw new Error(`no bot wallets match TOPUP_ROLES="${roles.join(",")}"`);
  }
  log("topup", `${selected.length} bot(s) [${roles.join(",")}] x ${fmtUsdc(topup)}${dryRun ? " (dry-run)" : ""}`);

  for (const w of selected) {
    const owner = w.keypair.publicKey;
    const [creditPda] = findTradingCreditPda(owner, marketIndex);
    log("topup", `--- ${w.name} ${owner.toBase58()} ---`);

    const before = await readTradingCredit(base, er, owner, marketIndex);
    const info = await base.getAccountInfo(creditPda, "confirmed");
    const delegated = !!info && !info.owner.equals(PROGRAM_ID);

    if (before && (before.activeOrders > 0 || before.committed > 0n)) {
      log(
        "topup",
        `${w.name} SKIP: active=${before.activeOrders} committed=${fmtUsdc(before.committed)} — undelegation would orphan ER slots`
      );
      continue;
    }
    log("topup", `${w.name} credit=${fmtUsdc(before?.credit ?? 0n)} delegated=${delegated}`);
    if (dryRun) continue;

    // 1. Mint + deposit collateral (L1; independent of delegation state).
    const ata = await getOrCreateAssociatedTokenAccount(base, operator, mint, owner);
    await mintTo(base, operator, mint, ata.address, operator.publicKey, topup);
    await sendAndConfirm(
      base,
      new Transaction().add(createDepositCollateralInstruction(owner, ata.address, usdcVault, topup)),
      [w.keypair]
    );
    log("topup", `${w.name} deposited ${fmtUsdc(topup)}`);

    // 2. Undelegate so fund_trading_credit can write the L1 account.
    if (delegated) {
      const sig = await sendErTx(
        er,
        createUndelegateTradingCreditInstruction(owner, marketIndex, MAGIC_CONTEXT_ID),
        w.keypair
      );
      log("topup", `${w.name} undelegate (ER) ${sig.slice(0, 16)}…`);
      if (!(await waitForUndelegation(base, creditPda))) {
        log("topup", `${w.name} ERROR: credit still delegated after 60s — leaving funds in free_collateral`);
        continue;
      }
    }

    // 3. Fund, then hand the credit back to the ER.
    await sendAndConfirm(
      base,
      new Transaction().add(createFundTradingCreditInstruction(owner, marketIndex, topup)),
      [w.keypair]
    );
    await sendAndConfirm(
      base,
      new Transaction().add(createDelegateTradingCreditInstruction(owner, marketIndex)),
      [w.keypair]
    );

    const after = await readTradingCredit(base, er, owner, marketIndex);
    log(
      "topup",
      `${w.name} credit now total=${fmtUsdc(after?.credit ?? 0n)} avail=${fmtUsdc(after?.available ?? 0n)}`
    );
  }
  log("topup", "done");
}

main().catch((e) => {
  console.error("topup failed:", e?.message ?? e);
  process.exit(1);
});
