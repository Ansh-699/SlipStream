import { Connection, Keypair, Commitment } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const KEYPAIR_PATH =
  process.env.KEEPER_KEYPAIR ||
  path.join(process.env.HOME || "~", ".config/solana/id.json");

export function getBaseConnection(commitment: Commitment = "confirmed"): Connection {
  // web3.js retries a 429 five times internally before throwing; on a
  // quota-exhausted endpoint that multiplies every call ×5 and starves the
  // keepers' own backoff logic. Fail fast and let callers back off.
  return new Connection(BASE_RPC, { commitment, disableRetryOnRateLimit: true });
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
