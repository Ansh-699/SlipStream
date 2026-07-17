import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

import { loadKeypair, log } from "./connection";
import { getKeeperAddresses } from "./manifest";
import { DELEGATION_PROGRAM_ID, PRICE_SCALE } from "../../../client/src/constants";
import {
  findUserAccountPda,
  findPositionPda,
  findTradingCreditPda,
} from "../../../client/src/pda";
import {
  createInitializeUserInstruction,
  createDepositCollateralInstruction,
  createInitializeTradingCreditInstruction,
  createFundTradingCreditInstruction,
  createDelegateTradingCreditInstruction,
  createInitializePositionInstruction,
} from "../../../client/src/instructions";
import { decodeTradingCredit, type TradingCredit } from "../../../client/src/accounts";

/**
 * Persistent bot-wallet management for the Slipstream simulation bots.
 *
 * SOL HYGIENE (CRITICAL): we keep a SMALL, FIXED set of bot keypairs on disk at
 * `keepers/.bot-keys/*.json` (gitignored) and REUSE them across runs. Each wallet
 * is topped up to a tiny SOL target ONLY when it falls below it (faucet first,
 * then a minimal operator System transfer for the shortfall — the devnet faucet
 * 429s, so we mirror tests/integration/setup.ts). Rent paid on a prior run is
 * reused rather than stranded on a throwaway key. USDC is free (the operator is
 * the live mint authority) so it is minted as needed, but only when a wallet's
 * trading credit has not yet been provisioned.
 *
 * The trader-setup sequence is the same one proven in the integration tests:
 *   initialize_user -> deposit_collateral
 *     -> initialize_trading_credit -> fund_trading_credit -> delegate_trading_credit
 *     -> initialize_position
 * Each step is skipped when already done (account existence / credit delegation),
 * so re-running bot-setup is cheap and idempotent.
 */

// --------------------------------------------------------------------------
// Config (env-overridable). Defaults are sized for the LIVE Pyth mid (~$80-150).
//
// NOTE ON CREDIT SIZE: the on-chain margin math is
//   notional = size_atoms(9dp) * price(6dp) / 1e6     (see place_order.rs)
//   margin   = notional / max_leverage
// Because base size carries 9 decimals while credit is 6-decimal USDC, the margin
// reserved per resting lot is ~1000x its "human" notional. One 0.1-SOL lot at
// ~$82 reserves ~411e6 credit atoms ("$411"), so a small two-sided ladder needs a
// few thousand "USDC" of credit. USDC is minted free from the operator (mint
// authority); only SOL is scarce, so we fund credit generously to avoid
// InsufficientCredit while keeping SOL tiny. Override via env if desired.
// --------------------------------------------------------------------------
export const BOT_KEYS_DIR = path.resolve(__dirname, "../../.bot-keys");

/** Tiny per-wallet SOL target — enough for PDA rents + many tx fees. */
export const BOT_SOL_TARGET = Number(process.env.BOT_SOL_TARGET || "0.08");

/** USDC (6-dp atoms) minted to the bot ATA when first provisioning. Default $8000. */
export const BOT_MINT_USDC = BigInt(process.env.BOT_MINT_USDC || "8000000000");
/** USDC deposited as collateral. Default $6000. */
export const BOT_DEPOSIT_USDC = BigInt(process.env.BOT_DEPOSIT_USDC || "6000000000");
/** USDC moved from free collateral into trading credit. Default $5000. */
export const BOT_CREDIT_USDC = BigInt(process.env.BOT_CREDIT_USDC || "5000000000");

export type BotRole = "mm" | "taker";

export interface BotWallet {
  name: string; // e.g. "mm-0", "taker-1"
  role: BotRole;
  keypair: Keypair;
}

export interface BotWalletState {
  name: string;
  role: BotRole;
  pubkey: string;
  solBalance: number;
  userInitialized: boolean;
  creditDelegated: boolean;
  creditAvailable: bigint;
  creditTotal: bigint;
  positionInitialized: boolean;
}

// --------------------------------------------------------------------------
// Keypair persistence
// --------------------------------------------------------------------------

function botKeyPath(name: string): string {
  return path.join(BOT_KEYS_DIR, `${name}.json`);
}

