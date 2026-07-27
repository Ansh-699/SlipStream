#!/usr/bin/env tsx
/**
 * TWAP-crank harness for spec task 9.2 (NOT part of test:all).
 *
 * Purpose: drive the live SOL-PERP market's funding preconditions as far as the
 * DEPLOYED instructions allow, so funding.test.ts can attempt a real accrual.
 *
 * This exercises ONLY deployed instructions against live devnet state:
 *   1. crank_twap (IX 0x0b) — accounts [market(W), pyth(R)] — pushes one live Pyth
 *      sample into Market.twap_prices so get_twap() stops returning None.
 *   2. compute_funding (IX 0x06) — accounts [market(W), pyth(R), switchboard(R)] —
 *      attempted directly afterwards to capture the authoritative on-chain outcome
 *      (index advanced, or the precise revert: dual-oracle freshness/agreement).
 *
 * It does NOT modify the program, keepers, or frontend. Every command, signature,
 * and state transition is logged for honest reporting (Req 8.5).
 *
 * Run:
 *   BASE_RPC=https://api.devnet.solana.com \
 *   AUTHORITY_KEYPAIR=~/.config/solana/id.json \
 *   CRANKS=5 npx tsx crank_twap_harness.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

import {
  createCrankTwapInstruction,
  createComputeFundingInstruction,
  findMarketPda,
  decodeMarket,
  type Market,
} from "../../client/src";

import { loadKeypair, getBaseConnection, log } from "./setup";

const MARKET_INDEX = 0;
const REPO_ROOT_MANIFEST = path.resolve(__dirname, "../../deploy.json");
const CRANKS = Number(process.env.CRANKS || "5");

const ERR_NAMES = [
  "InvalidDiscriminator", "InvalidAuthority", "InvalidPda", "InvalidOracle", "OracleStale",
  "MarketPaused", "CircuitBreakerTripped", "InsufficientCollateral", "InsufficientMargin", "WithdrawalGateFailed",
  "PendingFillsExist", "ReservedMarginExists", "SameSlotWithdrawal", "OrderBookFull", "PriceLevelsFull",
  "InvalidOrderPrice", "InvalidOrderSize", "InvalidOrderSide", "InvalidOrderType", "OrderNotFound",
  "NotOrderOwner", "PostOnlyWouldCross", "FokCannotFill", "SlippageExceeded", "PositionNotFound",
  "PositionNotLiquidatable", "HealthFactorAboveThreshold", "InsuranceFundInsufficient", "InvalidFillSequence", "FillQueueEmpty",
  "FillQueueFull", "MathOverflow", "MathUnderflow", "DivisionByZero", "InvalidMarketIndex",
  "MaxOrdersPerUser", "InvalidExpiryTimestamp", "AccountAlreadyInitialized", "AccountNotInitialized", "InvalidTokenMint",
  "InvalidVault", "InvalidProgramId", "InsufficientCredit", "CreditStillActive", "TickSizeViolation",
  "LotSizeViolation", "OracleDisagreement", "RestrictedMode", "InvalidSwitchboardFeed", "GracePeriodActive",
  "LiquidationIntentNotReady", "GlobalPaused", "FillMarginExceeded",
];
const ERROR_BASE = 0x100;
function errName(code: number): string {
  const i = code - ERROR_BASE;
  return i >= 0 && i < ERR_NAMES.length ? ERR_NAMES[i] : `unknown(${code})`;
}

interface Manifest {
  programId: PublicKey;
  market: PublicKey;
  pythFeed: PublicKey;
  switchboardFeed: PublicKey;
}

function loadManifest(): Manifest {
  const m = JSON.parse(fs.readFileSync(REPO_ROOT_MANIFEST, "utf-8"));
  return {
    programId: new PublicKey(m.programId),
    market: m.market ? new PublicKey(m.market) : findMarketPda(MARKET_INDEX, new PublicKey(m.programId))[0],
    pythFeed: new PublicKey(m.pythFeed),
    switchboardFeed: new PublicKey(m.switchboardFeed),
  };
}

async function readMarket(conn: Connection, market: PublicKey): Promise<Market> {
  const info = await conn.getAccountInfo(market, "confirmed");
  if (!info) throw new Error(`market ${market.toBase58()} not found`);
  return decodeMarket(info.data as Buffer);
}

// Parse the live Pyth price account (matches the deployed dual-layout parser:
// legacy V2 @ len>=248, PriceUpdateV2 @ len~134).
function inspectPyth(data: Buffer, now: number) {
  let priceRaw: bigint;
  let exponent: number;
  let publishTime: bigint;
  let status: number | string;
  if (data.length >= 248) {
    // Legacy Pyth V2 aggregate
    priceRaw = data.readBigInt64LE(208);
    exponent = data.readInt32LE(20);
    publishTime = data.readBigInt64LE(96);
    status = data.readUInt32LE(224);
  } else if (data.length >= 134) {
    // Pyth Receiver PriceUpdateV2 (no trading-status field)
    priceRaw = data.readBigInt64LE(73);
    exponent = data.readInt32LE(89);
    publishTime = data.readBigInt64LE(93);
    status = "n/a(PriceUpdateV2)";
  } else {
    return { ok: false, reason: `len ${data.length} < 134` };
  }
  const expDiff = exponent - -6;
  let price = priceRaw;
  if (expDiff > 0) price = priceRaw * 10n ** BigInt(expDiff);
  else if (expDiff < 0) price = priceRaw / 10n ** BigInt(-expDiff);
  const age = now - Number(publishTime);
  return { ok: true, priceRaw, exponent, publishTime: Number(publishTime), status, price, age };
}

// Parse the live Switchboard On-Demand feed (same offsets the program uses).
function inspectSwitchboard(data: Buffer, now: number) {
  if (data.length < 104) return { ok: false, reason: `len ${data.length} < 104` };
  const lo = data.readBigUInt64LE(80);
  const hi = data.readBigInt64LE(88);
  const value = (hi << 64n) | lo;
  const publishTs = data.readBigInt64LE(96);
  const price = value / 1_000_000_000_000n;
  const age = now - Number(publishTs);
  return { ok: true, value, publishTs: Number(publishTs), price, age };
}

function classifySendError(e: any): { code: number | null; raw: string } {
  const logs: string[] = Array.isArray(e?.logs) ? e.logs : [];
  const hay = [e?.message ?? String(e), ...logs].join("\n");
  const hex = hay.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hex) return { code: parseInt(hex[1], 16), raw: hay };
  const dec = hay.match(/Custom\((\d+)\)/);
  if (dec) return { code: parseInt(dec[1], 10), raw: hay };
  return { code: null, raw: hay };
}

async function main() {
  console.log("\n=== TWAP-crank harness (task 9.2 precondition driver) ===\n");
  const conn = getBaseConnection();
  const mf = loadManifest();
  const payer = loadKeypair(process.env.AUTHORITY_KEYPAIR);
  log(`base RPC: ${conn.rpcEndpoint}`);
  log(`programId=${mf.programId.toBase58()}`);
  log(`market=${mf.market.toBase58()}`);
  log(`pyth=${mf.pythFeed.toBase58()}  switchboard=${mf.switchboardFeed.toBase58()}`);
  log(`payer=${payer.publicKey.toBase58()}`);

  const now = Math.floor(Date.now() / 1000);

  // --- Inspect live oracle feeds (freshness/agreement decide if funding can accrue) ---
  log("\n--- Live oracle inspection ---");
  const pythInfo = await conn.getAccountInfo(mf.pythFeed, "confirmed");
  const sbInfo = await conn.getAccountInfo(mf.switchboardFeed, "confirmed");
  if (!pythInfo) {
    log(`  Pyth feed ${mf.pythFeed.toBase58()} NOT FOUND on ${conn.rpcEndpoint}`);
  } else {
    const p = inspectPyth(pythInfo.data as Buffer, now) as any;
    if (p.ok) {
      log(`  Pyth: status=${p.status} (1=Trading) priceRaw=${p.priceRaw} exp=${p.exponent} -> price6=${p.price} publishTs=${p.publishTime} age=${p.age}s (stale if >60s or status!=1)`);
    } else {
      log(`  Pyth: unparseable (${p.reason})`);
    }
  }
  if (!sbInfo) {
    log(`  Switchboard feed ${mf.switchboardFeed.toBase58()} NOT FOUND on ${conn.rpcEndpoint}`);
  } else {
    const s = inspectSwitchboard(sbInfo.data as Buffer, now) as any;
    if (s.ok) {
      log(`  Switchboard: value=${s.value} -> price6=${s.price} publishTs=${s.publishTs} age=${s.age}s (stale if >60s; value must be >0)`);
    } else {
      log(`  Switchboard: unparseable (${s.reason}) — len=${(sbInfo.data as Buffer).length}`);
    }
  }

  // --- Read market before ---
  let m = await readMarket(conn, mf.market);
  log("\n--- Market BEFORE crank ---");
  log(`  twap_count=${m.twapCount} twap_write_index=${m.twapWriteIndex} last_mark_price=${m.lastMarkPrice}`);
  log(`  cumulative_funding_index=${m.cumulativeFundingIndex} last_funding_ts=${m.lastFundingTs} funding_interval=${m.fundingIntervalSecs}s`);
  log(`  circuit_breaker_active=${m.circuitBreakerActive}`);

  // --- Crank TWAP loop ---
  log(`\n--- Cranking TWAP up to ${CRANKS}x (deployed crank_twap IX) ---`);
  const sigs: string[] = [];
  for (let i = 0; i < CRANKS; i++) {
    const ix: TransactionInstruction = createCrankTwapInstruction(MARKET_INDEX, mf.pythFeed, mf.programId);
    try {
      const tx = new Transaction().add(ix);
      tx.feePayer = payer.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
        skipPreflight: false,
        commitment: "confirmed",
      });
      sigs.push(sig);
      const after = await readMarket(conn, mf.market);
      log(`  crank #${i + 1} OK sig=${sig} -> twap_count=${after.twapCount} last_mark_price=${after.lastMarkPrice} cb=${after.circuitBreakerActive}`);
      m = after;
    } catch (e: any) {
      const c = classifySendError(e);
      const label = c.code !== null ? `custom ${c.code} (${errName(c.code)})` : `non-custom (${e?.message ?? e})`;
      log(`  crank #${i + 1} REVERTED: ${label}`);
      log(`    -> crank_twap could not push a sample (Pyth not Trading/stale). Stopping crank loop.`);
      break;
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  log(`\n  Cranks landed: ${sigs.length}/${CRANKS}`);
  sigs.forEach((s, i) => log(`    [${i + 1}] ${s}`));

  // --- Read market after crank ---
  m = await readMarket(conn, mf.market);
  log("\n--- Market AFTER crank ---");
  log(`  twap_count=${m.twapCount} twap_write_index=${m.twapWriteIndex} last_mark_price=${m.lastMarkPrice}`);
  log(`  cumulative_funding_index=${m.cumulativeFundingIndex} last_funding_ts=${m.lastFundingTs}`);

  // --- Attempt compute_funding directly (authoritative outcome) ---
  log("\n--- Attempting compute_funding directly (deployed IX 0x06) ---");
  const idxBefore = m.cumulativeFundingIndex;
  const cfIx = createComputeFundingInstruction(MARKET_INDEX, mf.pythFeed, mf.switchboardFeed, mf.programId);
  try {
    const tx = new Transaction().add(cfIx);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
      skipPreflight: false,
      commitment: "confirmed",
    });
    const after = await readMarket(conn, mf.market);
    log(`  compute_funding SUCCESS sig=${sig}`);
    log(`  cumulative_funding_index: ${idxBefore} -> ${after.cumulativeFundingIndex} (delta=${after.cumulativeFundingIndex - idxBefore})`);
    log(`  last_funding_ts -> ${after.lastFundingTs}`);
    if (after.cumulativeFundingIndex !== idxBefore) {
      log(`  ✓✓ FUNDING ACCRUED on-chain. Index moved.`);
    } else {
      log(`  ⚠ compute_funding succeeded but index did not move (unexpected).`);
    }
  } catch (e: any) {
    const c = classifySendError(e);
    const label = c.code !== null ? `custom ${c.code} (${errName(c.code)})` : `non-custom (${e?.message ?? e})`;
    log(`  compute_funding REVERTED: ${label}`);
    if (c.code === 0x100 + ERR_NAMES.indexOf("OracleStale")) {
      log(`    Interpretation: with twap_count=${m.twapCount}, the OracleStale now comes from the`);
      log(`    dual-oracle freshness check (Pyth/Switchboard publish age > 60s on devnet), not the empty TWAP.`);
    } else if (c.code === 0x100 + ERR_NAMES.indexOf("OracleDisagreement")) {
      log(`    Interpretation: Pyth and Switchboard diverged > 2%; market entered restricted_mode.`);
    } else if (c.code === 0x100 + ERR_NAMES.indexOf("InvalidSwitchboardFeed")) {
      log(`    Interpretation: Switchboard feed account is unusable on devnet (< 104 bytes / wrong layout).`);
    } else if (c.code === 0x100 + ERR_NAMES.indexOf("InvalidExpiryTimestamp")) {
      log(`    Interpretation: funding interval not yet elapsed since last_funding_ts.`);
    }
  }

  log("\n=== Harness complete ===");
}

main().catch((e) => {
  console.error("Harness crashed:", e);
  process.exit(1);
});
