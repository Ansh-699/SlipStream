import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getBaseConnection, loadKeypair, sendAndConfirm, sleep, log } from "./shared/connection";
import { fetchMarket, fetchAllPositions } from "./shared/accounts";
import { getKeeperAddresses } from "./shared/manifest";
import { readPythPrice } from "./shared/pyth";
import {
  createLiquidatePositionInstruction,
  createExecuteTriggerInstruction,
} from "../../client/src/instructions";
import { PRICE_SCALE, DISC_TRIGGER_ORDER } from "../../client/src/constants";
import { decodeTriggerOrder, TRIGGER_ORDER_SIZE } from "../../client/src/accounts";
import bs58 from "bs58";

const SWITCHBOARD_SOL_USD = new PublicKey(
  process.env.SWITCHBOARD_FEED || "GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR"
);
import { computeTwap, decodePosition, type Position } from "../../client/src/accounts";

const MARKET_INDEX = 0;
const POLL_INTERVAL_MS = 5_000;
// Mirror programs/slipstream/src/oracle.rs's MAX_STALENESS_SECS: a Pyth
// reading older than this is not something the on-chain check would accept
// either, so treat it the same as "unavailable" and fall back to TWAP.
const PYTH_MAX_STALENESS_SECS = 60;
// Mirror programs/slipstream/src/math/fixed_point.rs's FUNDING_SCALE (18dp).
const FUNDING_SCALE = 1_000_000_000_000_000_000n;

/** Mirror math/funding.rs::compute_funding_payment. Positive = position PAYS. */
function computeFundingPayment(
  positionSize: bigint,
  currentFundingIndex: bigint,
  snapshotFundingIndex: bigint,
  markPrice: bigint
): bigint {
  if (positionSize === 0n) return 0n;
  const indexDelta = currentFundingIndex - snapshotFundingIndex;
  const absSize = positionSize < 0n ? -positionSize : positionSize;
  // size is 9-dp base atoms -> notional in 6-dp quote, matching compute_notional.
  const absNotional = (absSize * markPrice) / 1_000_000_000n;
  const signedNotional = positionSize > 0n ? absNotional : -absNotional;
  return (signedNotional * indexDelta) / FUNDING_SCALE;
}

/**
 * Mirrors programs/slipstream/src/math/fixed_point.rs::compute_health_factor,
 * INCLUDING accrued funding (accrued_funding = -funding_payment, since a
 * positive funding_payment means the position OWES it — the same sign flip
 * liquidate_position.rs applies before calling the on-chain version). Health
 * >= 1.0 mirrors HEALTH_FACTOR_LIQUIDATION_THRESHOLD (1_000_000 in 6dp).
 *
 * Previously this omitted funding entirely, so a position kept artificially
 * "healthy" by an unrealized funding debt (or flagged unfairly by unrealized
 * funding owed TO it) disagreed with the program's own gate.
 */
function computeHealthFactor(
  pos: Position,
  markPrice: bigint,
  maxLeverage: number,
  cumulativeFundingIndex: bigint
): number {
  if (maxLeverage <= 0) return Infinity; // corrupt/unset market — treat as not liquidatable

  const absSize = pos.size < 0n ? -pos.size : pos.size;
  // size is 9-dp base atoms: divide by BASE_SCALE (1e9), matching on-chain
  // compute_notional. The previous PRICE_SCALE (1e6) divisor inflated notional
  // x1000, flagging every healthy position as liquidatable — the program
  // rejected each attempt with HealthFactorAboveThreshold (8k+ failed txs).
  const notional = (absSize * markPrice) / 1_000_000_000n;
  const initialMargin = notional / BigInt(maxLeverage);
  const maintenanceMargin = initialMargin / 2n;

  if (maintenanceMargin === 0n) return Infinity;

  const priceDiff = markPrice - pos.entryPrice;
  const signedSize = pos.size;
  // Same 9-dp size scale: /1e9 keeps uPnL in 6-dp USD like collateral
  // (mirrors on-chain compute_unrealized_pnl).
  const unrealizedPnl = (signedSize * priceDiff) / 1_000_000_000n;

  const fundingPayment = computeFundingPayment(
    pos.size,
    cumulativeFundingIndex,
    pos.fundingIndexSnapshot,
    markPrice
  );

  const equity = BigInt(pos.collateral) + unrealizedPnl - fundingPayment;
  return Number(equity * 1_000_000n / maintenanceMargin) / 1_000_000;
}

/**
 * Scan and execute SL/TP TriggerOrders. Permissionless: execute_trigger closes
 * the owner's position once the mark price crosses the trigger, and pays the
 * trigger account's rent to this keeper. Stale triggers (position already flat)
 * are also fired — the program garbage-collects them, rent back to the owner.
 */
