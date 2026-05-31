/**
 * verify-session — LIVE end-to-end proof of the session-keys upgrade.
 *
 * Walks the full user flow against the LIVE devnet program + MagicBlock ER on a
 * FRESH wallet (the real user's market-0 credit is a legacy 56-byte DELEGATED
 * account that can't be migrated in place — close refuses delegated, undelegate
 * is a dead-end — so a fresh wallet is the closest working variant):
 *
 *   initialize_user → deposit_collateral → initialize_trading_credit →
 *   fund_trading_credit → delegate_trading_credit(+authorize SESSION, 1 sig)
 *
 * Then it PROVES session signing on the ER:
 *   1. place_order signed by the SESSION key (NOT the wallet)        → must succeed
 *   2. place_order signed by the WALLET (owner)                      → must succeed
 *
 * It also empirically answers the ER fee-payer question: it first tries the
 * session-signed order with the session key holding ZERO SOL; if that fails for
 * fees it funds the key with a little SOL and retries, reporting which path won.
 *
 * Conserves SOL: tiny top-ups only, reports operator balance before/after.
 *
 *   npx tsx src/verify-session.ts
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

import { getOperator } from "./shared/bot-wallets";
import {
  PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  DISC_TRADING_CREDIT,
  TRADING_CREDIT_SIZE,
} from "../../client/src/constants";
import { findTradingCreditPda } from "../../client/src/pda";
import { decodeTradingCredit } from "../../client/src/accounts";
import {
  createInitializeUserInstruction,
  createDepositCollateralInstruction,
  createInitializeTradingCreditInstruction,
  createFundTradingCreditInstruction,
  createDelegateTradingCreditInstruction,
  createPlaceOrderInstruction,
} from "../../client/src/instructions";

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const MARKET_INDEX = Number(process.env.MARKET_INDEX || "0");

const VERIFY_KEYS_DIR = path.resolve(__dirname, "../.verify-keys");

// SOL-PERP market params (deploy.json).
const TICK_SIZE = 1_000n;
const LOT_SIZE = 100_000_000n;

function loadUsdcMint(): PublicKey {
  const manifestPath = path.resolve(__dirname, "../../../deploy.json");
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  return new PublicKey(m.usdcMint);
}
function loadUsdcVault(): PublicKey {
  const manifestPath = path.resolve(__dirname, "../../../deploy.json");
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  return new PublicKey(m.usdcVault);
}

function loadOrCreate(name: string): Keypair {
  if (!fs.existsSync(VERIFY_KEYS_DIR)) fs.mkdirSync(VERIFY_KEYS_DIR, { recursive: true });
  const p = path.join(VERIFY_KEYS_DIR, `${name}.json`);
  if (fs.existsSync(p)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

async function topUp(base: Connection, operator: Keypair, to: PublicKey, sol: number) {
  const target = Math.floor(sol * 1e9);
  const bal = await base.getBalance(to);
  if (bal >= target) return;
  const shortfall = target - bal;
  try {
    const sig = await base.requestAirdrop(to, shortfall);
    await base.confirmTransaction(sig, "confirmed");
    console.log(`  topUp ${to.toBase58().slice(0, 8)}… +${(shortfall / 1e9).toFixed(4)} SOL (faucet)`);
    return;
  } catch {
    /* faucet rate-limited */
  }
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: to, lamports: shortfall })
  );
  const sig = await sendAndConfirmTransaction(base, tx, [operator]);
  console.log(`  topUp ${to.toBase58().slice(0, 8)}… +${(shortfall / 1e9).toFixed(4)} SOL (operator ${sig.slice(0, 8)}…)`);
}

async function sendBase(base: Connection, ixs: any[], signers: Keypair[], label: string): Promise<string> {
  const tx = new Transaction().add(...ixs);
  try {
    const sig = await sendAndConfirmTransaction(base, tx, signers, { commitment: "confirmed", skipPreflight: false });
    console.log(`  [${label}] ${sig}`);
    return sig;
  } catch (e: any) {
    const logs = Array.isArray(e?.logs) ? e.logs.join("\n") : "";
    throw new Error(`[${label}] failed: ${e?.message ?? e}\n${logs}`);
  }
}

