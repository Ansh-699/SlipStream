import { Connection, TransactionConfirmationStatus } from "@solana/web3.js";

/**
 * Confirm a transaction by POLLING getSignatureStatuses over HTTP, NOT via the
 * WebSocket signatureSubscribe that Connection.confirmTransaction uses.
 *
 * WHY: the browser talks to the ER through the same-origin proxy
 * (http://<origin>/api/rpc/er). web3.js derives a ws:// URL from that endpoint
 * for signature subscriptions, but the proxy only serves HTTP — so the WS never
 * connects and confirmTransaction hangs forever ("Placing…" spinner that never
 * resolves). Polling getSignatureStatuses goes through the HTTP proxy and works.
 *
 * Returns the confirmed status, or throws on an on-chain error / timeout.
 */
export async function confirmSignature(
  conn: Connection,
  signature: string,
  opts: {
    desired?: TransactionConfirmationStatus;
    timeoutMs?: number;
    pollMs?: number;
  } = {}
): Promise<void> {
  const desired = opts.desired ?? "confirmed";
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 600;
  const rank: Record<TransactionConfirmationStatus, number> = {
    processed: 0,
    confirmed: 1,
    finalized: 2,
  };
  const target = rank[desired];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { value } = await conn.getSignatureStatuses([signature], {
      searchTransactionHistory: false,
    });
    const st = value[0];
    if (st) {
      if (st.err) {
        throw Object.assign(new Error(`Transaction failed: ${JSON.stringify(st.err)}`), {
          txErr: st.err,
        });
      }
      if (st.confirmationStatus && rank[st.confirmationStatus] >= target) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Confirmation timed out after ${timeoutMs}ms for ${signature}`);
}