async function executeTriggers(
  connection: Connection,
  keeper: Keypair,
  programId: PublicKey,
  markPrice: bigint
): Promise<void> {
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      { dataSize: TRIGGER_ORDER_SIZE },
      { memcmp: { offset: 0, bytes: bs58.encode([DISC_TRIGGER_ORDER]) } },
    ],
  });

  for (const { pubkey, account } of accounts) {
    let trig;
    try {
      trig = decodeTriggerOrder(account.data as Buffer);
    } catch {
      continue;
    }
    if (trig.marketIndex !== MARKET_INDEX) continue;

    const met = trig.triggerAbove
      ? markPrice >= trig.triggerPrice
      : markPrice <= trig.triggerPrice;
    if (!met) continue;

    try {
      const ix = createExecuteTriggerInstruction(
        trig.owner,
        trig.marketIndex,
        trig.kind,
        keeper.publicKey,
        programId
      );
      const sig = await sendAndConfirm(connection, new Transaction().add(ix), [keeper]);
      log(
        "LIQUIDATION",
        `Executed ${trig.kind === 0 ? "SL" : "TP"} trigger ${pubkey.toBase58()} ` +
          `(owner ${trig.owner.toBase58()}, price ${trig.triggerPrice}), sig=${sig}`
      );
    } catch (err: any) {
      // TriggerConditionNotMet (0x135) just means the on-chain mark (crank
      // cadence) hasn't crossed yet — quiet retry next cycle.
      if (!String(err?.message ?? err).includes("0x135")) {
        log("LIQUIDATION", `Trigger ${pubkey.toBase58()} failed: ${err?.message ?? err}`);
      }
    }
  }
}

