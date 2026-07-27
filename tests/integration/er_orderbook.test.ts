#!/usr/bin/env tsx
/**
 * ER OrderBook integration test (Requirements 8.2, 8.5).
 *
 * Exercises OrderBook operations on the MagicBlock Ephemeral Rollup against the
 * live deploy described by the repo-root deploy.json, using the client SDK
 * builders end-to-end:
 *
 *   per trader (one maker):
 *     initialize_user -> mint USDC + deposit_collateral
 *       -> initialize_trading_credit -> fund_trading_credit -> delegate_trading_credit
 *       -> initialize_position(owner, marketIndex)
 *   PLACE a resting LIMIT order on the ER     -> OrderBook header counts increase
 *   CANCEL that order on the ER               -> OrderBook header counts decrease
 *   COMMIT the OrderBook state back to L1      -> base-layer copy reflects the change
 *
 * This proves the Req 8.2 statement: "place and cancel orders on the ER and
 * confirm orderbook state commits back to the base layer".
 *
 * HONESTY (Req 8.5): every ER send awaits confirmation and branches on the
 * transaction error; every assertion reports the failing step with detail. The
 * order id used for cancel is read back from the ER OrderBook (not assumed), and
 * the commit-to-L1 assertion compares the actual L1 header before/after.
 *
 * Run (authoritative live run is spec task 9.1):
 *   BASE_RPC=https://api.devnet.solana.com \
 *   ER_RPC=https://devnet.magicblock.app \
 *   AUTHORITY_KEYPAIR=~/.config/solana/id.json \
 *   npx tsx er_orderbook.test.ts
 *
 * NOTE: the authority keypair loaded here MUST be the deploy authority — it is
 * the mint authority for the live USDC mint and mints the test collateral.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

import {
  loadKeypair,
  getBaseConnection,
  getErConnection,
  ensureMinBalance,
  loadOrCreateTestKeypair,
  sleep,
  isDelegated,
  log,
  DELEGATION_PROGRAM_ID,
} from "./setup";

import {
  createInitializeUserInstruction,
  createDepositCollateralInstruction,
  createInitializeTradingCreditInstruction,
  createFundTradingCreditInstruction,
  createDelegateTradingCreditInstruction,
  createInitializePositionInstruction,
  createPlaceOrderInstruction,
  createCancelOrderInstruction,
  createCommitOrderbookInstruction,
  findUserAccountPda,
  findPositionPda,
  findOrderBookPda,
  findTradingCreditPda,
  decodeOrderBook,
  decodeOrderBookHeader,
  type OrderBookHeader,
  SIDE_BID,
  ORDER_TYPE_LIMIT,
} from "../../client/src";

// --------------------------------------------------------------------------
// Config — small sizes/prices keep credit + SOL tiny (conserve funds).
// --------------------------------------------------------------------------
const MARKET_INDEX = 0;
const REST_PRICE = 1_000_000n; // $1.00 — far below mark so the bid rests (no cross)
const ORDER_SIZE = 100_000_000n; // 0.1 base atoms == exactly one lot
const DEPOSIT_USDC = 100_000_000n; // $100
const FUND_USDC = 50_000_000n; //  $50 credit
const MINT_USDC = 200_000_000n; // $200 minted to the ATA
const TRADER_SOL = 0.05;

// --------------------------------------------------------------------------
// Manifest
// --------------------------------------------------------------------------
interface Manifest {
  programId: string;
  market: string;
  orderBook: string;
  usdcMint: string;
  usdcVault: string;
  pythFeed: string;
  switchboardFeed: string;
  marketIndex: number;
}

function loadManifest(): Manifest {
  const candidates = [
    process.env.DEPLOY_MANIFEST,
    path.resolve(__dirname, "../../deploy.json"),
    path.resolve(process.cwd(), "deploy.json"),
  ].filter((p): p is string => typeof p === "string");
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const m = JSON.parse(fs.readFileSync(p, "utf-8")) as Manifest;
        log(`Loaded deploy manifest from ${p}`);
        return m;
      }
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `deploy.json not found. Looked in: ${candidates.join(", ")}. ` +
      `Set DEPLOY_MANIFEST=/abs/path/deploy.json or run scripts/deploy.ts first.`
  );
}

// --------------------------------------------------------------------------
// Assertion harness
// --------------------------------------------------------------------------
let checks = 0;
let failures = 0;
function check(cond: boolean, msg: string): boolean {
  checks++;
  if (cond) log(`  ✓ ${msg}`);
  else {
    failures++;
    log(`  ✗ FAIL: ${msg}`);
  }
  return cond;
}

// --------------------------------------------------------------------------
// Senders (Req 8.5: surface errors with detail)
// --------------------------------------------------------------------------
async function sendL1(
  conn: Connection,
  step: string,
  ixs: TransactionInstruction[],
  signers: Keypair[]
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  try {
    return await sendAndConfirmTransaction(conn, tx, signers, {
      commitment: "confirmed",
      skipPreflight: false,
    });
  } catch (e: any) {
    const logs = Array.isArray(e?.logs) ? e.logs.join("\n") : "";
    throw new Error(`[${step}] L1 tx failed: ${e?.message ?? e}\n${logs}`);
  }
}

async function sendEr(
  er: Connection,
  step: string,
  ix: TransactionInstruction,
  payer: Keypair
): Promise<string> {
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await er.confirmTransaction(sig, "confirmed");
  if (conf.value.err) {
    let logs = "";
    try {
      const t = await er.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      logs = (t?.meta?.logMessages ?? []).join("\n");
    } catch {
      /* ignore */
    }
    throw new Error(`[${step}] ER tx ${sig} failed: ${JSON.stringify(conf.value.err)}\n${logs}`);
  }
  return sig;
}

