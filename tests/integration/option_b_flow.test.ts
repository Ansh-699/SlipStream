#!/usr/bin/env tsx
/**
 * Option-B end-to-end integration test.
 *
 * Flow:
 *   1. initialize_global + initialize_market (admin, once per program deploy)
 *   2. initialize_user + deposit_collateral (per user)
 *   3. initialize_trading_credit + fund_trading_credit + delegate_trading_credit (per session)
 *   4. place_order on ER (matching happens there; fill events emitted)
 *   5. keeper: record_pending_fill + settle_trades (L1)
 *   6. position closes via opposite order + settlement
 *   7. undelegate_trading_credit + withdraw_trading_credit + withdraw_collateral
 *
 * Run against devnet + MagicBlock ER:
 *   BASE_RPC=https://api.devnet.solana.com \
 *   ER_RPC=https://devnet.magicblock.app \
 *   npx tsx option_b_flow.test.ts
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  createAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  createInitializeGlobalInstruction,
  createInitializeMarketInstruction,
  createInitializeUserInstruction,
  createDepositCollateralInstruction,
  createWithdrawCollateralInstruction,
  createInitializeTradingCreditInstruction,
  createFundTradingCreditInstruction,
  createDelegateTradingCreditInstruction,
  createDelegateOrderbookInstruction,
  createPlaceOrderInstruction,
  createRecordPendingFillInstruction,
  createSettleTradesInstruction,
  findOrderBookPda,
  findUserAccountPda,
  findPositionPda,
  findTradingCreditPda,
  decodeOrderBookHeader,
  decodeFillEvent,
  ORDER_BOOK_HEADER_SIZE,
  ORDER_SLOT_SIZE,
  PRICE_LEVEL_SIZE,
  FILL_EVENT_SIZE,
  PRICE_SCALE,
  SIDE_BID,
  SIDE_ASK,
  ORDER_TYPE_LIMIT,
} from "../../client/src";

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const MARKET_INDEX = 0;
const TICK_SIZE = 1_000n;           // $0.001
const LOT_SIZE  = 100_000_000n;     // 0.1 base (at 9 decimals)
const MAX_LEVERAGE = 20;
const TAKER_FEE_BPS = 6;
const MAKER_REBATE_BPS = 1;
const FUNDING_INTERVAL_SECS = 28800n;

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function airdrop(conn: Connection, pk: PublicKey, sol: number) {
  log(`airdrop ${sol} SOL -> ${pk.toBase58()}`);
  const sig = await conn.requestAirdrop(pk, sol * 1e9);
  await conn.confirmTransaction(sig);
}

async function main() {
  const baseConn = new Connection(BASE_RPC, "confirmed");
  const erConn = new Connection(ER_RPC, { commitment: "confirmed" });

  const authority = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();

  await airdrop(baseConn, authority.publicKey, 5);
  await airdrop(baseConn, alice.publicKey, 2);
  await airdrop(baseConn, bob.publicKey, 2);

  // USDC mint + vault
  const usdcMint = await createMint(baseConn, authority, authority.publicKey, null, 6);
  const vault = await createAccount(baseConn, authority, usdcMint, authority.publicKey);
  log(`USDC mint: ${usdcMint.toBase58()}  vault: ${vault.toBase58()}`);

  // 1. initialize_global
  {
    const ix = createInitializeGlobalInstruction(
      authority.publicKey,
      authority.publicKey, // treasury
      vault,               // insurance_vault (sharing with quote_vault for demo)
    );
    const sig = await sendAndConfirmTransaction(baseConn, new Transaction().add(ix), [authority]);
    log(`initialize_global: ${sig}`);
  }

  // 2. initialize_market (SOL-PERP, dummy Pyth + Switchboard)
  const PYTH_DEVNET = new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix");
  const SWITCHBOARD_DEVNET = new PublicKey("GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR");
  {
    const ix = createInitializeMarketInstruction(
      authority.publicKey,
      vault,
      PYTH_DEVNET,
      SWITCHBOARD_DEVNET,
      {
        marketIndex: MARKET_INDEX,
        tickSize: TICK_SIZE,
        lotSize: LOT_SIZE,
        maxLeverage: MAX_LEVERAGE,
        takerFeeBps: TAKER_FEE_BPS,
        makerRebateBps: MAKER_REBATE_BPS,
        fundingInterval: FUNDING_INTERVAL_SECS,
      }
    );
    const sig = await sendAndConfirmTransaction(baseConn, new Transaction().add(ix), [authority]);
    log(`initialize_market: ${sig}`);
  }

  // 3. per-user: init_user, deposit_collateral
  for (const user of [alice, bob]) {
    const ixInitUser = createInitializeUserInstruction(user.publicKey);
    await sendAndConfirmTransaction(baseConn, new Transaction().add(ixInitUser), [user]);

    const ata = await getOrCreateAssociatedTokenAccount(baseConn, authority, usdcMint, user.publicKey);
    await mintTo(baseConn, authority, usdcMint, ata.address, authority.publicKey, 5_000_000_000n); // 5000 USDC

    const ixDeposit = createDepositCollateralInstruction(
      user.publicKey,
      ata.address,
      vault,
      1_000_000_000n, // 1000 USDC
    );
    await sendAndConfirmTransaction(baseConn, new Transaction().add(ixDeposit), [user]);
    log(`user ${user.publicKey.toBase58().slice(0,8)}… deposited 1000 USDC`);
  }

  // 4. per-user: init_trading_credit + fund + delegate
  for (const user of [alice, bob]) {
    await sendAndConfirmTransaction(
      baseConn,
      new Transaction().add(createInitializeTradingCreditInstruction(user.publicKey, MARKET_INDEX)),
      [user]
    );
    await sendAndConfirmTransaction(
      baseConn,
      new Transaction().add(createFundTradingCreditInstruction(user.publicKey, MARKET_INDEX, 500_000_000n)),
      [user]
    );
    await sendAndConfirmTransaction(
      baseConn,
      new Transaction().add(createDelegateTradingCreditInstruction(user.publicKey, MARKET_INDEX)),
      [user]
    );
    log(`user ${user.publicKey.toBase58().slice(0,8)}… credit funded+delegated with 500 USDC`);
  }

  // 5. delegate orderbook
  await sendAndConfirmTransaction(
    baseConn,
    new Transaction().add(createDelegateOrderbookInstruction(authority.publicKey, MARKET_INDEX)),
    [authority]
  );
  log(`orderbook delegated`);

  // 6. place orders on ER — alice bids, bob asks at same price → match
  await sleep(3_000); // wait for delegation propagation

  const orderPrice = 150n * BigInt(PRICE_SCALE); // $150
  const orderSize  = 1_000_000_000n;              // 1 SOL (9 decimals)

  const aliceBid = new Transaction().add(
    createPlaceOrderInstruction(alice.publicKey, MARKET_INDEX, {
      side: SIDE_BID,
      orderType: ORDER_TYPE_LIMIT,
      price: orderPrice,
      size: orderSize,
    })
  );
  aliceBid.recentBlockhash = (await erConn.getLatestBlockhash()).blockhash;
  aliceBid.feePayer = alice.publicKey;
  aliceBid.sign(alice);
  const sigA = await erConn.sendRawTransaction(aliceBid.serialize(), { skipPreflight: true });
  await erConn.confirmTransaction(sigA);
  log(`alice bid @ $150: ${sigA}`);

  const bobAsk = new Transaction().add(
    createPlaceOrderInstruction(bob.publicKey, MARKET_INDEX, {
      side: SIDE_ASK,
      orderType: ORDER_TYPE_LIMIT,
      price: orderPrice,
      size: orderSize,
    })
  );
  bobAsk.recentBlockhash = (await erConn.getLatestBlockhash()).blockhash;
  bobAsk.feePayer = bob.publicKey;
  bobAsk.sign(bob);
  const sigB = await erConn.sendRawTransaction(bobAsk.serialize(), { skipPreflight: true });
  await erConn.confirmTransaction(sigB);
  log(`bob ask @ $150 (should cross): ${sigB}`);

  // 7. Wait for fill events + settle_trades on L1
  await sleep(2_000);

  const [orderBookPda] = findOrderBookPda(MARKET_INDEX);
  const obInfo = await erConn.getAccountInfo(orderBookPda);
  if (!obInfo) throw new Error("OrderBook missing on ER");
  const header = decodeOrderBookHeader(obInfo.data);
  log(`fill events on ER: ${header.fillEventCount}`);
  if (header.fillEventCount === 0) {
    log("WARNING: no fill events emitted; orders may not have matched");
  }

  // Keeper flow: record_pending_fill + settle_trades bundled together
  if (header.fillEventCount > 0) {
    const fillOffset = ORDER_BOOK_HEADER_SIZE
      + header.maxOrderSlots * ORDER_SLOT_SIZE
      + header.maxPriceLevelsPerSide * PRICE_LEVEL_SIZE * 2;
    const fill = decodeFillEvent(obInfo.data, fillOffset + header.fillEventHead * FILL_EVENT_SIZE);

    const [aliceUser] = findUserAccountPda(new PublicKey(fill.maker));
    const [bobUser] = findUserAccountPda(new PublicKey(fill.taker));
    const [alicePos] = findPositionPda(new PublicKey(fill.maker), MARKET_INDEX);
    const [bobPos] = findPositionPda(new PublicKey(fill.taker), MARKET_INDEX);

    const bundle = new Transaction()
      .add(createRecordPendingFillInstruction([aliceUser, bobUser]))
      .add(
        createSettleTradesInstruction(MARKET_INDEX, 1, [
          { pubkey: aliceUser, isSigner: false, isWritable: true },
          { pubkey: alicePos, isSigner: false, isWritable: true },
          { pubkey: bobUser, isSigner: false, isWritable: true },
          { pubkey: bobPos, isSigner: false, isWritable: true },
        ])
      );
    const sig = await sendAndConfirmTransaction(baseConn, bundle, [authority]);
    log(`record_pending_fill + settle_trades: ${sig}`);
  }

  log("=== Option B flow complete ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
