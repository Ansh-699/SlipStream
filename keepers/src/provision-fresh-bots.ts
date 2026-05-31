/**
 * provision-fresh-bots — migrate the market-maker bots onto FRESH wallets with
 * clean 96-byte TradingCredit accounts after the session-keys upgrade.
 *
 * The old mm and taker credits are legacy 56-byte DELEGATED accounts. They
 * cannot be migrated in place (close refuses a delegated account; undelegate is
 * a confirmed dead-end), so per the brief we ABANDON them and provision fresh
 * keypairs (new names, e.g. mm-v2-0) that get clean 96-byte credits via the
 * normal init→deposit→fund→delegate path. This keeps the live book quoting.
 *
 * Bots sign with their OWN local keypair, so they do not need a session key to
 * be popup-less; we authorize one anyway (the bot key authorizes itself as the
 * session) so the 96-byte session fields are exercised end-to-end.
 *
 *   FRESH_MM_COUNT=2 npx tsx src/provision-fresh-bots.ts
 *
 * Reports operator SOL before/after.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

import { getBaseConnection, getErConnection } from "./shared/connection";
import { getOperator, setupBotWallet, type BotWallet } from "./shared/bot-wallets";
import { findTradingCreditPda } from "../../client/src/pda";
import { decodeTradingCredit } from "../../client/src/accounts";
import { TRADING_CREDIT_SIZE } from "../../client/src/constants";

const FRESH_MM_COUNT = Math.max(1, parseInt(process.env.FRESH_MM_COUNT || "2", 10));
const FRESH_PREFIX = process.env.FRESH_PREFIX || "mm-v2";
const MARKET_INDEX = Number(process.env.MARKET_INDEX || "0");
const BOT_KEYS_DIR = path.resolve(__dirname, "../.bot-keys");

function loadOrCreate(name: string): Keypair {
  if (!fs.existsSync(BOT_KEYS_DIR)) fs.mkdirSync(BOT_KEYS_DIR, { recursive: true });
  const p = path.join(BOT_KEYS_DIR, `${name}.json`);
  if (fs.existsSync(p)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`created fresh bot key ${name} -> ${kp.publicKey.toBase58()}`);
  return kp;
}

async function main() {
  const base = getBaseConnection();
  const er = getErConnection();
  const operator = getOperator();

  const opBefore = (await base.getBalance(operator.publicKey)) / 1e9;
  console.log(`operator ${operator.publicKey.toBase58()} SOL before: ${opBefore.toFixed(6)}`);
  console.log(`provisioning ${FRESH_MM_COUNT} fresh MM wallet(s) (prefix ${FRESH_PREFIX}), 96-byte credits\n`);

  const wallets: BotWallet[] = [];
  for (let i = 0; i < FRESH_MM_COUNT; i++) {
    const name = `${FRESH_PREFIX}-${i}`;
    wallets.push({ name, role: "mm", keypair: loadOrCreate(name) });
  }

  for (const w of wallets) {
    const state = await setupBotWallet(base, er, operator, w);
    const [pda] = findTradingCreditPda(w.keypair.publicKey, MARKET_INDEX);
    const erInfo = await er.getAccountInfo(pda);
    let len = erInfo?.data.length ?? 0;
    let creditOk = len === TRADING_CREDIT_SIZE;
    console.log(
      `  ${w.name} READY sol=${state.solBalance.toFixed(4)} credit=${state.creditTotal} ` +
        `avail=${state.creditAvailable} delegated=${state.creditDelegated} ER-len=${len} 96B=${creditOk}`
    );
  }

  const opAfter = (await base.getBalance(operator.publicKey)) / 1e9;
  console.log(`\noperator SOL: ${opBefore.toFixed(6)} -> ${opAfter.toFixed(6)} (spent ${(opBefore - opAfter).toFixed(6)})`);
  console.log("\nFresh MM wallets provisioned with 96-byte credits.");
  console.log("Start them by pointing the market-maker bot at these keys (orchestrator manages the bot processes).");
}

main().catch((e) => {
  console.error("provision-fresh-bots FAILED:", e?.message ?? e);
  process.exit(1);
});
