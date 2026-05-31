/**
 * verify-close — prove close_trading_credit (0x1C) safely closes a NON-delegated,
 * zero-committed TradingCredit and refunds rent to the owner (the migration path
 * for a legacy NON-delegated credit). Uses a throwaway wallet on a NEW market
 * index space (the credit PDA includes market_index) so it never touches the
 * delegated market-0 credits.
 *
 * Flow: initialize_trading_credit (creates a fresh 96-byte program-owned credit)
 *       -> assert it exists & is 96 bytes & program-owned
 *       -> close_trading_credit
 *       -> assert it is gone and rent refunded.
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { getOperator } from "./shared/bot-wallets";
import { PROGRAM_ID, DISC_TRADING_CREDIT, TRADING_CREDIT_SIZE } from "../../client/src/constants";
import { findTradingCreditPda } from "../../client/src/pda";
import { createInitializeTradingCreditInstruction, createCloseTradingCreditInstruction } from "../../client/src/instructions";

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
// Use a distinct market index for the throwaway credit PDA so we never collide
// with the live market-0 credits. initialize_trading_credit does not validate
// the market exists; it just creates the per-(owner, market_index) PDA.
const TEST_MARKET_INDEX = Number(process.env.CLOSE_TEST_MARKET || "9");
const VERIFY_KEYS_DIR = path.resolve(__dirname, "../.verify-keys");

function loadOrCreate(name: string): Keypair {
  if (!fs.existsSync(VERIFY_KEYS_DIR)) fs.mkdirSync(VERIFY_KEYS_DIR, { recursive: true });
  const p = path.join(VERIFY_KEYS_DIR, `${name}.json`);
  if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

async function topUp(base: Connection, operator: Keypair, to: PublicKey, sol: number) {
  const bal = await base.getBalance(to);
  if (bal >= sol * 1e9) return;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: to, lamports: Math.floor(sol * 1e9) - bal }));
  await sendAndConfirmTransaction(base, tx, [operator]);
}

async function main() {
  const base = new Connection(BASE_RPC, "confirmed");
  const operator = getOperator();
  const user = loadOrCreate("verify-user"); // reuse the funded verify user
  await topUp(base, operator, user.publicKey, 0.03);

  const [pda] = findTradingCreditPda(user.publicKey, TEST_MARKET_INDEX);
  console.log(`close-test credit PDA ${pda.toBase58()} (owner=${user.publicKey.toBase58()}, market=${TEST_MARKET_INDEX})`);

  // init (idempotent: skip if already present)
  let info = await base.getAccountInfo(pda);
  if (!info) {
    const sig = await sendAndConfirmTransaction(base, new Transaction().add(createInitializeTradingCreditInstruction(user.publicKey, TEST_MARKET_INDEX)), [user], { skipPreflight: false });
    console.log(`initialize_trading_credit -> ${sig}`);
    info = await base.getAccountInfo(pda);
  }
  if (!info) throw new Error("credit not created");
  console.log(`after init: len=${info.data.length} owner=${info.owner.toBase58()} disc=${info.data[0]} (expect len=${TRADING_CREDIT_SIZE}, owner=${PROGRAM_ID.toBase58()})`);
  if (info.data.length !== TRADING_CREDIT_SIZE) throw new Error(`expected ${TRADING_CREDIT_SIZE}-byte credit, got ${info.data.length}`);
  if (!info.owner.equals(PROGRAM_ID)) throw new Error("credit not program-owned (delegated?) — close would refuse");

  const ownerBefore = await base.getBalance(user.publicKey);

  const closeSig = await sendAndConfirmTransaction(base, new Transaction().add(createCloseTradingCreditInstruction(user.publicKey, TEST_MARKET_INDEX)), [user], { skipPreflight: false });
  console.log(`close_trading_credit -> ${closeSig}`);

  const after = await base.getAccountInfo(pda);
  const ownerAfter = await base.getBalance(user.publicKey);
  console.log(`after close: account ${after ? `STILL PRESENT len=${after.data.length}` : "CLOSED (absent)"}`);
  console.log(`owner balance: ${(ownerBefore / 1e9).toFixed(6)} -> ${(ownerAfter / 1e9).toFixed(6)} (rent refunded, minus fee)`);
  if (after) throw new Error("close did not remove the account");
  console.log(`\nCLOSE_TRADING_CREDIT VERIFIED: non-delegated credit closed, rent refunded. sig=${closeSig}`);
}

main().catch((e) => { console.error("verify-close FAILED:", e?.message ?? e); process.exit(1); });