/** Load a named bot keypair, generating + persisting it on first use. */
export function loadOrCreateBotKeypair(name: string): Keypair {
  if (!fs.existsSync(BOT_KEYS_DIR)) {
    fs.mkdirSync(BOT_KEYS_DIR, { recursive: true });
  }
  const kpPath = botKeyPath(name);
  if (fs.existsSync(kpPath)) {
    try {
      const secret = Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf-8")));
      return Keypair.fromSecretKey(secret);
    } catch {
      /* fall through to regenerate a corrupt file */
    }
  }
  const kp = Keypair.generate();
  fs.writeFileSync(kpPath, JSON.stringify(Array.from(kp.secretKey)));
  log("bot-wallets", `created persistent bot key ${name} -> ${kp.publicKey.toBase58()}`);
  return kp;
}

/** Resolve the configured bot-wallet counts from env (default 2 MM + 2 takers). */
export function getBotCounts(): { mm: number; taker: number } {
  const mm = Math.max(0, parseInt(process.env.BOT_MM_COUNT || "2", 10));
  const taker = Math.max(0, parseInt(process.env.BOT_TAKER_COUNT || "2", 10));
  return { mm, taker };
}

/** Load (create on first use) the full configured set of bot wallets. */
export function loadBotWallets(counts = getBotCounts()): BotWallet[] {
  const wallets: BotWallet[] = [];
  for (let i = 0; i < counts.mm; i++) {
    const name = `mm-${i}`;
    wallets.push({ name, role: "mm", keypair: loadOrCreateBotKeypair(name) });
  }
  for (let i = 0; i < counts.taker; i++) {
    const name = `taker-${i}`;
    wallets.push({ name, role: "taker", keypair: loadOrCreateBotKeypair(name) });
  }
  return wallets;
}

// --------------------------------------------------------------------------
// SOL top-up (faucet first, operator System-transfer fallback, top-up only)
// --------------------------------------------------------------------------

/**
 * Ensure `pubkey` holds at least `targetSol`. No-op if already at/above target
 * (conserves operator SOL on re-runs). Tries the faucet, then transfers exactly
 * the shortfall from the operator.
 */
export async function ensureMinSol(
  base: Connection,
  operator: Keypair,
  pubkey: PublicKey,
  targetSol: number = BOT_SOL_TARGET
): Promise<{ toppedUp: boolean; lamports: number }> {
  const targetLamports = Math.floor(targetSol * 1e9);
  const bal = await base.getBalance(pubkey);
  if (bal >= targetLamports) {
    return { toppedUp: false, lamports: 0 };
  }
  const shortfall = targetLamports - bal;

  // Faucet first (free); fall back to a minimal operator transfer for the shortfall.
  try {
    const sig = await base.requestAirdrop(pubkey, shortfall);
    await base.confirmTransaction(sig, "confirmed");
    log("bot-wallets", `topped up ${pubkey.toBase58().slice(0, 8)}… +${(shortfall / 1e9).toFixed(4)} SOL (faucet)`);
    return { toppedUp: true, lamports: shortfall };
  } catch {
    /* faucet rate-limited; fall back to operator */
  }

  if (pubkey.equals(operator.publicKey)) return { toppedUp: false, lamports: 0 };
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: operator.publicKey,
      toPubkey: pubkey,
      lamports: shortfall,
    })
  );
  const sig = await sendAndConfirmTransaction(base, tx, [operator]);
  log(
    "bot-wallets",
    `topped up ${pubkey.toBase58().slice(0, 8)}… +${(shortfall / 1e9).toFixed(4)} SOL (operator ${sig.slice(0, 8)}…)`
  );
  return { toppedUp: true, lamports: shortfall };
}

// --------------------------------------------------------------------------
// Margin helper (mirror of place_order.rs / fixed_point.rs)
// --------------------------------------------------------------------------

/** Margin (credit atoms) reserved per resting `lots` at `price6`, at `maxLeverage`.
 *  MUST match on-chain `compute_notional` (math/fixed_point.rs): size carries 9
 *  base decimals, so notional = size*price / BASE_SCALE (1e9) — NOT PRICE_SCALE.
 *  (Dividing by PRICE_SCALE was the old 1000x-too-high estimate that, post the
 *  on-chain decimal fix, made the bot drastically under-quote depth.) */
