import { Connection, Transaction } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { getBaseConnection, getErConnection, sendAndConfirm, log } from "./shared/connection";
import { getKeeperAddresses, loadManifest, MANIFEST_PATH } from "./shared/manifest";
import { loadBotWallets, getOperator, readTradingCredit, fmtUsdc } from "./shared/bot-wallets";
import {
  createDepositCollateralInstruction,
  createFundTradingCreditInstruction,
} from "../../client/src/instructions";
import { findUserAccountPda } from "../../client/src/pda";
import { PublicKey } from "@solana/web3.js";

/**
 * Top up bot trading credit so they can keep quoting / crossing the book (credit
 * drains into positions over time, then they go idle). Deposits more collateral +
 * funds credit. Works on already-delegated credits (fund_trading_credit runs on the
 * base layer and propagates to the ER copy).
 *
 *   TOPUP_USDC=3000 npx tsx src/topup-takers.ts               # takers (default)
 *   TOPUP_ROLES=mm,taker TOPUP_USDC=5000 npx tsx src/topup-takers.ts
 *
 * Market makers need materially more than takers: BOT_MM_LEVELS orders per side at
 * BOT_MM_SIZE_LOTS each, all reserving margin simultaneously.
 */
async function main() {
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
  log("topup", `topping up ${selected.length} bot(s) [${roles.join(",")}] with ${fmtUsdc(topup)} each`);

  for (const w of selected) {
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
