// Test-USDC faucet (devnet only). Server-side route: the operator key (the USDC
// mint authority) creates the requester's USDC ATA if needed and mints them a
// fixed amount of test USDC so a brand-new wallet can actually deposit.
//
//   POST /api/faucet  { "wallet": "<base58 pubkey>" }
//   -> { ok, signature, ata, amount, solSignature, sol, solError }
//    | { ok:false, error }
//
// `sol` is the amount topped up (0 when the wallet already had enough) and
// `solError` is true when the top-up was attempted and threw — the USDC mint
// still succeeded, but the wallet cannot pay fees yet, which is a different
// message from either of the other two.
//
// WHY: deposit_collateral transfers from the user's USDC token account. A fresh
// wallet has neither test USDC nor an ATA, so the deposit fails preflight with
// Phantom's generic "Unexpected error". This faucet removes that wall.
//
// SECURITY: this mints WORTHLESS devnet test tokens only. It is gated to a fixed
// amount, a simple in-memory per-wallet cooldown, and requires the operator key
// to be present on the server (OPERATOR_KEYPAIR). It is NOT for mainnet.
import { NextRequest } from "next/server";
import { PUBLIC_FALLBACKS, makeFailoverFetch, fallbackWsEndpoint } from "@/lib/rpc-failover";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { USDC_MINT as MANIFEST_USDC_MINT } from "@/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FAUCET_USDC = Number(process.env.FAUCET_USDC_AMOUNT || "10000"); // 10k test USDC

// Test USDC alone is not enough to get started: a freshly created embedded
// wallet holds no SOL, so it cannot pay the fees or the PDA rent that setup
// needs, and every deposit would fail at signing time. Top it up from the
// operator rather than the devnet airdrop faucet, which is aggressively rate
// limited and regularly refuses outright.
const FAUCET_SOL = Number(process.env.FAUCET_SOL_AMOUNT || "0.05");
/** Only top up below this, so repeat drips can't drain the operator. */
const SOL_TOPUP_FLOOR = Number(process.env.FAUCET_SOL_FLOOR || "0.02");
const COOLDOWN_MS = 60_000; // one drip per wallet per minute
const BASE_RPC =
  process.env.BASE_RPC_UPSTREAM ||
  process.env.BASE_RPC ||
  "https://api.devnet.solana.com";

/**
 * The faucet is the ONLY in-app source of both test USDC and the devnet SOL a
 * new wallet needs for fees and rent, so when it dies a new user cannot start
 * at all. During the 2026-09-01 quota outage it did exactly that: every drip
 * failed against the keyed upstream while /api/rpc/base served the whole
 * trading UI from the public fallback, and the 429 branch below told the
 * operator to configure BASE_RPC_UPSTREAM -- the variable that was broken.
 *
 * Both halves are needed. The fetch covers the reads and sends; pinning
 * wsEndpoint covers the CONFIRMS, because mintTo and sendAndConfirmTransaction
 * confirm over a signatureSubscribe websocket whose endpoint web3.js derives
 * from the HTTP url -- so without this a mint that had already landed would
 * still time out.
 */
const BASE_FALLBACK = PUBLIC_FALLBACKS.base;

// Per-wallet cooldown (best-effort; resets on server restart).
const lastDrip = new Map<string, number>();

// A per-wallet cooldown bounds nothing on its own: the wallet is supplied by the
// caller, and fresh keypairs are free. Every drip also makes the operator pay ATA
// rent, so an unbounded faucet drains the operator's SOL as well as minting
// unlimited collateral into the live market. Add a global rate cap and a per-IP
// cooldown so one client cannot loop with new pubkeys.
// 60/hr x (0.05 SOL + ~0.0015 ATA rent + fee) = ~3.1 SOL/hr, against an
// operator that holds 1.85 SOL: one IP could empty the fee payer in ~36
// minutes, and the same key signs every keeper, the USDC mint and the program
// upgrade. It has already gone to zero once, taking the fleet down for 79
// hours. 20/hr is ~1 SOL/hr, and RESERVE_LAMPORTS below is the real floor.
const GLOBAL_MAX_PER_HOUR = Number(process.env.FAUCET_MAX_PER_HOUR || "20");

