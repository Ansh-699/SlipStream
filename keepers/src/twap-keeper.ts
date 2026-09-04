import { Transaction } from "@solana/web3.js";
import { getBaseConnection, loadKeypair, sendAndConfirm, sleep, log } from "./shared/connection";
import { fetchMarket } from "./shared/accounts";
import { getKeeperAddresses } from "./shared/manifest";
import { readPythPrice } from "./shared/pyth";
import { createCrankTwapInstruction } from "../../client/src/instructions";

const MARKET_INDEX = 0;
const CRANK_INTERVAL_MS = 8_000; // 8 seconds

/**
 * BUG 3 fix: do not send a crank the program is certain to reject.
 *
 * crank_twap gates on the ORACLE's own publish time against the on-chain clock
 * (`oracle::MAX_STALENESS_SECS` = 60s, see programs/slipstream/src/oracle.rs:22
 * and crank_twap.rs's `reading.is_fresh(now_ts)`), so a crank sent while Pyth is
 * stale fails preflight with custom program error 0x104 / OracleStale. That
 * costs no lamports -- simulation rejects it before it lands -- but it counted
 * as a keeper error, and 11 of them tripped the 60s backoff below.
 *
 * That backoff was the actual damage. The devnet Pyth feed
 * (7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE) no longer publishes
 * continuously: measured 2026-09-04 it published twice in 200s, 309s apart, and
 * read fresh in only 9 of 40 samples. So the usable window is ~60s out of every
 * ~300s, and a keeper that spends 88s failing and then sleeps 60s drifts in and
 * out of phase with those windows -- it cranked ZERO times in 13 minutes while
 * the feed published three times.
 *
 * Reading the feed first turns each doomed send into a cheap skip, which keeps
 * the loop in phase and lets it crank on the first poll after every publish.
 * The margin reserves part of the 60s for send + confirm, since freshness is
 * re-evaluated on-chain at execution, not at send.
 */
const MAX_STALENESS_SECS = 60; // must match oracle::MAX_STALENESS_SECS
const SEND_SAFETY_MARGIN_SECS = 15;
const MAX_AGE_TO_SEND_SECS = MAX_STALENESS_SECS - SEND_SAFETY_MARGIN_SECS;

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
  // Only log the stale/fresh transition, not every poll: at an 8s cadence an
  // unconditional line would be ~10,800 entries a day and bury the real errors.
  let wasStale = false;

  while (true) {
    try {
      const market = await fetchMarket(connection, MARKET_INDEX);
      if (!market) {
        log("TWAP", "Market not found, waiting...");
        await sleep(5_000);
        continue;
      }

      // Freshness is the program's gate, so check it before spending a send.
      // A skip is NOT an error: counting it would trip the backoff below and
      // desynchronise this loop from the feed's publish windows.
      const px = await readPythPrice(connection, pythFeed);
      if (px.ageSecs > MAX_AGE_TO_SEND_SECS) {
        if (!wasStale) {
          log("TWAP", `Pyth stale (${px.ageSecs}s > ${MAX_AGE_TO_SEND_SECS}s) — holding until it publishes`);
          wasStale = true;
        }
        await sleep(CRANK_INTERVAL_MS);
        continue;
      }
      if (wasStale) {
        log("TWAP", `Pyth fresh again (${px.ageSecs}s, $${px.priceFloat.toFixed(4)}) — cranking`);
        wasStale = false;
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
