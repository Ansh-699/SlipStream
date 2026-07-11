import { PublicKey, Transaction } from "@solana/web3.js";
import { getErConnection, loadKeypair, sleep, log } from "./shared/connection";
import { getKeeperAddresses } from "./shared/manifest";
import { createCancelOrderInstruction } from "../../client/src/instructions";
import { decodeOrderBook } from "../../client/src/accounts";

/**
 * Expiry keeper (§10). Scans the OrderBook every SCAN_INTERVAL_MS and submits
 * cancel_order for each slot whose `expiry_ts > 0 && expiry_ts <= now`.
 *
 * Cancellations earn a small bounty (deferred — Phase 2). For MVP the keeper
 * runs as a public good; anyone can run their own and beat the protocol's.
 */
const MARKET_INDEX = 0;
const SCAN_INTERVAL_MS = 60_000;

async function main() {
  const erConn = getErConnection();
  const keeper = loadKeypair();
  log("EXPIRY", `keeper ${keeper.publicKey.toBase58()}`);

  // Req 6.1: resolve the orderbook address from the Deploy_Manifest (with the
  // SDK-derived PDA as the configured fallback). Throws a descriptive error if
  // the manifest is missing (Req 6.3).
  const obPda = getKeeperAddresses().orderBook;

  while (true) {
    try {
      const info = await erConn.getAccountInfo(obPda);
      if (!info) {
        log("EXPIRY", "OrderBook not found; sleeping");
        await sleep(SCAN_INTERVAL_MS);
        continue;
      }
      const ob = decodeOrderBook(info.data as Buffer);
      const now = BigInt(Math.floor(Date.now() / 1000));
      let cancelled = 0;
      for (const slot of ob.orderSlots) {
        if (!slot.active) continue;
        if (slot.expiryTs <= 0n) continue;
        if (slot.expiryTs > now) continue;
        try {
          const ix = createCancelOrderInstruction(
            new PublicKey(slot.owner),
            MARKET_INDEX,
            slot.orderId,
          );
          // NOTE: we sign as keeper (not slot owner) — the instruction requires
          // the owner signer. For real expiry-cancel keeper we'd need a permissionless
          // version that accepts any signer when expiry has passed. Deferred to
          // Phase 2; for now this loop only logs.
          void ix;
          cancelled++;
        } catch (e: any) {
          log("EXPIRY", `failed to build cancel for slot ${slot.orderId}: ${e.message}`);
        }
      }
      if (cancelled > 0) {
        log("EXPIRY", `would cancel ${cancelled} expired slots (perm-cancel ix is Phase 2)`);
      }
    } catch (e: any) {
      log("EXPIRY", `scan error: ${e.message ?? e}`);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch((err) => {
  log("EXPIRY", `crashed: ${err?.message ?? err}`);
  process.exit(1);
});
