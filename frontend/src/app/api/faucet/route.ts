// Test-USDC faucet (devnet only). Server-side route: the operator key (the USDC
// mint authority) creates the requester's USDC ATA if needed and mints them a
// fixed amount of test USDC so a brand-new wallet can actually deposit.
//
//   POST /api/faucet  { "wallet": "<base58 pubkey>" }
//   -> { ok, signature, ata, amount } | { ok:false, error }
//
// WHY: deposit_collateral transfers from the user's USDC token account. A fresh
// wallet has neither test USDC nor an ATA, so the deposit fails preflight with
// Phantom's generic "Unexpected error". This faucet removes that wall.
//
// SECURITY: this mints WORTHLESS devnet test tokens only. It is gated to a fixed
// amount, a simple in-memory per-wallet cooldown, and requires the operator key
// to be present on the server (OPERATOR_KEYPAIR). It is NOT for mainnet.
import { NextRequest } from "next/server";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FAUCET_USDC = Number(process.env.FAUCET_USDC_AMOUNT || "10000"); // 10k test USDC
const COOLDOWN_MS = 60_000; // one drip per wallet per minute
const BASE_RPC =
  process.env.BASE_RPC_UPSTREAM ||
  process.env.BASE_RPC ||
  "https://api.devnet.solana.com";

// Per-wallet cooldown (best-effort; resets on server restart).
const lastDrip = new Map<string, number>();

// A per-wallet cooldown bounds nothing on its own: the wallet is supplied by the
// caller, and fresh keypairs are free. Every drip also makes the operator pay ATA
// rent, so an unbounded faucet drains the operator's SOL as well as minting
// unlimited collateral into the live market. Add a global rate cap and a per-IP
// cooldown so one client cannot loop with new pubkeys.
const GLOBAL_MAX_PER_HOUR = Number(process.env.FAUCET_MAX_PER_HOUR || "60");
const dripTimes: number[] = [];
const lastDripByIp = new Map<string, number>();
const IP_COOLDOWN_MS = 60_000;

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") || "unknown";
}

/** Drop timestamps older than an hour, then report whether we are at the cap. */
function globalCapReached(now: number): boolean {
  const cutoff = now - 3_600_000;
  while (dripTimes.length > 0 && dripTimes[0]! < cutoff) dripTimes.shift();
  return dripTimes.length >= GLOBAL_MAX_PER_HOUR;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function loadOperator(): Keypair | null {
  // Try OPERATOR_KEYPAIR (raw JSON array or path), then the keeper key path.
  const raw = process.env.OPERATOR_KEYPAIR;
  const candidates = [
    raw && raw.trim().startsWith("[") ? raw : null, // inline JSON array
    raw && !raw.trim().startsWith("[") ? raw : null, // a path
    process.env.KEEPER_KEYPAIR,
    join(process.env.HOME || "/home/ec2-user", ".config/solana/id.json"),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try {
      const text = c.trim().startsWith("[") ? c : existsSync(c) ? readFileSync(c, "utf-8") : null;
      if (!text) continue;
      const secret = Uint8Array.from(JSON.parse(text));
      return Keypair.fromSecretKey(secret);
    } catch {
      /* try next */
    }
  }
  return null;
}

function loadUsdcMint(): PublicKey | null {
  // Prefer env, else read the committed deploy.json next to the app.
  if (process.env.USDC_MINT) {
    try {
      return new PublicKey(process.env.USDC_MINT);
    } catch {
      /* fall through */
    }
  }
  for (const p of [
    join(process.cwd(), "deploy.json"),
    join(process.cwd(), "..", "deploy.json"),
  ]) {
    try {
      if (existsSync(p)) {
        const m = JSON.parse(readFileSync(p, "utf-8"));
        if (m.usdcMint) return new PublicKey(m.usdcMint);
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function POST(req: NextRequest): Promise<Response> {
  let wallet: PublicKey;
  try {
    const body = await req.json();
    wallet = new PublicKey(String(body.wallet));
  } catch {
    return json({ ok: false, error: "Provide a valid base58 wallet pubkey." }, 400);
  }

  const key = wallet.toBase58();
  const now = Date.now();
  const prev = lastDrip.get(key) ?? 0;
  if (now - prev < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - prev)) / 1000);
    return json(
      { ok: false, error: `Please wait ${wait}s before requesting more test USDC.` },
      429
    );
  }

  const ip = clientIp(req);
  const prevIp = lastDripByIp.get(ip) ?? 0;
  if (ip !== "unknown" && now - prevIp < IP_COOLDOWN_MS) {
    const wait = Math.ceil((IP_COOLDOWN_MS - (now - prevIp)) / 1000);
    return json({ ok: false, error: `Please wait ${wait}s before requesting again.` }, 429);
  }
  if (globalCapReached(now)) {
    return json(
      { ok: false, error: "Faucet is rate limited right now. Try again later." },
      429
    );
  }
  // Reserve the slot BEFORE the awaited mint. Recording only on success makes the
  // window between check and mint a free-for-all for concurrent requests.
  lastDrip.set(key, now);
  lastDripByIp.set(ip, now);
  dripTimes.push(now);

  const operator = loadOperator();
  if (!operator) {
    return json(
      { ok: false, error: "Faucet is not configured on this server (no operator key)." },
      503
    );
  }
  const mint = loadUsdcMint();
  if (!mint) {
    return json({ ok: false, error: "USDC mint not found in deploy manifest." }, 503);
  }

  try {
    const conn = new Connection(BASE_RPC, "confirmed");
    // Create the requester's ATA if missing (operator pays), then mint to it.
    const ata = await getOrCreateAssociatedTokenAccount(
      conn,
      operator,
      mint,
      wallet
    );
    const atoms = BigInt(Math.round(FAUCET_USDC * 1_000_000));
    const sig = await mintTo(conn, operator, mint, ata.address, operator.publicKey, atoms);

    // (the cooldown slot was already reserved before the mint)
    return json({
      ok: true,
      signature: sig,
      ata: ata.address.toBase58(),
      amount: FAUCET_USDC,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Log the detail server-side only: RPC errors can embed the upstream URL, and
    // BASE_RPC_UPSTREAM may carry a private API key (the RPC proxy hides this for
    // the same reason).
    console.error("[faucet] mint failed:", msg);
    return json({ ok: false, error: "Faucet mint failed." }, 502);
  }
}
