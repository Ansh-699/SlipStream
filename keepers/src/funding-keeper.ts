import { Transaction } from "@solana/web3.js";
import { getBaseConnection, loadKeypair, sendAndConfirm, sleep, log } from "./shared/connection";
import { fetchMarket } from "./shared/accounts";
import { getKeeperAddresses } from "./shared/manifest";
import { createComputeFundingInstruction } from "../../client/src/instructions";
import { PublicKey } from "@solana/web3.js";

// Switchboard SOL/USD on devnet — override via SWITCHBOARD_FEED env
const SWITCHBOARD_SOL_USD = new PublicKey(
  process.env.SWITCHBOARD_FEED || "GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR"
);

const MARKET_INDEX = 0;
const CHECK_INTERVAL_MS = 60_000; // Check every minute

async function main() {
  const connection = getBaseConnection();
  const keeper = loadKeypair();
  // BUG 1 fix: use the LIVE Pyth feed from the deploy manifest, not the legacy
  // frozen PYTH_SOL_USD_DEVNET constant.
  const pythFeed = getKeeperAddresses().pythFeed;
  log("FUNDING", `Starting funding keeper with address ${keeper.publicKey.toBase58()}`);
  log("FUNDING", `Using Pyth feed ${pythFeed.toBase58()}`);

  let consecutiveErrors = 0;

  while (true) {
    try {
      const market = await fetchMarket(connection, MARKET_INDEX);
      if (!market) {
        log("FUNDING", "Market not found, waiting...");
        await sleep(5_000);
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      const lastTs = Number(market.lastFundingTs);
      const interval = Number(market.fundingIntervalSecs);
      const elapsed = now - lastTs;

      if (elapsed < interval) {
        const remaining = interval - elapsed;
        log("FUNDING", `Next funding in ${remaining}s`);
        await sleep(Math.min(remaining * 1000, CHECK_INTERVAL_MS));
        continue;
      }

      log("FUNDING", `Funding interval elapsed (${elapsed}s >= ${interval}s), computing...`);

      const ix = createComputeFundingInstruction(MARKET_INDEX, pythFeed, SWITCHBOARD_SOL_USD);
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirm(connection, tx, [keeper]);
      log("FUNDING", `Computed funding, sig=${sig}`);
      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      log("FUNDING", `Error (${consecutiveErrors}): ${err.message}`);
      if (consecutiveErrors > 5) {
        log("FUNDING", "Too many consecutive errors, backing off 5m");
        await sleep(300_000);
        consecutiveErrors = 0;
      }
    }

    await sleep(CHECK_INTERVAL_MS);
  }
}

main().catch((err) => {
  log("FUNDING", `crashed: ${err?.message ?? err}`);
  process.exit(1);
});
