import { Connection, Keypair, Commitment } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PUBLIC_DEVNET = "https://api.devnet.solana.com";

const BASE_RPC = process.env.BASE_RPC || PUBLIC_DEVNET;
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";

/**
 * Where base-layer reads go when BASE_RPC will not serve.
 *
 * WHY THIS EXISTS: BASE_RPC was a single point of failure. On 2026-09-01T23:28Z
 * the keyed provider it pointed at returned
 *   HTTP 429 {"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}
 * on every call, and five keepers -- twap, funding, liquidation, taker and
 * market-maker, i.e. every caller of getBaseConnection() -- sat in a retry loop
 * for 2.7 days while the free public endpoint answered 200 in ~200 ms the whole
 * time. expiry-keeper never calls this and was the only one that stayed up.
 *
 * The frontend's /api/rpc/[layer] route had already grown this failover; the
 * keepers had not, so the browser degraded and the fleet died. This closes that
 * asymmetry at the one chokepoint every long-running keeper shares.
 *
 * The default is deliberately the FREE public endpoint rather than a second
 * key: it throttles under load, but it is always there, and a slow chain read
 * beats a dead keeper.
 */
const BASE_RPC_FALLBACK = process.env.BASE_RPC_FALLBACK || PUBLIC_DEVNET;

/**
 * A JSON-RPC quota error, matched on the CODE and not the message text.
 * Length-bounded because an error envelope is a few hundred bytes and a base64
 * account blob can contain any substring you care to name -- the order book
 * alone is ~836 KB per read.
 */
function isQuotaBody(text: string): boolean {
  return text.length < 4096 && /"code"\s*:\s*-32429/.test(text);
}

// A quota does not clear until the provider's billing window rolls over, so
// re-asking the primary on every call buys a guaranteed failure at the cost of
// doubling every keeper's latency. Latch it off, and let the latch expire so a
// refilled key is picked up on its own without a restart.
const QUOTA_COOLDOWN_MS = 5 * 60_000;
let primaryBlockedUntil = 0;

/** True once the body or status says this upstream will not serve us. */
async function readAttempt(
  res: Response
): Promise<{ dead: boolean; res: Response }> {
  if (res.status === 429) return { dead: true, res };
  if (res.status >= 500) return { dead: true, res };
  // An 836 KB account blob is never a quota envelope, and buffering it here
  // would copy it twice on a box with ~100 MB of free RAM.
  const len = Number(res.headers.get("content-length") || "0");
  if (res.ok && len > 4096) return { dead: false, res };
  const text = await res.text();
  return {
    dead: isQuotaBody(text),
    // The body is consumed; hand the caller an equivalent one.
    res: new Response(text, { status: res.status, headers: res.headers }),
  };
}

/**
 * fetch() for the base layer, with failover. Wired in through
 * ConnectionConfig.fetch so every existing getBaseConnection() caller inherits
 * it with no change at the call site.
 */
const failoverFetch = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Promise<Response> => {
  const primaryLatched = Date.now() < primaryBlockedUntil;

  if (!primaryLatched) {
    try {
      const attempt = await readAttempt(await fetch(input, init));
      if (!attempt.dead) return attempt.res;
      primaryBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
      log("rpc", `base upstream refused (${attempt.res.status}); failing over for ${QUOTA_COOLDOWN_MS / 1000}s`);
    } catch (err) {
      primaryBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
      // Message only: the URL carries an API key.
      log("rpc", `base upstream unreachable (${err instanceof Error ? err.message : "unknown"}); failing over`);
    }
  }

  // Same request, other endpoint. If the fallback fails too, its response (or
  // its throw) is what the caller sees -- that is a real outage, not ours to
  // paper over.
  return fetch(BASE_RPC_FALLBACK, init);
};
const KEYPAIR_PATH =
  process.env.KEEPER_KEYPAIR ||
  path.join(process.env.HOME || "~", ".config/solana/id.json");

export function getBaseConnection(commitment: Commitment = "confirmed"): Connection {
  // web3.js retries a 429 five times internally before throwing; on a
  // quota-exhausted endpoint that multiplies every call ×5 and starves the
  // keepers' own backoff logic. Fail fast, fail over, and let callers back off.
  return new Connection(BASE_RPC, {
    commitment,
    disableRetryOnRateLimit: true,
    fetch: failoverFetch,
  });
}

export function getErConnection(): Connection {
  return new Connection(ER_RPC, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 10_000,
  });
}

export function loadKeypair(): Keypair {
  const raw = fs.readFileSync(KEYPAIR_PATH, "utf-8");
  const secretKey = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secretKey);
}

export async function sendAndConfirm(
  connection: Connection,
  tx: import("@solana/web3.js").Transaction,
  signers: Keypair[],
  skipPreflight: boolean = false
): Promise<string> {
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight,
    preflightCommitment: "confirmed",
  });
  const conf = await connection.confirmTransaction(sig, "confirmed");
  // A tx can LAND and still fail on-chain (custom program error); confirm's
  // result carries that. Without this check every caller treated a reverted
  // tx as success — masking real failures on skip-preflight paths.
  if (conf.value.err) {
    throw new Error(`tx ${sig} failed on-chain: ${JSON.stringify(conf.value.err)}`);
  }
  return sig;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function log(keeper: string, msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${keeper}] ${msg}`);
}