async function main() {
  const connection = getBaseConnection();
  const keeper = loadKeypair();
  // BUG 1 fix: use the LIVE Pyth feed from the deploy manifest, not the legacy
  // frozen PYTH_SOL_USD_DEVNET constant.
  const pythFeed = getKeeperAddresses().pythFeed;
  log("LIQUIDATION", `Starting liquidation keeper with address ${keeper.publicKey.toBase58()}`);
  log("LIQUIDATION", `Using Pyth feed ${pythFeed.toBase58()}`);

  let consecutiveErrors = 0;
  // The program is the health authority. When it rejects a liquidation with
  // HealthFactorAboveThreshold (0x11a), our local estimate disagrees. Two cases:
  //  - a real position momentarily on the edge (worth re-checking soon), or
  //  - an ORPHANED corrupt position from early testing (entry=$1, ×1000-scaled
  //    collateral) whose owner key is gone, so it can never be closed AND the
  //    program's own math on the corrupt data always reads "healthy".
  // Back off with escalation: each reject doubles the cooldown (10m, 20m, 40m,
  // ...) so a genuinely borderline LIVE position gets several increasingly
  // patient re-checks — not just one 10-minute grace period — before this
  // keeper gives up on it. Only after REJECT_GIVE_UP_COUNT straight rejects
  // (now with a live-oracle + funding-aware health model, a real disagreement
  // that persistent is a strong corruption signal) do we stop attempting, and
  // only for GIVE_UP_MS (24h, not a blanket 30-day blacklist on a possibly-live
  // position) — long enough to silence log/tx spam, short enough that a truly
  // live position isn't locked out of liquidation for a month if the model is
  // ever wrong again.
  const REJECT_COOLDOWN_MS = 10 * 60_000;
  const REJECT_GIVE_UP_COUNT = 5;
  const REJECT_COOLDOWN_CAP_MS = 60 * 60_000;
  const GIVE_UP_MS = 24 * 60 * 60_000;
  const rejectedUntil = new Map<string, number>();
  const rejectCount = new Map<string, number>();

  while (true) {
    try {
      const market = await fetchMarket(connection, MARKET_INDEX);
      if (!market) {
        log("LIQUIDATION", "Market not found, waiting...");
        await sleep(5_000);
        continue;
      }

      if (market.circuitBreakerActive) {
        log("LIQUIDATION", "Market paused, skipping");
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // Prefer a LIVE Pyth read for the health pre-filter — it's what
      // liquidate_position.rs itself actually gates on (apply_dual_oracle reads
      // Pyth+Switchboard fresh at call time, max 60s stale). The local TWAP
      // ring (crank_twap-fed, up to 225 samples) can lag by up to ~30 minutes
      // behind that, which was the actual root cause of "our estimate disagrees
      // with the program's" cases this backoff logic exists to paper over.
      // TWAP is kept only as a fallback for when the feed is unreadable.
      let markPriceBigint: bigint;
      try {
        const pyth = await readPythPrice(connection, pythFeed);
        if (pyth.ageSecs > PYTH_MAX_STALENESS_SECS) {
          throw new Error(`Pyth reading stale (${pyth.ageSecs}s)`);
        }
        markPriceBigint = pyth.price6;
      } catch (e: any) {
        const twapPrice = computeTwap(market);
        if (!twapPrice) {
          log("LIQUIDATION", `No usable price (Pyth: ${e?.message ?? e}; no TWAP either), skipping`);
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        log("LIQUIDATION", `Pyth unavailable (${e?.message ?? e}); falling back to TWAP`);
        markPriceBigint = BigInt(Math.round(twapPrice * PRICE_SCALE));
      }

      const positions = await fetchAllPositions(connection, MARKET_INDEX);
      let liquidated = 0;

      for (const { pubkey, account: pos } of positions) {
        if (pos.size === 0n) continue;

        const health = computeHealthFactor(
          pos,
          markPriceBigint,
          market.maxLeverage,
          market.cumulativeFundingIndex
        );
        if (health >= 1.0) continue;

        const pausedUntil = rejectedUntil.get(pubkey.toBase58());
        if (pausedUntil !== undefined && Date.now() < pausedUntil) continue;

        log(
          "LIQUIDATION",
          `Liquidatable position found: ${pubkey.toBase58()}, health=${health.toFixed(4)}`
        );

        try {
          const posOwner = pos.owner;
          const ix = createLiquidatePositionInstruction(
            keeper.publicKey,
            new PublicKey(posOwner),
            MARKET_INDEX,
            pythFeed,
            SWITCHBOARD_SOL_USD,
          );
          const tx = new Transaction().add(ix);
          const sig = await sendAndConfirm(connection, tx, [keeper]);
          // liquidate_position now succeeds (rather than reverting) on the
          // pending-fills grace-window path too — it may have only started or
          // extended the 60s window without actually zeroing the position.
          // Re-check so this log (and the cycle summary) reflect what actually
          // happened instead of assuming every non-throwing call liquidated.
          const after = await connection.getAccountInfo(pubkey);
          const actuallyLiquidated = !!after && decodePosition(after.data).size === 0n;
          if (actuallyLiquidated) {
            log("LIQUIDATION", `Liquidated ${pubkey.toBase58()}, sig=${sig}`);
            liquidated++;
          } else {
            log("LIQUIDATION", `${pubkey.toBase58()} grace window started/pending, sig=${sig}`);
          }
        } catch (err: any) {
          if (String(err?.message ?? err).includes("0x11a")) {
            const key = pubkey.toBase58();
            const n = (rejectCount.get(key) ?? 0) + 1;
            rejectCount.set(key, n);
            if (n >= REJECT_GIVE_UP_COUNT) {
              rejectedUntil.set(key, Date.now() + GIVE_UP_MS);
              // Reset the strike count so a position that's still genuinely
              // live gets a full fresh set of chances after the give-up window
              // lapses, instead of being re-blacklisted on the very next reject.
              rejectCount.delete(key);
              log(
                "LIQUIDATION",
                `${key} rejected ${n}x in a row — likely orphaned/corrupt, pausing 24h`
              );
            } else {
              const cooldown = Math.min(REJECT_COOLDOWN_MS * n, REJECT_COOLDOWN_CAP_MS);
              rejectedUntil.set(key, Date.now() + cooldown);
              log(
                "LIQUIDATION",
                `${key} rejected on-chain (health above threshold); pausing ${Math.round(cooldown / 60_000)}m (${n}/${REJECT_GIVE_UP_COUNT})`
              );
            }
          } else {
            log("LIQUIDATION", `Failed to liquidate ${pubkey.toBase58()}: ${err.message}`);
          }
        }
      }

      if (liquidated > 0) {
        log("LIQUIDATION", `Liquidated ${liquidated} positions this cycle`);
      }

      // SL/TP triggers evaluate against the same price the program uses for
      // close-at-market (last_mark_price, falling back to TWAP).
      const closePrice =
        market.lastMarkPrice > 0n ? market.lastMarkPrice : markPriceBigint;
      await executeTriggers(
        connection,
        keeper,
        getKeeperAddresses().programId,
        closePrice
      );

      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      log("LIQUIDATION", `Error (${consecutiveErrors}): ${err.message}`);
      if (consecutiveErrors > 10) {
        log("LIQUIDATION", "Too many errors, backing off 60s");
        await sleep(60_000);
        consecutiveErrors = 0;
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  log("LIQUIDATION", `crashed: ${err?.message ?? err}`);
  process.exit(1);
});
