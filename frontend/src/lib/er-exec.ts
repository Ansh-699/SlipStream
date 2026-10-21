"use client";

import {
  Connection,
  type Keypair,
  type PublicKey,
  type SendOptions,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { ER_RPC_DIRECT } from "@/lib/manifest";
import { erConnection } from "@/lib/connections";
import { erSocket } from "@/lib/er-socket";
import { confirmSignature } from "@/lib/confirm";
import { recordErTx } from "@/lib/er-latency";

/**
 * The fast path for every Ephemeral Rollup write the terminal makes (place,
 * cancel, close).
 *
 * What it used to cost, per click, all through the same-origin HTTP proxy:
 *   getLatestBlockhash round trip  ->  sendTransaction round trip  ->
 *   getSignatureStatuses every 600ms until "confirmed".
 * Three serial proxy hops plus up to 600ms of polling granularity, so an order
 * the rollup executed in one ~10ms block took a second or more to report.
 *
 * Now:
 *  - the blockhash is kept warm (`warmErBlockhash`), so a click never waits
 *    for one -- a rollup blockhash is valid for ~6,000 blocks (~50s, measured
 *    via getLatestBlockhash.lastValidBlockHeight), and it is reused for at most
 *    BLOCKHASH_REUSE_MS;
 *  - the transaction goes straight to the rollup (it allows CORS), through the
 *    proxy only if the browser cannot reach it;
 *  - "processed" is learned from whichever answers first: a signatureSubscribe
 *    push on the shared rollup socket, opened BEFORE the send, or a tight
 *    getSignatureStatuses poll. Either way it is one network round trip after
 *    execution instead of a 600ms tick.
 *
 * "processed" rather than "confirmed": the rollup is a single sequencer with no
 * forks to roll back, so the block that executed the order is final for it.
 * Preflight stays on, so a rejected order still fails at send with its logs.
 */

const BLOCKHASH_REUSE_MS = 5_000;
const BLOCKHASH_REFRESH_MS = 2_000;
const CONFIRM_TIMEOUT_MS = 30_000;

/** Direct to the rollup; the proxy-backed `erConnection` is the fallback. */
const direct = new Connection(ER_RPC_DIRECT, { commitment: "confirmed", disableRetryOnRateLimit: true });

function isNetworkError(err: unknown): boolean {
  if (err && typeof err === "object" && Array.isArray((err as { logs?: unknown }).logs)) return false;
  const message = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /failed to fetch|fetch failed|networkerror|load failed|network request failed|err_|econn|etimedout|aborted|timeout/i.test(message);
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

// ---- Blockhash ----

let cachedHash: { blockhash: string; at: number } | null = null;
let fetchingHash: Promise<string> | null = null;

function refreshBlockhash(): Promise<string> {
  return (fetchingHash ??= (async () => {
    try {
      let blockhash: string;
      try {
        blockhash = (await direct.getLatestBlockhash()).blockhash;
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        blockhash = (await erConnection.getLatestBlockhash()).blockhash;
      }
      cachedHash = { blockhash, at: performance.now() };
      return blockhash;
    } finally {
      fetchingHash = null;
    }
  })());
}

/** Keep a blockhash ready so the next click only signs and sends. */
export function warmErBlockhash(): void {
  if (!cachedHash || performance.now() - cachedHash.at > BLOCKHASH_REFRESH_MS) {
    void refreshBlockhash().catch(() => {});
  }
}

async function erBlockhash(fresh: boolean): Promise<string> {
  if (!fresh && cachedHash && performance.now() - cachedHash.at < BLOCKHASH_REUSE_MS) return cachedHash.blockhash;
  return refreshBlockhash();
}

// ---- Duplicate guard ----

/**
 * A reused blockhash has one trap: place_order carries no client nonce, so two
 * identical orders (same side, price and size) signed by the session key are
 * byte-identical transactions with one signature, and the rollup would drop
 * the second as already processed. Any message sent recently gets a fresh
 * blockhash instead.
 */
const recentMessages = new Map<string, number>();
function seenRecently(message: string): boolean {
  const now = performance.now();
  for (const [key, at] of recentMessages) if (now - at > 60_000) recentMessages.delete(key);
  return recentMessages.has(message);
}

// ---- Send + confirm ----

interface InFlight {
  sentAt: number;
  watching: Promise<{ pingMs: number; done: Promise<{ at: number; ok: boolean; err: unknown } | null> } | null>;
}
const inflight = new Map<string, InFlight>();

async function sendRaw(raw: Uint8Array, options?: SendOptions): Promise<string> {
  // A legacy transaction is a compact-u16 signature count (one byte below 128)
  // followed by the signatures; the first is the transaction's id.
  const signature = base58(raw.subarray(1, 65));
  const socket = erSocket();
  // Subscribe first, but never wait for the acknowledgement: "processed" is
  // whichever answers first, the push or the poll.
  const watching = socket ? socket.watchSignature(signature).catch(() => null) : Promise.resolve(null);
  inflight.set(signature, { sentAt: performance.now(), watching });
  try {
    await direct.sendRawTransaction(raw, options);
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    // Same signed bytes, same signature: a duplicate send is dropped, never
    // executed twice, so retrying through the proxy is safe.
    await erConnection.sendRawTransaction(raw, options);
  }
  return signature;
}

/** A Connection whose sends take the fast path, for the wallet-signed case:
 *  the wallet shim signs, then calls `connection.sendRawTransaction`. */
class FastErConnection extends Connection {
  async sendRawTransaction(raw: Buffer | Uint8Array | Array<number>, options?: SendOptions): Promise<string> {
    return sendRaw(raw instanceof Uint8Array ? raw : Uint8Array.from(raw), options);
  }
}
const fastSend = new FastErConnection(ER_RPC_DIRECT, { commitment: "confirmed", disableRetryOnRateLimit: true });

async function pollProcessed(
  signature: string,
  stop: () => boolean,
  deadline: number
): Promise<{ at: number; ok: boolean; err: unknown } | null> {
  const started = performance.now();
  let failures = 0;
  while (!stop() && performance.now() < deadline) {
    try {
      const { value } = await direct.getSignatureStatuses([signature]);
      failures = 0;
      const status = value[0];
      if (status) return { at: performance.now(), ok: status.err === null, err: status.err };
    } catch {
      // Three straight failures: this browser cannot poll the rollup directly.
      if (++failures >= 3) return null;
    }
    // Tight while an answer is due (the rollup makes ~10ms blocks), gentle after.
    await new Promise((resolve) => setTimeout(resolve, performance.now() - started < 2_000 ? 40 : 250));
  }
  return null;
}

export class ErExecError extends Error {
  constructor(
    message: string,
    readonly signature: string | null,
    readonly txErr: unknown = null
  ) {
    super(message);
    this.name = "ErExecError";
  }
}

export interface ErExecParams {
  instructions: TransactionInstruction[];
  /** The wallet. Signs and pays when there is no session key. */
  owner: PublicKey;
  /** Signs and pays locally (no wallet popup) when present. */
  sessionKeypair: Keypair | null;
  walletSend: (transaction: Transaction, connection: Connection, options?: SendOptions) => Promise<string>;
  /** Label for the latency panel. */
  kind: string;
  /** performance.now() at the click, so the reported time is click -> processed. */
  clickedAt?: number;
  /** Called the moment the transaction is sent, before it is processed. */
  onSent?: (signature: string) => void;
}

export interface ErExecResult {
  signature: string;
  /** Click -> processed. */
  ms: number;
  /** Send -> processed. */
  sendMs: number;
}

/**
 * Sign, send to the rollup and wait until it is processed.
 *
 * Throws what the send throws (a preflight rejection carries its logs, exactly
 * as before), or an ErExecError carrying the signature when the transaction
 * executed and failed, or when no answer came in time -- which, as before,
 * says nothing about whether it landed.
 */
export async function executeEr(p: ErExecParams): Promise<ErExecResult> {
  const clickedAt = p.clickedAt ?? performance.now();
  const startedEpoch = Date.now() - (performance.now() - clickedAt);
  const feePayer = p.sessionKeypair ? p.sessionKeypair.publicKey : p.owner;

  const tx = new Transaction().add(...p.instructions);
  tx.feePayer = feePayer;
  tx.recentBlockhash = await erBlockhash(false);
  let message = tx.serializeMessage().toString("base64");
  for (let attempt = 0; seenRecently(message) && attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 15));
    tx.recentBlockhash = await erBlockhash(true);
    message = tx.serializeMessage().toString("base64");
  }
  recentMessages.set(message, performance.now());

  let signature: string;
  if (p.sessionKeypair) {
    tx.sign(p.sessionKeypair);
    signature = await sendRaw(tx.serialize(), { skipPreflight: false });
  } else {
    signature = await p.walletSend(tx, fastSend, { skipPreflight: false });
  }
  p.onSent?.(signature);

  const entry = inflight.get(signature) ?? { sentAt: performance.now(), watching: Promise.resolve(null) };
  inflight.delete(signature);
  const deadline = performance.now() + CONFIRM_TIMEOUT_MS;

  let answered = false;
  const pushed = entry.watching.then(async (w) => {
    const r = w ? await w.done : null;
    return r ? { ...r, via: "push" as const } : null;
  });
  const polled = pollProcessed(signature, () => answered, deadline).then((r) =>
    r ? { ...r, via: "poll" as const } : null
  );
  let result = await new Promise<{ at: number; ok: boolean; err: unknown; via: "push" | "poll" } | null>((resolve) => {
    let pending = 2;
    const settle = (value: { at: number; ok: boolean; err: unknown; via: "push" | "poll" } | null) => {
      if (answered) return;
      if (value) {
        answered = true;
        resolve(value);
      } else if (--pending === 0) {
        answered = true;
        resolve(null);
      }
    };
    void pushed.then(settle, () => settle(null));
    void polled.then(settle, () => settle(null));
  });

  let via: "push" | "poll" | "proxy" = result?.via ?? "proxy";
  if (!result) {
    // Neither direct path answered: the old proxy poll decides, with what is
    // left of the deadline.
    const remaining = Math.max(1_000, deadline - performance.now());
    try {
      await confirmSignature(erConnection, signature, { timeoutMs: remaining, pollMs: 300 });
      result = { at: performance.now(), ok: true, err: null, via: "poll" };
      via = "proxy";
    } catch (err) {
      const txErr = (err as { txErr?: unknown }).txErr;
      recordErTx({ kind: p.kind, ms: null, sendMs: null, netMs: null, ok: false, at: startedEpoch, signature, via: null });
      throw new ErExecError(err instanceof Error ? err.message : String(err), signature, txErr ?? null);
    }
  }

  const watch = await Promise.race([entry.watching, Promise.resolve(null)]);
  const ms = Math.round(result.at - clickedAt);
  const sendMs = Math.round(result.at - entry.sentAt);
  recordErTx({ kind: p.kind, ms, sendMs, netMs: watch?.pingMs ?? null, ok: result.ok, at: startedEpoch, signature, via });
  if (!result.ok) {
    throw new ErExecError(`Transaction failed: ${JSON.stringify(result.err)}`, signature, result.err);
  }
  return { signature, ms, sendMs };
}
