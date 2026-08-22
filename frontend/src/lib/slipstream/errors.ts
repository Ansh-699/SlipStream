/**
 * One place that turns any failure into a sentence a trader can act on.
 *
 * There used to be two half-decoders that never met:
 *
 *   humanizeError      (use-session.ts, module-private) — knew about wallet and
 *                      RPC failures, knew NOTHING about program error codes.
 *   decodeProgramError (order-form.tsx, module-private) — knew all 56 program
 *                      error names, knew nothing about wallet or network
 *                      failures.
 *
 * Neither was exported, so the five most frequent error surfaces in the app —
 * Close, Flatten, Cancel order, Set SL/TP, Cancel trigger — reached neither and
 * printed the raw exception.
 *
 * Worse, the program-code decoder could not read its own codebase's errors.
 * lib/confirm.ts throws `Transaction failed: {"InstructionError":[0,{"Custom":6152}]}`
 * and the two patterns it matched were `custom program error: 0x…` and
 * `Custom(…)` — neither matches JSON's `"Custom":6152`. So every on-chain
 * failure that arrived through confirmSignature bypassed the entire table.
 */

/** Ordinals of `SlipstreamError`, which is `#[repr(u32)]` based at 0x100. */
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
  "LiquidationIntentNotReady", "GlobalPaused", "FillMarginExceeded", "TriggerConditionNotMet",
  "SelfTrade", "PositionStillOpen",
] as const;

/** What the trader should DO about it, for the ones they can actually hit. */
const ERR_ADVICE: Record<string, string> = {
  InsufficientCredit: "Not enough trading credit — add credit in the Session panel or reduce the size.",
  InsufficientCollateral: "Not enough collateral for this order.",
  InsufficientMargin: "Not enough margin — lower the size or the leverage.",
  SlippageExceeded: "The book moved past your slippage bound. Retry or widen it.",
  PostOnlyWouldCross: "A post-only order would have crossed the book. Adjust the price.",
  FokCannotFill: "Fill-or-kill could not be filled in full at that price.",
  TickSizeViolation: "Price must be a multiple of the $0.001 tick.",
  LotSizeViolation: "Size must be a whole number of 0.1 SOL lots.",
  MaxOrdersPerUser: "You already have the maximum number of resting orders. Cancel one first.",
  OracleStale: "The oracle price is stale — the keepers are behind. Try again shortly.",
  MarketPaused: "The market is paused.",
  GlobalPaused: "Trading is globally paused.",
  CircuitBreakerTripped: "The circuit breaker is active — the TWAP has diverged. It clears itself as the crank catches up.",
  RestrictedMode: "The market is in closes-only mode after an oracle disagreement.",
  SelfTrade: "That order would have traded against your own resting order.",
  PendingFillsExist: "You have unsettled fills — wait for settlement, then retry.",
  InvalidAuthority: "Your session key is not authorised (it may have expired). Press “New session key”.",
  HealthFactorAboveThreshold: "The position is not liquidatable.",
  PositionNotFound: "No open position for this market.",
  OrderNotFound: "That order is no longer on the book — it may have filled or been cancelled.",
};

/**
 * Extract a Slipstream program error name from any error shape we can produce.
 * Returns null when the failure is not an on-chain custom error.
 */
export function decodeProgramError(input: unknown): string | null {
  const anyErr = input as { message?: string; logs?: string[] } | null;
  const logs = Array.isArray(anyErr?.logs) ? anyErr!.logs! : [];
  const hay = [anyErr?.message ?? String(input), ...logs].join("\n");

  const hex = hay.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  const dec = hay.match(/Custom\((\d+)\)/);
  // The JSON form that lib/confirm.ts itself throws. Its absence meant this
  // decoder could not read the errors its own codebase produced.
  const json = hay.match(/"Custom"\s*:\s*(\d+)/);

  const code = hex
    ? parseInt(hex[1], 16)
    : dec
      ? parseInt(dec[1], 10)
      : json
        ? parseInt(json[1], 10)
        : null;
  if (code === null) return null;

  const idx = code - 0x100;
  return idx >= 0 && idx < ERR_NAMES.length ? ERR_NAMES[idx] : `custom 0x${code.toString(16)}`;
}

/** True for a failure that happened before anything was submitted. */
function isNetworkFailure(hay: string): boolean {
  return /failed to fetch|load failed|networkerror|err_insufficient_resources|err_network|err_connection|fetch failed|\b(429|502|503|504)\b|too many requests|service unavailable/i.test(
    hay
  );
}

/**
 * Turn any thrown value into one actionable sentence.
 *
 * Order matters: a program error code is the most specific thing we can know,
 * so it wins over the generic text patterns underneath it.
 */
export function humanizeError(err: unknown): string {
  const anyErr = err as { message?: string; logs?: string[]; name?: string } | null;
  const logs = Array.isArray(anyErr?.logs) ? anyErr!.logs! : [];
  const hay = [anyErr?.message ?? String(err), ...logs].join("\n");

  const program = decodeProgramError(err);
  if (program) {
    const advice = ERR_ADVICE[program];
    return advice ? `${advice} (${program})` : `Rejected on chain: ${program}.`;
  }

  if (/User rejected|rejected the request|cancelled|declined/i.test(hay)) {
    return "You rejected the transaction in your wallet.";
  }
  if (isNetworkFailure(hay)) {
    // "Nothing was sent" is the part that matters: a transport failure before
    // submission is safe to retry, and the user has no way to know that.
    return "Can't reach Solana right now — nothing was sent. Check your connection and retry.";
  }
  if (/insufficient (lamports|funds for rent|funds)/i.test(hay)) {
    return "Not enough devnet SOL to pay fees and account rent. Airdrop some SOL and retry.";
  }
  if (/could not find account|account does not exist|invalid account owner|TokenAccountNotFound/i.test(hay)) {
    return "You have no test USDC yet. Click “Get test USDC” first.";
  }
  // \b0x1\b, not /0x1/: the loose form substring-matched EVERY Slipstream error,
  // which are based at 0x100 — so 0x1808 plus an SPL "Instruction: Transfer"
  // log line reported an unrelated program failure as a USDC balance problem.
  if (/\b0x1\b/.test(hay) && /transfer/i.test(hay)) {
    return "USDC transfer failed — your balance is lower than the deposit amount.";
  }
  if (/blockhash|expired/i.test(hay)) {
    return "The network was slow and the transaction expired before it landed. Please retry.";
  }
  if (/timed out|timeout/i.test(hay)) {
    // Deliberately NOT "it failed" — a confirm timeout says nothing about
    // whether the transaction landed.
    return "Timed out waiting for confirmation. The transaction may still land — check before retrying.";
  }
  return anyErr?.message ?? String(err);
}