// --------------------------------------------------------------------------
// Read the ER OrderBook header.
// --------------------------------------------------------------------------
async function readErHeader(er: Connection, ob: PublicKey): Promise<OrderBookHeader | null> {
  const info = await er.getAccountInfo(ob);
  if (!info) return null;
  return decodeOrderBookHeader(info.data);
}

// --------------------------------------------------------------------------
// Per-trader L1 setup
// --------------------------------------------------------------------------
async function setupTrader(
  base: Connection,
  authority: Keypair,
  mint: PublicKey,
  vault: PublicKey,
  trader: Keypair,
  label: string
): Promise<void> {
  log(`\n--- setup ${label} ${trader.publicKey.toBase58()} ---`);
  await ensureMinBalance(base, trader.publicKey, TRADER_SOL);

  // Idempotent across reused persistent keys (see full_flow.test.ts).
  const [userPda] = findUserAccountPda(trader.publicKey);
  const [creditPda] = findTradingCreditPda(trader.publicKey, MARKET_INDEX);

  const userInfo = await base.getAccountInfo(userPda);
  if (!(userInfo && userInfo.data.length > 0)) {
    await sendL1(base, `${label}:init_user`, [createInitializeUserInstruction(trader.publicKey)], [trader]);
  }
  const ata = await getOrCreateAssociatedTokenAccount(base, authority, mint, trader.publicKey);
  await mintTo(base, authority, mint, ata.address, authority.publicKey, MINT_USDC);
  await sendL1(
    base,
    `${label}:deposit_collateral`,
    [createDepositCollateralInstruction(trader.publicKey, ata.address, vault, DEPOSIT_USDC)],
    [trader]
  );

  const creditInfo = await base.getAccountInfo(creditPda);
  const creditDelegated = creditInfo?.owner.equals(DELEGATION_PROGRAM_ID) ?? false;
  if (creditDelegated) {
    log(`  trading_credit already delegated to ER (reused key) — skipping init/fund/delegate`);
  } else {
    if (!(creditInfo && creditInfo.data.length > 0)) {
      await sendL1(
        base,
        `${label}:init_trading_credit`,
        [createInitializeTradingCreditInstruction(trader.publicKey, MARKET_INDEX)],
        [trader]
      );
    }
    await sendL1(
      base,
      `${label}:fund_trading_credit`,
      [createFundTradingCreditInstruction(trader.publicKey, MARKET_INDEX, FUND_USDC)],
      [trader]
    );
    await sendL1(
      base,
      `${label}:delegate_trading_credit`,
      [createDelegateTradingCreditInstruction(trader.publicKey, MARKET_INDEX)],
      [trader]
    );
  }

  // initialize_position so the trader's settlement story is complete (and to match
  // the full-flow setup); harmless for a pure place/cancel run.
  const [positionPda] = findPositionPda(trader.publicKey, MARKET_INDEX);
  const posInfo = await base.getAccountInfo(positionPda);
  if (!(posInfo && posInfo.data.length > 0)) {
    await sendL1(
      base,
      `${label}:initialize_position`,
      [createInitializePositionInstruction(trader.publicKey, MARKET_INDEX)],
      [trader]
    );
  }
  log(`  ${label} ready (user + collateral + funded/delegated credit + position)`);
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
async function main() {
  console.log("\n=== Slipstream ER OrderBook Integration Test (Req 8.2, 8.5) ===\n");

  const manifest = loadManifest();
  const base = getBaseConnection();
  const er = getErConnection();
  const authority = loadKeypair(process.env.AUTHORITY_KEYPAIR);

  const mint = new PublicKey(manifest.usdcMint);
  const vault = new PublicKey(manifest.usdcVault);
  const [orderBookPda] = findOrderBookPda(MARKET_INDEX);

  log(`Authority/operator: ${authority.publicKey.toBase58()}`);
  log(`Program:   ${manifest.programId}`);
  log(`OrderBook: ${orderBookPda.toBase58()}`);

  // OrderBook must already be delegated from the bootstrap — do NOT re-delegate.
  const delegated = await isDelegated(base, orderBookPda);
  if (!check(delegated, "OrderBook is delegated to the ER (from bootstrap)")) {
    throw new Error(
      "[setup] OrderBook is not delegated. Re-run scripts/deploy.ts to delegate it; " +
        "this test intentionally does not delegate the shared orderbook."
    );
  }

  // One maker reused for the whole place/cancel cycle (conserve SOL); persistent.
  const maker = loadOrCreateTestKeypair("er_maker");
  await setupTrader(base, authority, mint, vault, maker, "maker");

  await sleep(2_000); // credit-delegation propagation

  // ---- Baseline ER header ----
  console.log("\n--- ER OrderBook baseline ---");
  const before = await readErHeader(er, orderBookPda);
  if (!check(before !== null, "ER OrderBook account is visible")) {
    throw new Error("[er_read] ER OrderBook not visible on the ER endpoint");
  }
  const h0 = before as OrderBookHeader;
  log(`  baseline: active=${h0.activeOrderCount} bidLvls=${h0.bidLevelCount} freeSlots=${h0.freeSlotCount} nextOrderId=${h0.nextOrderId}`);

  // ---- PLACE a resting LIMIT bid far below mark (won't cross) ----
  console.log("\n--- PLACE resting LIMIT bid on the ER ---");
  const placeIx = createPlaceOrderInstruction(maker.publicKey, MARKET_INDEX, {
    side: SIDE_BID,
    orderType: ORDER_TYPE_LIMIT,
    price: REST_PRICE,
    size: ORDER_SIZE,
  });
  const sigPlace = await sendEr(er, "place_order", placeIx, maker);
  log(`  place_order on ER: ${sigPlace}`);

  // Find the resting order's id from the ER book (don't assume it).
  let placedOrderId: bigint | null = null;
  let afterPlace: OrderBookHeader | null = null;
  for (let i = 0; i < 10 && placedOrderId === null; i++) {
    await sleep(1_000);
    const info = await er.getAccountInfo(orderBookPda);
    if (!info) continue;
    const ob = decodeOrderBook(info.data);
    afterPlace = ob.header;
    const mine = ob.orderSlots.find(
      (s) => s.active && new PublicKey(s.owner).equals(maker.publicKey)
    );
    if (mine) placedOrderId = mine.orderId;
    log(`  ER after place: active=${ob.header.activeOrderCount} bidLvls=${ob.header.bidLevelCount} nextOrderId=${ob.header.nextOrderId}`);
  }

  const hP = afterPlace as OrderBookHeader;
  check(
    hP !== null && hP.activeOrderCount > h0.activeOrderCount,
    `place increased active order count (${h0.activeOrderCount} -> ${hP?.activeOrderCount})`
  );
  check(placedOrderId !== null, `resting order id located on the ER (id=${placedOrderId})`);
  if (placedOrderId === null) {
    throw new Error("[place_order] could not locate the resting order on the ER after placing");
  }

  // ---- CANCEL the resting order on the ER ----
  console.log("\n--- CANCEL the resting order on the ER ---");
  const cancelIx = createCancelOrderInstruction(maker.publicKey, MARKET_INDEX, placedOrderId);
  const sigCancel = await sendEr(er, "cancel_order", cancelIx, maker);
  log(`  cancel_order on ER: ${sigCancel}`);

  let afterCancel: OrderBookHeader | null = null;
  for (let i = 0; i < 10; i++) {
    await sleep(1_000);
    const h = await readErHeader(er, orderBookPda);
    if (h) {
      afterCancel = h;
      log(`  ER after cancel: active=${h.activeOrderCount} bidLvls=${h.bidLevelCount} nextOrderId=${h.nextOrderId}`);
      if (h.activeOrderCount < hP.activeOrderCount) break;
    }
  }
  const hC = afterCancel as OrderBookHeader;
  check(
    hC !== null && hC.activeOrderCount < hP.activeOrderCount,
    `cancel decreased active order count (${hP.activeOrderCount} -> ${hC?.activeOrderCount})`
  );

  // ---- COMMIT the OrderBook state back to L1 ----
  // nextOrderId is a monotonic header field bumped by place_order; it is the most
  // robust signal that the ER mutations committed back to the base layer (active
  // count returns to baseline after the cancel).
  console.log("\n--- COMMIT ER OrderBook state back to L1 ---");
  const l1Before = decodeOrderBookHeader((await base.getAccountInfo(orderBookPda))!.data);
  log(`  L1 before commit: active=${l1Before.activeOrderCount} nextOrderId=${l1Before.nextOrderId}`);

  let committed = false;
  try {
    const commitIx = createCommitOrderbookInstruction(maker.publicKey, MARKET_INDEX);
    const sigCommit = await sendEr(er, "commit_orderbook", commitIx, maker);
    log(`  commit scheduled on ER: ${sigCommit}`);
    for (let i = 0; i < 20 && !committed; i++) {
      await sleep(1_500);
      const l1 = await base.getAccountInfo(orderBookPda);
      if (!l1) continue;
      const h = decodeOrderBookHeader(l1.data);
      if (i % 4 === 0) log(`  L1 after commit: active=${h.activeOrderCount} nextOrderId=${h.nextOrderId}`);
      if (h.nextOrderId >= hP.nextOrderId) committed = true;
    }
  } catch (e: any) {
    log(`  commit step error: ${e?.message ?? e}`);
  }
  check(
    committed,
    `Req 8.2: ER OrderBook state committed back to L1 (nextOrderId reached ${hP.nextOrderId})`
  );

  // ---- Summary ----
  console.log("\n=== ER OrderBook summary ===");
  console.log(`place (ER):   ${sigPlace}  -> active ${h0.activeOrderCount} -> ${hP.activeOrderCount}`);
  console.log(`cancel (ER):  ${sigCancel} -> active ${hP.activeOrderCount} -> ${hC?.activeOrderCount}`);
  console.log(`commit -> L1: ${committed ? "state committed to base layer" : "NOT committed to L1"}`);
  console.log(`Checks: ${checks} run, ${failures} failed`);

  if (failures > 0) {
    console.error(`\nER OrderBook test FAILED/BLOCKED (${failures} check(s) did not pass). See steps above.`);
    process.exit(1);
  }
  console.log("\nER OrderBook test PASSED (place + cancel on ER, header counts changed, state committed to L1).");
}

main().catch((err) => {
  console.error("ER OrderBook test crashed:", err?.message ?? err);
  process.exit(1);
});
