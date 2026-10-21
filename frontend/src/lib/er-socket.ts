"use client";

import { ER_RPC_DIRECT } from "@/lib/manifest";

/**
 * ONE multiplexed WebSocket to the MagicBlock Ephemeral Rollup, shared by the
 * order book feed (accountSubscribe) and transaction confirmation
 * (signatureSubscribe).
 *
 * WHY direct and not through /api/rpc/er: the proxy is HTTP-only, so every
 * consumer used to POLL through it -- the 612 KB book every 2s and each order's
 * status every 600ms. The ER answers CORS with `access-control-allow-origin: *`
 * and WebSockets are not subject to CORS at all, so the browser can hold one
 * push stream instead. Both endpoints are public and keyless; nothing leaks.
 * The polling paths stay as the fallback (see use-orderbook.ts, er-exec.ts), so
 * a network that blocks the socket degrades to the old behaviour, not to none.
 *
 * Account subscriptions are persistent: they survive reconnects (re-sent on
 * every open) until their owner unsubscribes. Signature subscriptions are
 * one-shot, as the RPC itself treats them.
 */

type AccountValue = { data: [string, string] } | null;
export interface AccountPush {
  slot: number;
  value: AccountValue;
}

interface AccountSub {
  address: string;
  encoding: string;
  onPush: (push: AccountPush) => void;
  serverId: number | null;
}

interface SignatureWaiter {
  resolve: (result: { at: number; ok: boolean; err: unknown } | null) => void;
}

const RECONNECT_MAX_MS = 15_000;
/** A tab hidden this long drops its socket: an idle tab should not keep
 *  pulling ~35 KB per book update it will never render. */
const HIDDEN_CLOSE_MS = 30_000;

class ErSocket {
  private ws: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private nextId = 1;
  private readonly acks = new Map<number, { resolve: (id: number) => void; reject: (e: Error) => void }>();
  private readonly accounts = new Set<AccountSub>();
  private readonly accountByServerId = new Map<number, AccountSub>();
  private readonly signatures = new Map<number, SignatureWaiter>();
  private readonly statusListeners = new Set<(open: boolean) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private visibilityBound = false;

