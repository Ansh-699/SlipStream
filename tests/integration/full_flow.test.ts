#!/usr/bin/env tsx
/**
 * Full-flow end-to-end integration test (Requirements 8.1, 8.5).
 *
 * Mirrors option_b_flow.test.ts but uses the live deploy described by the
 * repo-root deploy.json and the client SDK builders end-to-end. It exercises the
 * complete trade lifecycle against LIVE devnet + the MagicBlock ER:
 *
 *   per trader (maker + taker):
 *     initialize_user
 *       -> mint USDC to ATA + deposit_collateral
 *       -> initialize_trading_credit
 *       -> fund_trading_credit
 *       -> delegate_trading_credit
 *       -> initialize_position(owner, marketIndex)   [NEW 0x19 builder]
 *   maker rests an order on the ER, taker crosses it    -> fill emitted on ER
 *   commit the ER OrderBook state back to L1            -> L1 sees the fill
 *   keeper: record_pending_fill + settle_trades (L1)    -> Position opened
 *   assert a Position decodes with size != 0            (Req 8.1)
 *
 * HONESTY (Req 8.5): every step awaits confirmation and surfaces the failing
 * step with its on-chain error detail. The OrderBook is delegated to the ER, so
 * L1 settlement requires the ER to commit the OrderBook back first; the test
 * performs that commit explicitly and reports precisely where it lands. No pass
 * is fabricated — "position opened" is asserted only if a Position truly carries
 * a non-zero size on L1.
 *
 * Run (authoritative live run is spec task 9.1):
 *   BASE_RPC=https://api.devnet.solana.com \
 *   ER_RPC=https://devnet.magicblock.app \
 *   AUTHORITY_KEYPAIR=~/.config/solana/id.json \
 *   npx tsx full_flow.test.ts
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
  createCommitOrderbookInstruction,
  createRecordPendingFillInstruction,
  createSettleTradesInstruction,
  findUserAccountPda,
  findPositionPda,
  findOrderBookPda,
  findTradingCreditPda,
  decodeOrderBookHeader,
  decodeFillEvent,
  decodePosition,
  type FillEvent,
  type OrderBookHeader,
  ORDER_BOOK_HEADER_SIZE,
  ORDER_SLOT_SIZE,
  PRICE_LEVEL_SIZE,
  FILL_EVENT_SIZE,
  SIDE_BID,
  SIDE_ASK,
  ORDER_TYPE_LIMIT,
} from "../../client/src";

// --------------------------------------------------------------------------
// Config — small sizes/prices keep required credit + SOL tiny (conserve funds).
// --------------------------------------------------------------------------
const MARKET_INDEX = 0;
// Limit orders match purely inside the book (no oracle gate), so a low price is
// fine and minimises the initial-margin requirement.
const ORDER_PRICE = 1_000_000n; // $1.00 (multiple of tick 1000)
const ORDER_SIZE = 100_000_000n; // 0.1 base atoms == exactly one lot (lot_size)
const DEPOSIT_USDC = 100_000_000n; // $100 (6-dp)
const FUND_USDC = 50_000_000n; //  $50 credit (margin needed ≈ $5)
const MINT_USDC = 200_000_000n; // $200 minted to each trader ATA
const TRADER_SOL = 0.05; // tiny rent + fee budget per trader

// --------------------------------------------------------------------------
// Manifest (live deploy addresses)
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
    path.resolve(__dirname, "../../../deploy.json"),
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
// Assertion harness (exit non-zero on a genuine failure)
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
// L1 send: preflight ON so program reverts surface immediately (Req 8.5).
// --------------------------------------------------------------------------
async function sendL1(
  conn: Connection,
  step: string,
  ixs: TransactionInstruction[],
  signers: Keypair[]
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, {
      commitment: "confirmed",
      skipPreflight: false,
    });
    return sig;
  } catch (e: any) {
    const logs = Array.isArray(e?.logs) ? e.logs.join("\n") : "";
    throw new Error(`[${step}] L1 tx failed: ${e?.message ?? e}\n${logs}`);
  }
}

// --------------------------------------------------------------------------
// ER send: sign + send raw, then await confirmation and branch on err (Req 8.5).
// --------------------------------------------------------------------------
async function sendEr(
  er: Connection,
  step: string,
  ix: TransactionInstruction,
  payer: Keypair,
  extraSigners: Keypair[] = []
): Promise<string> {
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...extraSigners);
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
    throw new Error(
      `[${step}] ER tx ${sig} failed: ${JSON.stringify(conf.value.err)}\n${logs}`
    );
  }
  return sig;
}

// --------------------------------------------------------------------------
// OrderBook fill decoding (matches the settlement keeper).
// --------------------------------------------------------------------------
function fillsBaseOffset(h: OrderBookHeader): number {
  return (
    ORDER_BOOK_HEADER_SIZE +
    h.maxOrderSlots * ORDER_SLOT_SIZE +
    h.maxPriceLevelsPerSide * PRICE_LEVEL_SIZE * 2
  );
}

function decodeHeadFill(data: Buffer, h: OrderBookHeader): FillEvent {
  return decodeFillEvent(data, fillsBaseOffset(h) + h.fillEventHead * FILL_EVENT_SIZE);
}

// --------------------------------------------------------------------------
// Per-trader L1 setup: user + collateral + funded/delegated credit + position.
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

  // Idempotent across reused persistent keys: skip any step already done on a
  // prior run. The TradingCredit may already be delegated (owned by the
  // delegation program), in which case the L1 funding/delegation steps are
  // no-ops and we go straight to placing orders on the ER.
  const [userPda] = findUserAccountPda(trader.publicKey);
  const [creditPda] = findTradingCreditPda(trader.publicKey, MARKET_INDEX);

  const userInfo = await base.getAccountInfo(userPda);
  if (userInfo && userInfo.data.length > 0) {
    log(`  init_user skipped (already exists)`);
  } else {
    await sendL1(base, `${label}:init_user`, [createInitializeUserInstruction(trader.publicKey)], [trader]);
    log(`  init_user ok`);
  }

  // Operator (mint authority) creates+funds the trader ATA, then trader deposits.
  const ata = await getOrCreateAssociatedTokenAccount(base, authority, mint, trader.publicKey);
  await mintTo(base, authority, mint, ata.address, authority.publicKey, MINT_USDC);
  log(`  minted ${Number(MINT_USDC) / 1e6} USDC to ATA ${ata.address.toBase58().slice(0, 8)}…`);

  await sendL1(
    base,
    `${label}:deposit_collateral`,
    [createDepositCollateralInstruction(trader.publicKey, ata.address, vault, DEPOSIT_USDC)],
    [trader]
  );
  log(`  deposit_collateral ${Number(DEPOSIT_USDC) / 1e6} USDC ok`);

  // TradingCredit: skip init/fund/delegate when the credit is already delegated.
  const creditInfo = await base.getAccountInfo(creditPda);
  const creditDelegated = creditInfo?.owner.equals(DELEGATION_PROGRAM_ID) ?? false;
  if (creditDelegated) {
    log(`  trading_credit already delegated to ER (reused key) — skipping init/fund/delegate`);
  } else {
    if (creditInfo && creditInfo.data.length > 0) {
      log(`  init_trading_credit skipped (already exists)`);
    } else {
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
    log(`  trading_credit funded ${Number(FUND_USDC) / 1e6} USDC`);

    await sendL1(
      base,
      `${label}:delegate_trading_credit`,
      [createDelegateTradingCreditInstruction(trader.publicKey, MARKET_INDEX)],
      [trader]
    );
    log(`  trading_credit delegated to ER`);
  }

  // initialize_position (0x19): allocate the empty Position so settle_trades can
  // open into it (nothing else in the program creates a Position).
  const [positionPda] = findPositionPda(trader.publicKey, MARKET_INDEX);
  const posInfo = await base.getAccountInfo(positionPda);
  if (posInfo && posInfo.data.length > 0) {
    log(`  position already allocated (${positionPda.toBase58().slice(0, 8)}…)`);
  } else {
    await sendL1(
      base,
      `${label}:initialize_position`,
      [createInitializePositionInstruction(trader.publicKey, MARKET_INDEX)],
      [trader]
    );
    log(`  initialize_position ok (${positionPda.toBase58().slice(0, 8)}…)`);
  }
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
async function main() {
  console.log("\n=== Slipstream Full-Flow Integration Test (Req 8.1, 8.5) ===\n");

  const manifest = loadManifest();
  const base = getBaseConnection();
  const er = getErConnection();
  const authority = loadKeypair(process.env.AUTHORITY_KEYPAIR);

  const mint = new PublicKey(manifest.usdcMint);
  const vault = new PublicKey(manifest.usdcVault);
  const [orderBookPda] = findOrderBookPda(MARKET_INDEX);

  log(`Authority/operator: ${authority.publicKey.toBase58()}`);
  log(`Program:   ${manifest.programId}`);
  log(`Market:    ${manifest.market} (index ${MARKET_INDEX})`);
  log(`OrderBook: ${orderBookPda.toBase58()}`);
  log(`USDC mint: ${manifest.usdcMint}  vault: ${manifest.usdcVault}`);

  // The OrderBook must already be delegated from the bootstrap — do NOT re-delegate
  // here (the raw SDK delegate cannot make the program-owned PDA sign).
  const delegated = await isDelegated(base, orderBookPda);
  if (!check(delegated, "OrderBook is delegated to the ER (from bootstrap)")) {
    throw new Error(
      "[setup] OrderBook is not delegated. Re-run scripts/deploy.ts to delegate it; " +
        "this test intentionally does not delegate the shared orderbook."
    );
  }

  // Two reused PERSISTENT traders (conserve SOL): maker rests, taker crosses.
  // Keys are stored under .test-keys/ and reused across runs so re-runs don't
  // strand SOL on fresh throwaway keys.
  const maker = loadOrCreateTestKeypair("full_flow_maker");
  const taker = loadOrCreateTestKeypair("full_flow_taker");
  await setupTrader(base, authority, mint, vault, maker, "maker");
  await setupTrader(base, authority, mint, vault, taker, "taker");

  // ---- Place orders on the ER: maker ASK rests, taker BID crosses ----
  console.log("\n--- Placing orders on the ER ---");
  await sleep(2_000); // allow credit-delegation propagation to the ER

  const makerAsk = createPlaceOrderInstruction(maker.publicKey, MARKET_INDEX, {
    side: SIDE_ASK,
    orderType: ORDER_TYPE_LIMIT,
    price: ORDER_PRICE,
    size: ORDER_SIZE,
  });
  const sigMaker = await sendEr(er, "maker:place_order(ask)", makerAsk, maker);
  log(`  maker ASK @ $${Number(ORDER_PRICE) / 1e6} rested on ER: ${sigMaker}`);
  await sleep(1_500);

  const takerBid = createPlaceOrderInstruction(taker.publicKey, MARKET_INDEX, {
    side: SIDE_BID,
    orderType: ORDER_TYPE_LIMIT,
    price: ORDER_PRICE,
    size: ORDER_SIZE,
  });
  const sigTaker = await sendEr(er, "taker:place_order(bid)", takerBid, taker);
  log(`  taker BID @ $${Number(ORDER_PRICE) / 1e6} crossed on ER: ${sigTaker}`);

  // ---- Read the fill from the ER OrderBook ----
  console.log("\n--- Reading fill from the ER OrderBook ---");
  let fill: FillEvent | null = null;
  for (let i = 0; i < 10 && fill === null; i++) {
    await sleep(1_000);
    const obInfo = await er.getAccountInfo(orderBookPda);
    if (!obInfo) continue;
    const header = decodeOrderBookHeader(obInfo.data);
    log(`  ER fillEventCount=${header.fillEventCount} active=${header.activeOrderCount} nextOrderId=${header.nextOrderId}`);
    if (header.fillEventCount > 0) fill = decodeHeadFill(obInfo.data, header);
  }

  if (!check(fill !== null, "maker/taker orders matched and emitted a fill on the ER")) {
    throw new Error("[er_match] no fill event was emitted on the ER; orders did not cross");
  }
  const f = fill as FillEvent;
  const fillMaker = new PublicKey(f.maker);
  const fillTaker = new PublicKey(f.taker);
  log(
    `  fill: seq=${f.sequence} price=$${Number(f.price) / 1e6} qty=${f.quantity} ` +
      `maker=${fillMaker.toBase58().slice(0, 8)}… taker=${fillTaker.toBase58().slice(0, 8)}… ` +
      `filledMargin=${f.filledMargin}`
  );

  // ---- Commit the ER OrderBook state back to L1 so settle_trades sees the fill ----
  // The OrderBook commits only on explicit commit/undelegate (commit_frequency =
  // u32::MAX), so without this the L1 copy stays stale (fillEventCount = 0).
  console.log("\n--- Committing ER OrderBook state back to L1 ---");
  let committedToL1 = false;
  try {
    const commitIx = createCommitOrderbookInstruction(taker.publicKey, MARKET_INDEX);
    const sigCommit = await sendEr(er, "commit_orderbook", commitIx, taker);
    log(`  commit scheduled on ER: ${sigCommit}`);
    // Poll the L1 OrderBook for the committed fill to land.
    for (let i = 0; i < 20 && !committedToL1; i++) {
      await sleep(1_500);
      const l1 = await base.getAccountInfo(orderBookPda);
      if (!l1) continue;
      const h = decodeOrderBookHeader(l1.data);
      if (i % 4 === 0) log(`  L1 OrderBook fillEventCount=${h.fillEventCount} nextOrderId=${h.nextOrderId}`);
      if (h.fillEventCount > 0) committedToL1 = true;
    }
  } catch (e: any) {
    log(`  commit step error: ${e?.message ?? e}`);
  }
  check(committedToL1, "ER OrderBook fill committed back to the base layer (Req: state commits to L1)");

  // ---- Keeper settlement on L1: record_pending_fill + settle_trades ----
  console.log("\n--- Settling on L1 (record_pending_fill + settle_trades) ---");
  const [makerUser] = findUserAccountPda(fillMaker);
  const [takerUser] = findUserAccountPda(fillTaker);
  const [makerPos] = findPositionPda(fillMaker, MARKET_INDEX);
  const [takerPos] = findPositionPda(fillTaker, MARKET_INDEX);

  let settleSig: string | null = null;
  let settleErr: string | null = null;
  try {
    const bundle = [
      createRecordPendingFillInstruction([makerUser, takerUser]),
      createSettleTradesInstruction(MARKET_INDEX, 1, [
        { pubkey: makerUser, isSigner: false, isWritable: true },
        { pubkey: makerPos, isSigner: false, isWritable: true },
        { pubkey: takerUser, isSigner: false, isWritable: true },
        { pubkey: takerPos, isSigner: false, isWritable: true },
      ]),
    ];
    settleSig = await sendL1(base, "settle_trades", bundle, [authority]);
    log(`  record_pending_fill + settle_trades landed on L1: ${settleSig}`);
  } catch (e: any) {
    settleErr = e?.message ?? String(e);
    log(`  settle_trades did not land: ${settleErr}`);
  }
  check(settleSig !== null, "record_pending_fill + settle_trades landed on L1");

  // ---- Assert a Position opened (size != 0) — Req 8.1 ----
  console.log("\n--- Verifying a Position opened (size != 0) ---");
  let opened = false;
  for (const [owner, pda, who] of [
    [fillMaker, makerPos, "maker"],
    [fillTaker, takerPos, "taker"],
  ] as [PublicKey, PublicKey, string][]) {
    const info = await base.getAccountInfo(pda);
    if (!info || info.data.length === 0) {
      log(`  ${who} position ${pda.toBase58().slice(0, 8)}… not allocated`);
      continue;
    }
    try {
      const pos = decodePosition(info.data);
      log(
        `  ${who} position: size=${pos.size} entry=$${Number(pos.entryPrice) / 1e6} ` +
          `collateral=${pos.collateral} marketIndex=${pos.marketIndex}`
      );
      if (pos.size !== 0n) opened = true;
    } catch (e: any) {
      log(`  ${who} position decode error: ${e?.message ?? e}`);
    }
  }
  check(opened, "Req 8.1: a Position opened with non-zero size after settlement");

  // ---- Summary ----
  console.log("\n=== Full-flow summary ===");
  console.log(`maker place (ER):  ${sigMaker}`);
  console.log(`taker place (ER):  ${sigTaker}`);
  console.log(`commit -> L1:      ${committedToL1 ? "fill visible on L1" : "NOT committed to L1"}`);
  console.log(`settle (L1):       ${settleSig ?? `BLOCKED — ${settleErr}`}`);
  console.log(`position opened:   ${opened ? "YES (size != 0)" : "NO"}`);
  console.log(`Checks: ${checks} run, ${failures} failed`);

  if (failures > 0) {
    console.error(`\nFull-flow test FAILED/BLOCKED (${failures} check(s) did not pass). See steps above.`);
    process.exit(1);
  }
  console.log("\nFull-flow test PASSED (deposit -> ER order -> commit -> L1 settle -> position opened).");
}

main().catch((err) => {
  console.error("Full-flow test crashed:", err?.message ?? err);
  process.exit(1);
});
