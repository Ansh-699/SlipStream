import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * Shared transaction helpers for the simulation bots.
 *
 * The bots place/cancel orders on the MagicBlock Ephemeral Rollup (ER), which
 * needs the raw `sendRawTransaction` + `confirmTransaction` flow (the same one
 * the integration tests + settlement keeper use), not the base-layer
 * `sendAndConfirm`. They also classify on-chain reverts by the program's custom
 * error code so the bots can back off gracefully and report honestly
 * (OrderBookFull / InsufficientCredit / PostOnlyWouldCross / SlippageExceeded …).
 */

// Mirror of programs/slipstream/src/error.rs (base 0x100, in declaration order).
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

export interface ClassifiedError {
  /** Custom program error code (e.g. 0x115), or null if not a program revert. */
  code: number | null;
  /** Human name from error.rs (e.g. "PostOnlyWouldCross"), or null. */
  name: string | null;
  /** Raw message + logs for debugging. */
  raw: string;
}

/** Map a custom program error code to its name from error.rs. */
export function errName(code: number): string {
  const i = code - ERROR_BASE;
  return i >= 0 && i < ERR_NAMES.length ? ERR_NAMES[i] : `unknown(0x${code.toString(16)})`;
}

/** Readable text for any thrown value. `String(plainObject)` is "[object
 *  Object]", which is what the keepers were logging for non-Error throws. */
export function errText(e: any): string {
  if (e == null) return String(e);
  if (typeof e === "string") return e;
  if (typeof e.message === "string" && e.message.length > 0) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Extract the custom program error code (if any) from a thrown send error. */
export function classifyTxError(e: any): ClassifiedError {
  const logs: string[] = Array.isArray(e?.logs) ? e.logs : [];
  const hay = [errText(e), ...logs].join("\n");
  const hex = hay.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hex) {
    const code = parseInt(hex[1], 16);
    return { code, name: errName(code), raw: hay };
  }
  const dec = hay.match(/Custom\((\d+)\)/);
  if (dec) {
    const code = parseInt(dec[1], 10);
    return { code, name: errName(code), raw: hay };
  }
  return { code: null, name: null, raw: hay };
}

/**
 * Send + confirm a single instruction on the ER (raw tx, skipPreflight). Throws
 * an error whose `.code`/`.name` are the classified program error when the ER
 * reports a transaction error, so callers can branch on it.
 */
export async function sendErTx(
  er: Connection,
  ix: TransactionInstruction,
  payer: Keypair,
  opts?: { computeUnits?: number }
): Promise<string> {
  const tx = new Transaction();
  // The ER honors ComputeBudget (verified live). Instructions that scan the
  // fill ring (mirror_fills) need more than the 200k default once the ring
  // carries a backlog.
  if (opts?.computeUnits) {
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits }));
  }
  tx.add(ix);
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
    const err: any = new Error(
      `ER tx ${sig} failed: ${JSON.stringify(conf.value.err)}\n${logs}`
    );
    const classified = classifyTxError({ message: logs, logs: [logs] });
    err.code = classified.code;
    err.name = classified.name ?? "Error";
    err.sig = sig;
    throw err;
  }
  return sig;
}