/**
 * Never let the faucet take the operator below this. The operator key is also
 * every keeper's fee payer, the USDC mint authority and the program upgrade
 * authority: at zero SOL you cannot restart a keeper, run a repair
 * instruction, or deploy. USDC still mints below the reserve (it costs the
 * operator nothing but rent), so a new user is not blocked outright -- only
 * the SOL top-up stops, and the response already reports that as `solError`.
 */
const RESERVE_LAMPORTS = Number(process.env.FAUCET_SOL_RESERVE || "1") * LAMPORTS_PER_SOL;
const dripTimes: number[] = [];
const lastDripByIp = new Map<string, number>();
const IP_COOLDOWN_MS = 60_000;

/**
 * `dripTimes` is trimmed against the 1h cutoff; these two Maps were not, so
 * they only ever grew — keyed by caller-supplied pubkey and by IP, in a
 * long-lived server process. Fresh keypairs are free, which is the exact attack
 * the comment above anticipates, so the anticipated attacker also got an
 * unbounded memory leak. Swept on the same cadence as the drip list.
 */
function sweepCooldowns(now: number): void {
  for (const [k, t] of lastDrip) if (now - t > COOLDOWN_MS) lastDrip.delete(k);
  for (const [k, t] of lastDripByIp) if (now - t > IP_COOLDOWN_MS) lastDripByIp.delete(k);
}

/**
 * The client address, as far as it can be established.
 *
 * Caddy is the only hop in front of this origin (`via: 1.1 Caddy`, and the
 * hostname resolves straight to the droplet — there is no Cloudflare, so
 * cf-connecting-ip would just be one more forgeable key). Caddy APPENDS the
 * peer address to whatever X-Forwarded-For arrived, so the LEFTMOST entry is
 * whatever the caller typed and the RIGHTMOST is the one our own proxy wrote.
 * Reading the leftmost let `curl -H "X-Forwarded-For: 10.0.0.$i"` mint a fresh
 * cooldown bucket per request and loop the faucet dry. If a second trusted
 * proxy is ever put in front, this has to become "Nth from the right".
 *
 * No x-real-ip fallback: nothing in this deployment sets it, so it was only
 * ever reachable by a caller who bypassed Caddy — i.e. one who could also pick
 * its value. Such a caller now lands in the single "unknown" bucket instead,
 * which the cooldown below treats as rate-limited rather than exempt.
 */
