import { Transaction } from "@solana/web3.js";
import { getBaseConnection, loadKeypair, sendAndConfirm, sleep, log } from "./shared/connection";
import { fetchMarket } from "./shared/accounts";
import { getKeeperAddresses } from "./shared/manifest";
import { createCrankTwapInstruction } from "../../client/src/instructions";

const MARKET_INDEX = 0;
const CRANK_INTERVAL_MS = 8_000; // 8 seconds

async function main() {
  const connection = getBaseConnection();
  const keeper = loadKeypair();
  // BUG 1 fix: use the LIVE Pyth feed resolved from the deploy manifest
  // (deploy.json `pythFeed`), not the legacy frozen PYTH_SOL_USD_DEVNET ($139)
  // constant that tripped the >10% circuit breaker.
  const pythFeed = getKeeperAddresses().pythFeed;
  log("TWAP", `Starting TWAP keeper with address ${keeper.publicKey.toBase58()}`);
  log("TWAP", `Using Pyth feed ${pythFeed.toBase58()}`);

  let consecutiveErrors = 0;

  while (true) {
    try {
      const market = await fetchMarket(connection, MARKET_INDEX);
      if (!market) {
        log("TWAP", "Market not found, waiting...");
        await sleep(5_000);
        continue;
      }

      // BUG 2 fix: do NOT skip cranking when the circuit breaker is active.
      // crank_twap sets circuit_breaker_active=1 on a >10% divergence and
      // CLEARS it (=0) once a sample is back within range — so cranking with the
      // live price is the recovery path. Skipping while paused self-deadlocks the
      // market (it can never crank to clear the breaker). We therefore always
      // crank; we just log that we're cranking to recover.
      if (market.circuitBreakerActive) {
        log("TWAP", "Circuit breaker active — cranking with live price to recover");
      }

      const ix = createCrankTwapInstruction(MARKET_INDEX, pythFeed);
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirm(connection, tx, [keeper]);
      log("TWAP", `Cranked TWAP, sig=${sig}`);
      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      log("TWAP", `Error (${consecutiveErrors}): ${err.message}`);
      if (consecutiveErrors > 10) {
        log("TWAP", "Too many consecutive errors, backing off 60s");
        await sleep(60_000);
        consecutiveErrors = 0;
      }
    }

    await sleep(CRANK_INTERVAL_MS);
  }
}

main().catch((err) => {
  log("TWAP", `crashed: ${err?.message ?? err}`);
  process.exit(1);
});
