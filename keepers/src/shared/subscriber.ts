import { Connection, PublicKey, AccountInfo } from "@solana/web3.js";

/**
 * Lightweight wrapper around `Connection.onAccountChange` for the keepers.
 * - Single instance can subscribe to many accounts.
 * - Auto-reconnects (sort of — web3.js handles ws reconnection internally).
 * - Calls handler with (pubkey, accountInfo) on every change.
 *
 * NOTE: For Yellowstone gRPC streaming (lower latency, higher throughput) swap
 * this for the `@triton-one/yellowstone-grpc` client. WebSocket is sufficient for
 * MVP keeper traffic.
 */
export type AccountChangeHandler = (
  pubkey: PublicKey,
  account: AccountInfo<Buffer>
) => void | Promise<void>;

export class AccountSubscriber {
  private subscriptions = new Map<string, number>(); // pubkey base58 → subscription id
  constructor(private readonly conn: Connection) {}

  subscribe(pubkey: PublicKey, handler: AccountChangeHandler) {
    const key = pubkey.toBase58();
    if (this.subscriptions.has(key)) {
      return; // already subscribed
    }
    const subId = this.conn.onAccountChange(
      pubkey,
      (info) => {
        Promise.resolve(handler(pubkey, info as AccountInfo<Buffer>)).catch((err) => {
          console.error(`[subscriber] handler for ${key} threw:`, err);
        });
      },
      "confirmed"
    );
    this.subscriptions.set(key, subId);
  }

  async unsubscribe(pubkey: PublicKey) {
    const key = pubkey.toBase58();
    const subId = this.subscriptions.get(key);
    if (subId === undefined) return;
    await this.conn.removeAccountChangeListener(subId);
    this.subscriptions.delete(key);
  }

  async unsubscribeAll() {
    for (const [, subId] of this.subscriptions) {
      try {
        await this.conn.removeAccountChangeListener(subId);
      } catch {
        // ignore
      }
    }
    this.subscriptions.clear();
  }

  /**
   * Subscribe to a class of accounts via getProgramAccounts polling at a fixed
   * interval. WebSocket programSubscribe is unreliable on most RPCs, so we fall
   * back to coarse polling here.
   */
  async pollProgramAccounts(
    programId: PublicKey,
    filters: Parameters<Connection["getProgramAccounts"]>[1],
    handler: (
      pubkey: PublicKey,
      account: AccountInfo<Buffer>
    ) => void | Promise<void>,
    intervalMs: number = 5_000
  ): Promise<NodeJS.Timeout> {
    const tick = async () => {
      try {
        const accs = await this.conn.getProgramAccounts(programId, filters);
        for (const a of accs) {
          await handler(a.pubkey, a.account as AccountInfo<Buffer>);
        }
      } catch (e) {
        console.error("[subscriber] poll error:", e);
      }
    };
    void tick();
    return setInterval(tick, intervalMs);
  }
}