function clientIp(req: NextRequest): string {
  const hops = (req.headers.get("x-forwarded-for") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return hops[hops.length - 1] || "unknown";
}

/**
 * True when the error only says the transaction could not be CONFIRMED in time
 * — it does NOT say the transaction failed.
 *
 * `mintTo` sends through web3.js `sendAndConfirmTransaction`, which throws
 * TransactionExpiredBlockheightExceededError / TransactionExpiredTimeoutError
 * when the blockhash expires (or the poll deadline passes) before a confirmation
 * is observed. On a loaded devnet those transactions routinely land anyway. A
 * send-side failure — build, sign, simulate, or the RPC refusing the submission
 * — throws something else, and only that proves nothing was minted.
 *
 * Same principle as lib/confirm.ts and the delegate path in use-session.ts: a
 * confirm timeout is UNKNOWN, not failed.
 */
function isConfirmUnknown(e: unknown): boolean {
  const err = e instanceof Error ? e : null;
  return (
    /TransactionExpired/.test(err?.name ?? "") ||
    /block height exceeded|blockhash.*expired|expired.*blockhash|not confirmed|unknown if it succeeded|timed out|timeout/i.test(
      err?.message ?? String(e)
    )
  );
}

/** Drop timestamps older than an hour, then report whether we are at the cap. */
function globalCapReached(now: number): boolean {
  const cutoff = now - 3_600_000;
  while (dripTimes.length > 0 && dripTimes[0]! < cutoff) dripTimes.shift();
  return dripTimes.length >= GLOBAL_MAX_PER_HOUR;
}

/** The only legal body is `{"wallet":"<44 chars>"}`. */
const MAX_BODY_BYTES = 1_000;

/**
 * Read the request body, refusing anything over `max` bytes. Returns null when
 * the body is too large. Same reasoning as the copy in api/rpc/[layer]:
 * `req.json()` buffers the WHOLE body first, so an unauthenticated 500 MB POST
 * to this route is ~1 GB of heap and a few concurrent ones OOM the Next process
 * — which takes the whole site down, faucet and dashboard alike. Content-Length
 * only lets us reject before reading a byte; it is absent on a chunked request
 * and caller-supplied either way, so the stream is counted for real. (Copied
 * rather than shared because Next rejects non-route exports from a route file.)
 */
async function readCapped(req: NextRequest, max: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return null;
  if (!req.body) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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
    // NOT ~/.config/solana/id.json. That fallback meant the faucet was enabled
    // by a FILE EXISTING rather than by configuration: on any dev machine this
    // route silently signed mints and SOL transfers with the developer's
    // personal default keypair. Opt in explicitly via FAUCET_KEYPAIR or
    // KEEPER_KEYPAIR, or the route reports itself unconfigured.
    process.env.FAUCET_ALLOW_DEFAULT_KEYPAIR === "1"
      ? join(process.env.HOME || "/root", ".config/solana/id.json")
      : null,
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
  // Prefer an explicit server-side override, else the SAME manifest module
  // the browser bundle uses (@/lib/manifest — NEXT_PUBLIC_USDC_MINT or
  // deploy-manifest.generated.json, copied at build time). This used to
  // independently re-read deploy.json off the server's disk, a second source
  // of truth that could silently diverge from what the UI actually shows
  // (e.g. disk deploy.json updated without a frontend rebuild).
  if (process.env.USDC_MINT) {
    try {
      return new PublicKey(process.env.USDC_MINT);
    } catch {
      /* fall through */
    }
  }
  return MANIFEST_USDC_MINT;
}

export async function POST(req: NextRequest): Promise<Response> {
  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (raw === null) {
    return json({ ok: false, error: "Request body too large." }, 413);
  }
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(String(JSON.parse(raw).wallet));
  } catch {
    return json({ ok: false, error: "Provide a valid base58 wallet pubkey." }, 400);
  }

  const key = wallet.toBase58();
  const now = Date.now();
  sweepCooldowns(now);
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
  // No `ip !== "unknown"` escape hatch: a caller who reaches this origin without
  // an X-Forwarded-For has bypassed our only proxy, and exempting exactly that
  // caller from the cooldown handed the loop to whoever wanted it most. They now
  // share one strict bucket instead.
  if (now - prevIp < IP_COOLDOWN_MS) {
    const wait = Math.ceil((IP_COOLDOWN_MS - (now - prevIp)) / 1000);
    return json({ ok: false, error: `Please wait ${wait}s before requesting again.` }, 429);
  }
  if (globalCapReached(now)) {
    return json(
      { ok: false, error: "Faucet is rate limited right now. Try again later." },
      429
    );
  }
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

  // Reserve the slot BEFORE the awaited mint: recording only on success makes the
  // window between check and mint a free-for-all for concurrent requests. It sits
  // BELOW the two config guards rather than above them because loadOperator() and
  // loadUsdcMint() are fully synchronous — nothing is awaited between the checks
  // above and this line, so the race window stays closed — and because reserving
  // above them meant a server with no OPERATOR_KEYPAIR burned a global slot per
  // request: after 60 accurate "not configured" replies, everyone (the operator
  // debugging it included) got "Faucet is rate limited right now" for an hour,
  // pointing the diagnosis at the wrong thing entirely.
  lastDrip.set(key, now);
  lastDripByIp.set(ip, now);
  dripTimes.push(now);

  // Whether the mint was actually submitted. Everything before it (ATA lookup /
  // creation) provably mints nothing, so a failure there is always safe to hand
  // the reservation back for; after it, a confirm timeout is not.
  let minting = false;
  try {
    const conn = new Connection(BASE_RPC, {
      commitment: "confirmed",
      fetch: makeFailoverFetch(BASE_RPC, BASE_FALLBACK),
      wsEndpoint: fallbackWsEndpoint(BASE_FALLBACK),
    });
    // Create the requester's ATA if missing (operator pays), then mint to it.
    const ata = await getOrCreateAssociatedTokenAccount(
      conn,
      operator,
      mint,
      wallet
    );
    const atoms = BigInt(Math.round(FAUCET_USDC * 1_000_000));
    minting = true;
    const sig = await mintTo(conn, operator, mint, ata.address, operator.publicKey, atoms);

    // Give the wallet enough SOL to actually use the USDC it just received.
    // Best-effort: the tokens are already minted, so a failure here should not
    // fail the whole request -- it just means the user tops up by hand.
    let solSignature: string | null = null;
    // Three states, not two: topped up, not needed, and TRIED AND FAILED. `sol`
    // alone collapsed the last two, so an operator out of devnet SOL produced
    // "Received 10000 test USDC. You can start trading now." printed directly
    // above the amber "this wallet needs a little devnet SOL" warning it
    // contradicts — and Start trading then failed at the preflight gate.
    let solError = false;
    if (FAUCET_SOL > 0) {
      try {
        const bal = await conn.getBalance(wallet);
        // Check the OPERATOR's balance too, not just the requester's.
        const opBal = await conn.getBalance(operator.publicKey);
        const wouldLeave = opBal - Math.round(FAUCET_SOL * LAMPORTS_PER_SOL);
        if (wouldLeave < RESERVE_LAMPORTS) {
          console.error(
            `[faucet] SOL top-up skipped: operator at ${(opBal / LAMPORTS_PER_SOL).toFixed(4)} SOL, reserve is ${(RESERVE_LAMPORTS / LAMPORTS_PER_SOL).toFixed(2)}`
          );
          solError = true;
        } else if (bal < SOL_TOPUP_FLOOR * LAMPORTS_PER_SOL) {
          solSignature = await sendAndConfirmTransaction(
            conn,
            new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: operator.publicKey,
                toPubkey: wallet,
                lamports: Math.round(FAUCET_SOL * LAMPORTS_PER_SOL),
              })
            ),
            [operator]
          );
        }
      } catch (e) {
        solError = true;
        console.error("[faucet] SOL top-up failed:", e instanceof Error ? e.message : String(e));
      }
    }

    // (the cooldown slot was already reserved before the mint)
    return json({
      ok: true,
      signature: sig,
      ata: ata.address.toBase58(),
      amount: FAUCET_USDC,
      solSignature,
      sol: solSignature ? FAUCET_SOL : 0,
      solError,
    });
  } catch (e) {
    // A drip that PROVABLY minted nothing must hand the reservation back: without
    // that the route told the user "Wait a few seconds and try again" and then
    // refused the retry it had just asked for with "Please wait 55s" — on a wallet
    // that received nothing, at the one step (`Get test USDC`) that gates all of
    // onboarding.
    //
    // But a mint that could not be CONFIRMED in time is not that case: it may well
    // have landed, and handing the cooldown back there drops the only thing
    // stopping a second 10k USDC drip (plus the per-IP and global-hourly bounds)
    // for a wallet that already has the first. Unknown is not failed — keep the
    // reservation and say so.
    const unconfirmed = minting && isConfirmUnknown(e);
    if (!unconfirmed) {
      // `lastIndexOf`, not `pop()`: a concurrent request may have pushed after us.
      lastDrip.delete(key);
      lastDripByIp.delete(ip);
      const slot = dripTimes.lastIndexOf(now);
      if (slot >= 0) dripTimes.splice(slot, 1);
    }

    const msg = e instanceof Error ? e.message : String(e);
    // Log the detail server-side only: RPC errors can embed the upstream URL, and
    // BASE_RPC_UPSTREAM may carry a private API key (the RPC proxy hides this for
    // the same reason). Classify into safe categories instead of echoing it --
    // "Faucet mint failed" alone sends people hunting for a bug in the faucet
    // when the actual cause is usually the public devnet RPC throttling us.
    console.error(unconfirmed ? "[faucet] mint not confirmed:" : "[faucet] mint failed:", msg);
    if (unconfirmed) {
      return json(
        {
          ok: false,
          error:
            "The mint was sent but we could not confirm it in time. It may still land — check your USDC balance in a few seconds before requesting again.",
        },
        504
      );
    }
    if (/\b429\b|too many requests|rate limit/i.test(msg)) {
      return json(
        {
          ok: false,
          error:
            "The devnet RPC is rate limiting us. Wait a few seconds and try again — or configure a dedicated RPC via BASE_RPC_UPSTREAM.",
        },
        503
      );
    }
    if (/insufficient (lamports|funds)/i.test(msg)) {
      return json(
        { ok: false, error: "The faucet operator is out of devnet SOL. Top it up and retry." },
        503
      );
    }
    return json({ ok: false, error: "Faucet mint failed." }, 502);
  }
}