  constructor(private readonly url: string) {}

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onStatus(listener: (open: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private emitStatus() {
    const open = this.open;
    this.statusListeners.forEach((l) => l(open));
  }

  private bindVisibility() {
    if (this.visibilityBound || typeof document === "undefined") return;
    this.visibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (this.hiddenTimer === null) {
          this.hiddenTimer = setTimeout(() => {
            this.hiddenTimer = null;
            if (document.hidden) this.ws?.close();
          }, HIDDEN_CLOSE_MS);
        }
      } else {
        if (this.hiddenTimer !== null) clearTimeout(this.hiddenTimer);
        this.hiddenTimer = null;
        if (!this.ws && this.accounts.size > 0) void this.connect().catch(() => {});
      }
    });
  }

  private connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    this.bindVisibility();
    return (this.opening ??= new Promise<WebSocket>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url.replace(/^http/, "ws"));
      } catch (err) {
        this.opening = null;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      ws.onopen = () => {
        this.ws = ws;
        this.opening = null;
        this.failures = 0;
        for (const sub of this.accounts) this.sendAccountSubscribe(ws, sub);
        this.emitStatus();
        resolve(ws);
      };
      ws.onerror = () => {
        if (this.opening) {
          this.opening = null;
          reject(new Error("rollup websocket unavailable"));
        }
      };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        this.opening = null;
        this.accountByServerId.clear();
        for (const sub of this.accounts) sub.serverId = null;
        // Signature waiters cannot be resumed on a new socket: hand them back
        // as "unknown" so the caller's HTTP poll decides.
        this.signatures.forEach((w) => w.resolve(null));
        this.signatures.clear();
        this.acks.forEach((a) => a.reject(new Error("rollup websocket closed")));
        this.acks.clear();
        this.emitStatus();
        this.scheduleReconnect();
      };
      ws.onmessage = (event) => this.handle(String(event.data));
    }));
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null || this.accounts.size === 0) return;
    if (typeof document !== "undefined" && document.hidden) return; // resumes on visibilitychange
    this.failures += 1;
    const delay = Math.min(500 * 2 ** Math.min(this.failures, 5), RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.accounts.size > 0) void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private request(ws: WebSocket, method: string, params: unknown[]): Promise<number> {
    const id = this.nextId++;
    return new Promise<number>((resolve, reject) => {
      this.acks.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (err) {
        this.acks.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendAccountSubscribe(ws: WebSocket, sub: AccountSub) {
    this.request(ws, "accountSubscribe", [sub.address, { encoding: sub.encoding, commitment: "processed" }])
      .then((serverId) => {
        // Unsubscribed while the ack was in flight: release it server-side.
        if (!this.accounts.has(sub)) {
          if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method: "accountUnsubscribe", params: [serverId] }));
          }
          return;
        }
        sub.serverId = serverId;
        this.accountByServerId.set(serverId, sub);
      })
      .catch(() => {});
  }

  private handle(raw: string) {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: { subscription: number; result: { context?: { slot?: number }; value: unknown } };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const ack = this.acks.get(msg.id);
      if (!ack) return;
      this.acks.delete(msg.id);
      if (typeof msg.result === "number") ack.resolve(msg.result);
      else ack.reject(new Error(msg.error?.message ?? "subscription refused"));
      return;
    }
    if (!msg.params) return;
    const { subscription, result } = msg.params;
    if (msg.method === "accountNotification") {
      const sub = this.accountByServerId.get(subscription);
      sub?.onPush({ slot: result.context?.slot ?? 0, value: result.value as AccountValue });
    } else if (msg.method === "signatureNotification") {
      const waiter = this.signatures.get(subscription);
      if (!waiter) return;
      this.signatures.delete(subscription);
      const err = (result.value as { err?: unknown } | null)?.err ?? null;
      waiter.resolve({ at: performance.now(), ok: err === null, err });
    }
  }

  /** Persistent account subscription; returns its unsubscribe. */
  subscribeAccount(address: string, onPush: (push: AccountPush) => void, encoding = "base64+zstd"): () => void {
    const sub: AccountSub = { address, encoding, onPush, serverId: null };
    this.accounts.add(sub);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.sendAccountSubscribe(this.ws, sub);
    else void this.connect().catch(() => this.scheduleReconnect());
    return () => {
      this.accounts.delete(sub);
      if (sub.serverId !== null) {
        this.accountByServerId.delete(sub.serverId);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method: "accountUnsubscribe", params: [sub.serverId] }));
        }
      }
    };
  }

  /**
   * Subscribe to a signature BEFORE sending it. `pingMs` is the subscription
   * round trip -- a pure network RTT to the rollup -- and `done` settles on the
   * "processed" push, or null on timeout / socket loss.
   * Wrapped in an object: an async function returning a bare promise would
   * wait for it.
   */
  async watchSignature(
    signature: string,
    timeoutMs = 8_000
  ): Promise<{ pingMs: number; done: Promise<{ at: number; ok: boolean; err: unknown } | null> }> {
    const ws = await this.connect();
    const sentAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const serverId = await Promise.race([
      this.request(ws, "signatureSubscribe", [signature, { commitment: "processed" }]),
      new Promise<number>((_, reject) => {
        timer = setTimeout(() => reject(new Error("signatureSubscribe was not acknowledged")), 3_000);
      }),
    ]).finally(() => clearTimeout(timer));
    const pingMs = Math.round(performance.now() - sentAt);
    return {
      pingMs,
      done: new Promise((resolve) => {
        this.signatures.set(serverId, { resolve });
        setTimeout(() => {
          if (this.signatures.delete(serverId)) resolve(null);
        }, timeoutMs);
      }),
    };
  }
}

let shared: ErSocket | null = null;
/** The app's one rollup socket (created lazily, browser only). */
export function erSocket(): ErSocket | null {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return null;
  return (shared ??= new ErSocket(ER_RPC_DIRECT));
}