export function marginForOrder(
  lotSize: bigint,
  lots: number,
  price6: bigint,
  maxLeverage: number
): bigint {
  const BASE_SCALE = 1_000_000_000n; // 1e9, base-asset (size) scale
  const size = lotSize * BigInt(lots);
  const notional = (size * price6) / BASE_SCALE;
  return notional / BigInt(maxLeverage);
}

// --------------------------------------------------------------------------
// Account-state reads
// --------------------------------------------------------------------------

async function accountExists(conn: Connection, pk: PublicKey): Promise<boolean> {
  const info = await conn.getAccountInfo(pk);
  return !!(info && info.data.length > 0);
}

async function isCreditDelegated(base: Connection, creditPda: PublicKey): Promise<boolean> {
  const info = await base.getAccountInfo(creditPda);
  return info?.owner.equals(DELEGATION_PROGRAM_ID) ?? false;
}

/** Read the TradingCredit (from the ER when delegated, else the base layer). */
export async function readTradingCredit(
  base: Connection,
  er: Connection,
  owner: PublicKey,
  marketIndex: number
): Promise<TradingCredit | null> {
  const [creditPda] = findTradingCreditPda(owner, marketIndex);
  const delegated = await isCreditDelegated(base, creditPda);
  const conn = delegated ? er : base;
  const info = await conn.getAccountInfo(creditPda);
  if (!info || info.data.length === 0) return null;
  try {
    return decodeTradingCredit(info.data as Buffer);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Idempotent trader setup
// --------------------------------------------------------------------------

async function sendL1(
  base: Connection,
  step: string,
  ixs: import("@solana/web3.js").TransactionInstruction[],
  signers: Keypair[]
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  try {
    return await sendAndConfirmTransaction(base, tx, signers, {
      commitment: "confirmed",
      skipPreflight: false,
    });
  } catch (e: any) {
    const logs = Array.isArray(e?.logs) ? e.logs.join("\n") : "";
    throw new Error(`[${step}] L1 tx failed: ${e?.message ?? e}\n${logs}`);
  }
}

/**
 * Idempotently provision one bot wallet for trading: top up SOL, then run the
 * init_user -> deposit -> init/fund/delegate credit -> init_position sequence,
 * skipping any already-completed step. Returns the wallet's resulting state.
 */
export async function setupBotWallet(
  base: Connection,
  er: Connection,
  operator: Keypair,
  wallet: BotWallet
): Promise<BotWalletState> {
  const addrs = getKeeperAddresses();
  const marketIndex = addrs.marketIndex;
  const owner = wallet.keypair.publicKey;
  const tag = `${wallet.name}`;

  log("bot-setup", `--- provisioning ${tag} ${owner.toBase58()} ---`);

  // 1. SOL top-up (only if below target).
  await ensureMinSol(base, operator, owner, BOT_SOL_TARGET);

  const [userPda] = findUserAccountPda(owner);
  const [creditPda] = findTradingCreditPda(owner, marketIndex);
  const [positionPda] = findPositionPda(owner, marketIndex);

  // 2. initialize_user (skip if present).
  const userInit = await accountExists(base, userPda);
  if (!userInit) {
    const sig = await sendL1(base, `${tag}:init_user`, [createInitializeUserInstruction(owner)], [wallet.keypair]);
    log("bot-setup", `${tag} init_user ${sig.slice(0, 16)}…`);
  } else {
    log("bot-setup", `${tag} user account present — skip init_user`);
  }

  // 3. Credit lifecycle (skip entirely if already delegated to the ER).
  const creditDelegated = await isCreditDelegated(base, creditPda);
  if (creditDelegated) {
    log("bot-setup", `${tag} trading_credit already delegated — skip mint/deposit/fund/delegate`);
  } else {
    // 3a. Ensure ATA + mint USDC (free; operator is the live mint authority).
    const mint = await resolveUsdcMint(base);
    const botAta = await getOrCreateAssociatedTokenAccount(base, operator, mint, owner);
    await mintTo(base, operator, mint, botAta.address, operator.publicKey, BOT_MINT_USDC);
    log("bot-setup", `${tag} minted ${fmtUsdc(BOT_MINT_USDC)} USDC to ATA ${botAta.address.toBase58().slice(0, 8)}…`);

    // 3b. deposit_collateral.
    const sigDep = await sendL1(
      base,
      `${tag}:deposit_collateral`,
      [createDepositCollateralInstruction(owner, botAta.address, addrs.usdcVault, BOT_DEPOSIT_USDC)],
      [wallet.keypair]
    );
    log("bot-setup", `${tag} deposit ${fmtUsdc(BOT_DEPOSIT_USDC)} USDC ${sigDep.slice(0, 16)}…`);

    // 3c. initialize_trading_credit (skip if account already exists).
    if (!(await accountExists(base, creditPda))) {
      await sendL1(
        base,
        `${tag}:init_trading_credit`,
        [createInitializeTradingCreditInstruction(owner, marketIndex)],
        [wallet.keypair]
      );
    }
    // 3d. fund_trading_credit.
    const sigFund = await sendL1(
      base,
      `${tag}:fund_trading_credit`,
      [createFundTradingCreditInstruction(owner, marketIndex, BOT_CREDIT_USDC)],
      [wallet.keypair]
    );
    log("bot-setup", `${tag} fund credit ${fmtUsdc(BOT_CREDIT_USDC)} USDC ${sigFund.slice(0, 16)}…`);

    // 3e. delegate_trading_credit (to the ER).
    const sigDel = await sendL1(
      base,
      `${tag}:delegate_trading_credit`,
      [createDelegateTradingCreditInstruction(owner, marketIndex)],
      [wallet.keypair]
    );
    log("bot-setup", `${tag} delegate credit ${sigDel.slice(0, 16)}…`);
  }

  // 4. initialize_position (so settle_trades can open into it).
  const posInit = await accountExists(base, positionPda);
  if (!posInit) {
    const sig = await sendL1(
      base,
      `${tag}:initialize_position`,
      [createInitializePositionInstruction(owner, marketIndex)],
      [wallet.keypair]
    );
    log("bot-setup", `${tag} init_position ${sig.slice(0, 16)}…`);
  } else {
    log("bot-setup", `${tag} position present — skip init_position`);
  }

  // Summary read-back.
  const solBalance = (await base.getBalance(owner)) / 1e9;
  const credit = await readTradingCredit(base, er, owner, marketIndex);
  const state: BotWalletState = {
    name: wallet.name,
    role: wallet.role,
    pubkey: owner.toBase58(),
    solBalance,
    userInitialized: await accountExists(base, userPda),
    creditDelegated: await isCreditDelegated(base, creditPda),
    creditAvailable: credit?.available ?? 0n,
    creditTotal: credit?.credit ?? 0n,
    positionInitialized: await accountExists(base, positionPda),
  };
  log(
    "bot-setup",
    `${tag} READY sol=${state.solBalance.toFixed(4)} credit=${fmtUsdc(state.creditTotal)} avail=${fmtUsdc(state.creditAvailable)} delegated=${state.creditDelegated} pos=${state.positionInitialized}`
  );
  return state;
}

// --------------------------------------------------------------------------
// USDC mint resolution
// --------------------------------------------------------------------------

let cachedMint: PublicKey | null = null;

/** The live USDC mint from deploy.json (the operator is its mint authority). */
async function resolveUsdcMint(_base: Connection): Promise<PublicKey> {
  if (cachedMint) return cachedMint;
  const env = process.env.USDC_MINT;
  if (env) {
    cachedMint = new PublicKey(env);
    return cachedMint;
  }
  // Read straight from the deploy manifest (the keeper-addresses resolver does
  // not carry the mint, only the vault).
  const { loadManifest, MANIFEST_PATH } = await import("./manifest");
  const m = loadManifest();
  if (!m.usdcMint) throw new Error(`usdcMint missing from ${MANIFEST_PATH}`);
  cachedMint = new PublicKey(m.usdcMint);
  return cachedMint;
}

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------

/** Format 6-dp USDC atoms as a $ string. */
export function fmtUsdc(atoms: bigint): string {
  const neg = atoms < 0n;
  const a = neg ? -atoms : atoms;
  const whole = a / BigInt(PRICE_SCALE);
  const frac = (a % BigInt(PRICE_SCALE)).toString().padStart(6, "0").slice(0, 2);
  return `${neg ? "-" : ""}$${whole.toString()}.${frac}`;
}

/** Load the operator (deploy authority + USDC mint authority). */
export function getOperator(): Keypair {
  return loadKeypair();
}
