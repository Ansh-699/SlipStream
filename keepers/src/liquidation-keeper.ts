import { PublicKey, Transaction } from "@solana/web3.js";
import { getBaseConnection, loadKeypair, sendAndConfirm, sleep, log } from "./shared/connection";
import { fetchMarket, fetchAllPositions } from "./shared/accounts";
import { getKeeperAddresses } from "./shared/manifest";
import { createLiquidatePositionInstruction } from "../../client/src/instructions";
import { PRICE_SCALE } from "../../client/src/constants";

const SWITCHBOARD_SOL_USD = new PublicKey(
  process.env.SWITCHBOARD_FEED || "GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR"
);
import { computeTwap, type Position } from "../../client/src/accounts";

const MARKET_INDEX = 0;
const POLL_INTERVAL_MS = 5_000;

function computeHealthFactor(
  pos: Position,
  markPrice: bigint,
  maxLeverage: number
): number {
  const absSize = pos.size < 0n ? -pos.size : pos.size;
  const notional = (absSize * markPrice) / BigInt(PRICE_SCALE);
  const initialMargin = notional / BigInt(maxLeverage);
  const maintenanceMargin = initialMargin / 2n;

  if (maintenanceMargin === 0n) return Infinity;

  const priceDiff = markPrice - pos.entryPrice;
  const signedSize = pos.size;
  const unrealizedPnl = (signedSize * priceDiff) / BigInt(PRICE_SCALE);

  const equity = BigInt(pos.collateral) + unrealizedPnl;
  return Number(equity * 1_000_000n / maintenanceMargin) / 1_000_000;
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

      const twapPrice = computeTwap(market);
      if (!twapPrice) {
        log("LIQUIDATION", "No TWAP price available, skipping");
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const markPriceBigint = BigInt(Math.round(twapPrice * PRICE_SCALE));

      const positions = await fetchAllPositions(connection, MARKET_INDEX);
      let liquidated = 0;

      for (const { pubkey, account: pos } of positions) {
        if (pos.size === 0n) continue;

        const health = computeHealthFactor(pos, markPriceBigint, market.maxLeverage);
        if (health >= 1.0) continue;

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
          log("LIQUIDATION", `Liquidated ${pubkey.toBase58()}, sig=${sig}`);
          liquidated++;
        } catch (err: any) {
          log("LIQUIDATION", `Failed to liquidate ${pubkey.toBase58()}: ${err.message}`);
        }
      }

      if (liquidated > 0) {
        log("LIQUIDATION", `Liquidated ${liquidated} positions this cycle`);
      }

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
  console.error("Liquidation keeper crashed:", err);
  process.exit(1);
});
