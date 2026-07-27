import { getErConnection, loadKeypair, sleep, log } from "./shared/connection";
import { getKeeperAddresses } from "./shared/manifest";
import { sendErTx, classifyTxError } from "./shared/ertx";
import { createCancelOrderInstruction } from "../../client/src/instructions";
import { decodeOrderBook } from "../../client/src/accounts";

/**
 * Expiry keeper (§10). Scans the OrderBook every SCAN_INTERVAL_MS and submits
 * cancel_order for each slot whose `expiry_ts > 0 && expiry_ts <= now`.
 *
 * cancel_order (programs/slipstream/src/instructions/cancel_order.rs) has a
 * dedicated permissionless bypass for exactly this case: once an order's own
 * expiry_ts has passed, ANY signer may cancel it, and the freed margin still
 * returns to the real owner's credit — never to the keeper. No owner
 * signature or session key is needed.
 *
 * Cancellations earn a small bounty (deferred — Phase 2). For MVP the keeper
 * runs as a public good; anyone can run their own and beat the protocol's.
 */
const MARKET_INDEX = 0;
const SCAN_INTERVAL_MS = 60_000;
// Space out cancels within a tick so one busy scan doesn't hammer the ER.
const CANCEL_DELAY_MS = 250;

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
      const expired = ob.orderSlots.filter(
        (slot) => slot.active && slot.expiryTs > 0n && slot.expiryTs <= now
      );
      if (expired.length > 0) {
        log("EXPIRY", `found ${expired.length} expired order(s); cancelling`);
      }
      let cancelled = 0;
      for (const slot of expired) {
        try {
          const ix = createCancelOrderInstruction(
            slot.owner,
            MARKET_INDEX,
            slot.orderId,
            undefined,
            keeper.publicKey // permissionless: keeper signs, owner still receives the margin
          );
          const sig = await sendErTx(erConn, ix, keeper);
          log("EXPIRY", `cancelled order ${slot.orderId} (owner ${slot.owner.toBase58()}): ${sig}`);
          cancelled++;
        } catch (e: any) {
          const c = classifyTxError(e);
          log("EXPIRY", `failed to cancel order ${slot.orderId}: ${c.name ?? c.raw}`);
        }
        await sleep(CANCEL_DELAY_MS);
      }
      if (cancelled > 0) {
        log("EXPIRY", `cancelled ${cancelled}/${expired.length} expired order(s)`);
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
