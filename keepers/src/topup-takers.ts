import { Connection, Transaction } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { getBaseConnection, getErConnection, sendAndConfirm, log } from "./shared/connection";
import { getKeeperAddresses } from "./shared/manifest";
import { loadBotWallets, getOperator, readTradingCredit, fmtUsdc } from "./shared/bot-wallets";
import {
  createDepositCollateralInstruction,
  createFundTradingCreditInstruction,
} from "../../client/src/instructions";
import { findUserAccountPda } from "../../client/src/pda";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

/**
 * Top up the taker bots' trading credit so they can keep crossing the book
 * (their credit drains to positions over time, then they go idle). Deposits more
 * collateral + funds credit. Works on already-delegated credits (fund_trading_
 * credit runs on the base layer and propagates to the ER copy).
 *
 *   TOPUP_USDC=3000 npx tsx src/topup-takers.ts
 */
async function main() {
  const base = getBaseConnection();
  const er = getErConnection();
  const operator = getOperator();
  const { marketIndex, usdcVault } = getKeeperAddresses();
  const topup = BigInt(Math.round(Number(process.env.TOPUP_USDC || "3000") * 1e6));

  const manifestPath = path.resolve(__dirname, "../../../deploy.json");
  const mint = new PublicKey(JSON.parse(fs.readFileSync(manifestPath, "utf-8")).usdcMint);

  const takers = loadBotWallets().filter((w) => w.role === "taker");
  for (const w of takers) {
    const owner = w.keypair.publicKey;
    log("topup", `--- ${w.name} ${owner.toBase58()} ---`);

    // Mint USDC to the taker's ATA + deposit as collateral, then fund credit.
    const ata = await getOrCreateAssociatedTokenAccount(base, operator, mint, owner);
    await mintTo(base, operator, mint, ata.address, operator.publicKey, topup);
    log("topup", `${w.name} minted ${fmtUsdc(topup)}`);

    const depIx = createDepositCollateralInstruction(owner, ata.address, usdcVault, topup);
    await sendAndConfirm(base, new Transaction().add(depIx), [w.keypair]);

    const fundIx = createFundTradingCreditInstruction(owner, marketIndex, topup);
    await sendAndConfirm(base, new Transaction().add(fundIx), [w.keypair]);

    const credit = await readTradingCredit(base, er, owner, marketIndex);
    log("topup", `${w.name} credit now total=${fmtUsdc(credit?.credit ?? 0n)} avail=${fmtUsdc(credit?.available ?? 0n)}`);
  }
  log("topup", "done");
}

main().catch((e) => {
  console.error("topup-takers failed:", e?.message ?? e);
  process.exit(1);
});