/** Send an ER tx signed LOCALLY by `signer` as both fee payer and tx signer. */
async function sendErSigned(
  er: Connection,
  ix: any,
  signer: Keypair,
  label: string
): Promise<{ ok: boolean; sig: string | null; err: string | null }> {
  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await er.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  try {
    const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const conf = await er.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) {
      let logs = "";
      try {
        const t = await er.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        logs = (t?.meta?.logMessages ?? []).join("\n");
      } catch {}
      return { ok: false, sig, err: `${JSON.stringify(conf.value.err)}\n${logs}` };
    }
    console.log(`  [${label}] ER sig ${sig}`);
    return { ok: true, sig, err: null };
  } catch (e: any) {
    const logs = Array.isArray(e?.logs) ? e.logs.join("\n") : "";
    return { ok: false, sig: null, err: `${e?.message ?? e}\n${logs}` };
  }
}

async function main() {
  const base = new Connection(BASE_RPC, "confirmed");
  const er = new Connection(ER_RPC, "confirmed");
  const operator = getOperator();
  const mint = loadUsdcMint();
  const vault = loadUsdcVault();

  const opBefore = (await base.getBalance(operator.publicKey)) / 1e9;
  console.log(`operator ${operator.publicKey.toBase58()} SOL before: ${opBefore.toFixed(6)}`);
  console.log(`TRADING_CREDIT_SIZE = ${TRADING_CREDIT_SIZE}\n`);

  const user = loadOrCreate("verify-user");
  const session = loadOrCreate("verify-session");
  console.log(`verify user:    ${user.publicKey.toBase58()}`);
  console.log(`session key:    ${session.publicKey.toBase58()}\n`);

  // 1. Fund the user (SOL for rents/fees) + mint test USDC.
  await topUp(base, operator, user.publicKey, 0.08);
  const userAta = await getOrCreateAssociatedTokenAccount(base, operator, mint, user.publicKey);
  await mintTo(base, operator, mint, userAta.address, operator.publicKey, 3_000_000_000n); // $3000
  console.log(`minted $3000 USDC to user ATA ${userAta.address.toBase58().slice(0, 8)}…\n`);

  const [creditPda] = findTradingCreditPda(user.publicKey, MARKET_INDEX);

  // 2. initialize_user + deposit + init credit + fund credit (base).
  console.log("=== base-layer setup ===");
  await sendBase(base, [createInitializeUserInstruction(user.publicKey)], [user], "initialize_user");
  await sendBase(base, [createDepositCollateralInstruction(user.publicKey, userAta.address, vault, 2_000_000_000n)], [user], "deposit_collateral $2000");
  await sendBase(base, [createInitializeTradingCreditInstruction(user.publicKey, MARKET_INDEX)], [user], "initialize_trading_credit");
  await sendBase(base, [createFundTradingCreditInstruction(user.publicKey, MARKET_INDEX, 1_000_000_000n)], [user], "fund_trading_credit $1000");

  // 3. delegate + authorize SESSION in ONE signature (this is the ONE wallet sig).
  const sessionExpiry = BigInt(Math.floor(Date.now() / 1000) + 24 * 3600);
  console.log("\n=== delegate + authorize session (ONE signature) ===");
  await sendBase(
    base,
    [createDelegateTradingCreditInstruction(user.publicKey, MARKET_INDEX, session.publicKey, sessionExpiry)],
    [user],
    "delegate_trading_credit(+session)"
  );

  // 4. Verify the delegated credit on the ER carries the session fields, 96 bytes.
  console.log("\n=== verify ER credit state ===");
  const baseInfo = await base.getAccountInfo(creditPda);
  console.log(`credit ${creditPda.toBase58()} base-owner=${baseInfo?.owner.toBase58()} (delegated=${baseInfo?.owner.equals(DELEGATION_PROGRAM_ID)})`);
  const erInfo = await er.getAccountInfo(creditPda);
  if (!erInfo || erInfo.data[0] !== DISC_TRADING_CREDIT) throw new Error("ER credit not found / wrong disc");
  const tc = decodeTradingCredit(erInfo.data as Buffer);
  console.log(`  ER len=${erInfo.data.length} credit=${tc.credit} committed=${tc.committed} available=${tc.available}`);
  console.log(`  session_authority=${tc.sessionAuthority.toBase58()} expiry=${tc.sessionExpiry}`);
  const sessionMatches = tc.sessionAuthority.equals(session.publicKey);
  console.log(`  session matches our key: ${sessionMatches}`);
  if (!sessionMatches) throw new Error("session authority not set on delegated credit");

  // 5. SESSION-SIGNED place_order on the ER. First with the session key at ZERO
  //    SOL to learn whether the ER requires the fee payer to hold lamports.
  console.log("\n=== fee-payer probe: session-signed order with session key at 0 SOL ===");
  const sessSolBefore = (await base.getBalance(session.publicKey)) / 1e9;
  console.log(`  session key base SOL: ${sessSolBefore.toFixed(6)}`);
  // Resting bid far below market so it does not cross: $1.00, 0.1 SOL (one lot).
  const bidPrice = 1_000_000n; // $1.000000, multiple of tick 1000
  const oneLot = LOT_SIZE; // 0.1 SOL
  const mkOrder = (signer: PublicKey, priceOffset: bigint) =>
    createPlaceOrderInstruction(
      user.publicKey,
      MARKET_INDEX,
      { side: 0, orderType: 0, price: bidPrice + priceOffset, size: oneLot, expiryTs: 0n, maxSlippageBps: 0 },
      PROGRAM_ID,
      signer
    );

  let feePayerNeedsSol = false;
  let sessionOrderSig: string | null = null;
  const probe = await sendErSigned(er, mkOrder(session.publicKey, 0n), session, "session-order(0 SOL)");
  if (probe.ok) {
    sessionOrderSig = probe.sig;
    console.log("  => ER SPONSORS fees (session key needed no SOL).");
  } else {
    const feeRelated = /insufficient|fund|fee|0x1|lamport|rent|debit an account/i.test(probe.err ?? "");
    console.log(`  session-order(0 SOL) failed: ${(probe.err ?? "").split("\n")[0]}`);
    if (feeRelated) {
      feePayerNeedsSol = true;
      console.log("  => looks fee-related; funding session key 0.02 SOL and retrying…");
      await topUp(base, operator, session.publicKey, 0.02);
      // give the ER a moment to observe the new base balance
      await new Promise((r) => setTimeout(r, 4000));
      const retry = await sendErSigned(er, mkOrder(session.publicKey, TICK_SIZE), session, "session-order(funded)");
      if (!retry.ok) throw new Error(`session-signed order still failed after funding:\n${retry.err}`);
      sessionOrderSig = retry.sig;
    } else {
      throw new Error(`session-signed order failed (not fee-related):\n${probe.err}`);
    }
  }
  console.log(`  SESSION-SIGNED ORDER SUCCEEDED: ${sessionOrderSig}`);

  // 6. WALLET-SIGNED place_order on the ER (owner is always authorized).
  console.log("\n=== wallet-signed order (owner) ===");
  // Ensure the owner can pay ER fees too if required.
  if (feePayerNeedsSol) {
    await topUp(base, operator, user.publicKey, 0.05);
    await new Promise((r) => setTimeout(r, 3000));
  }
  const walletRes = await sendErSigned(er, mkOrder(user.publicKey, 2n * TICK_SIZE), user, "wallet-order");
  if (!walletRes.ok) throw new Error(`wallet-signed order failed:\n${walletRes.err}`);
  console.log(`  WALLET-SIGNED ORDER SUCCEEDED: ${walletRes.sig}`);

  // 7. Read back the credit (committed should now reflect the resting orders).
  const erInfo2 = await er.getAccountInfo(creditPda);
  const tc2 = decodeTradingCredit(erInfo2!.data as Buffer);
  console.log(`\n=== post-order ER credit ===`);
  console.log(`  credit=${tc2.credit} committed=${tc2.committed} active_orders=${tc2.activeOrders}`);

  const opAfter = (await base.getBalance(operator.publicKey)) / 1e9;
  console.log(`\n================ SUMMARY ================`);
  console.log(`session_authority on credit: ${tc.sessionAuthority.toBase58()}`);
  console.log(`session expiry:              ${tc.sessionExpiry}`);
  console.log(`ER fee payer needs SOL:      ${feePayerNeedsSol}`);
  console.log(`SESSION-signed order sig:    ${sessionOrderSig}`);
  console.log(`WALLET-signed order sig:     ${walletRes.sig}`);
  console.log(`operator SOL: ${opBefore.toFixed(6)} -> ${opAfter.toFixed(6)} (spent ${(opBefore - opAfter).toFixed(6)})`);
}

main().catch((e) => {
  console.error("verify-session FAILED:", e?.message ?? e);
  process.exit(1);
});
