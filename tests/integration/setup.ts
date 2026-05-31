import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import {
  createDelegateInstruction,
  createCommitAndUndelegateInstruction,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import * as fs from "fs";
import * as path from "path";

export const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "7qujfsb4ZPbQHYVZdqiXq1r8tVAMyyukX94obPqXbVwz"
);

export const DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
);

export const PYTH_SOL_USD = new PublicKey(
  "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"
);

export const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
export const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";

export function loadKeypair(pathStr?: string): Keypair {
  const kpPath = pathStr || path.join(process.env.HOME || "~", ".config/solana/id.json");
  const raw = fs.readFileSync(kpPath, "utf-8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

// ---------------------------------------------------------------------------
// SOL hygiene: persistent + reused test keypairs.
//
// The live re-run scripts previously generated fresh throwaway keypairs every
// run; when the devnet faucet 429'd, the operator-transfer fallback funded each
// with ~2 SOL that was then stranded (the throwaway key is never reused). Over
// many runs this drained the operator. Instead we PERSIST a small set of test
// keypairs on disk under `.test-keys/` (gitignored) and REUSE them every run,
// topping each up to a tiny fixed balance only when it falls below the target.
// ---------------------------------------------------------------------------
export const TEST_KEYS_DIR = path.join(__dirname, ".test-keys");

/** Tiny per-trader SOL target — just enough for PDA rents + a few tx fees. */
export const TEST_KEY_TARGET_SOL = 0.05;

/**
 * Load a named test keypair from `.test-keys/<name>.json`, creating (and saving)
 * it on first use. Reusing the same keys across runs means rent already paid on
 * a prior run is reused rather than re-stranded on a fresh throwaway key.
 */
export function loadOrCreateTestKeypair(name: string): Keypair {
  if (!fs.existsSync(TEST_KEYS_DIR)) {
    fs.mkdirSync(TEST_KEYS_DIR, { recursive: true });
  }
  const kpPath = path.join(TEST_KEYS_DIR, `${name}.json`);
  if (fs.existsSync(kpPath)) {
    try {
      const secret = Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf-8")));
      return Keypair.fromSecretKey(secret);
    } catch {
      /* fall through to regenerate a corrupt file */
    }
  }
  const kp = Keypair.generate();
  fs.writeFileSync(kpPath, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`  created persistent test key ${name} -> ${kp.publicKey.toBase58()}`);
  return kp;
}

/**
 * Top a key up to `targetSol` ONLY if its balance is below it (small, idempotent
 * funding). Tries the faucet first, then a tiny operator transfer for exactly the
 * shortfall. Conserves operator SOL: re-runs that still hold the target are no-ops.
 */
export async function ensureMinBalance(
  connection: Connection,
  pubkey: PublicKey,
  targetSol: number = TEST_KEY_TARGET_SOL
): Promise<void> {
  const targetLamports = Math.floor(targetSol * 1e9);
  const bal = await connection.getBalance(pubkey);
  if (bal >= targetLamports) {
    console.log(
      `  ${pubkey.toBase58().slice(0, 8)}… already has ${(bal / 1e9).toFixed(4)} SOL (>= ${targetSol}); no top-up`
    );
    return;
  }
  const shortfall = targetLamports - bal;

  // Faucet first (free); fall back to a minimal operator transfer for the shortfall.
  try {
    const sig = await connection.requestAirdrop(pubkey, shortfall);
    await connection.confirmTransaction(sig);
    console.log(`  topped up ${pubkey.toBase58().slice(0, 8)}… by ${(shortfall / 1e9).toFixed(4)} SOL (faucet)`);
    return;
  } catch {
    /* faucet rate-limited; fall back to operator */
  }

  const operator = loadKeypair();
  if (pubkey.equals(operator.publicKey)) return; // operator funds itself
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: pubkey, lamports: shortfall })
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [operator]);
  console.log(
    `  topped up ${pubkey.toBase58().slice(0, 8)}… by ${(shortfall / 1e9).toFixed(4)} SOL (operator ${sig.slice(0, 8)}…)`
  );
}

/**
 * Best-effort SOL recovery: sweep a test key's balance (minus a small fee
 * reserve) back to the operator. Used at the end of a run so reused keys keep a
 * tiny float but don't accumulate. Never throws.
 */
export async function sweepToOperator(
  connection: Connection,
  from: Keypair,
  keepSol: number = TEST_KEY_TARGET_SOL
): Promise<void> {
  try {
    const keep = Math.floor(keepSol * 1e9);
    const feeReserve = 5_000;
    const bal = await connection.getBalance(from.publicKey);
    const sweepable = bal - keep - feeReserve;
    if (sweepable <= 0) return;
    const operator = loadKeypair();
    if (from.publicKey.equals(operator.publicKey)) return;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: operator.publicKey,
        lamports: sweepable,
      })
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [from]);
    console.log(
      `  swept ${(sweepable / 1e9).toFixed(4)} SOL from ${from.publicKey.toBase58().slice(0, 8)}… back to operator (${sig.slice(0, 8)}…)`
    );
  } catch {
    /* recovery is best-effort */
  }
}

export function getBaseConnection(): Connection {
  return new Connection(BASE_RPC, "confirmed");
}

export function getErConnection(): Connection {
  return new Connection(ER_RPC, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 15_000,
  });
}

export async function airdrop(connection: Connection, pubkey: PublicKey, sol: number = 2) {
  const lamports = Math.floor(sol * 1e9);

  // First, try the devnet faucet.
  try {
    console.log(`Airdropping ${sol} SOL to ${pubkey.toBase58()}...`);
    const sig = await connection.requestAirdrop(pubkey, lamports);
    await connection.confirmTransaction(sig);
    console.log("  Airdrop confirmed");
    return;
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.log(`  Airdrop failed (${msg}); falling back to operator transfer`);
  }

  // Fallback: transfer SOL from the funded operator keypair (~/.config/solana/id.json).
  // Keeps the test deterministic when the devnet faucet is rate-limited (HTTP 429).
  // Test-only funding path — does not touch protocol logic.
  const operator = loadKeypair();

  // If the funding target IS the operator, it is already funded — nothing to do.
  if (pubkey.equals(operator.publicKey)) {
    const bal = await connection.getBalance(operator.publicKey);
    console.log(
      `  Target is operator (already funded: ${(bal / 1e9).toFixed(4)} SOL); skipping transfer`
    );
    return;
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: operator.publicKey,
      toPubkey: pubkey,
      lamports,
    })
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [operator]);
  console.log(`  Operator transfer confirmed: ${sig}`);
}

export function findPda(seeds: (Buffer | Uint8Array)[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

export function findGlobalStatePda(): [PublicKey, number] {
  return findPda([Buffer.from("global")]);
}

export function findMarketPda(marketIndex: number): [PublicKey, number] {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(marketIndex);
  return findPda([Buffer.from("market"), buf]);
}

export function findUserPda(owner: PublicKey): [PublicKey, number] {
  return findPda([Buffer.from("user"), owner.toBuffer()]);
}

export function findPositionPda(owner: PublicKey, marketIndex: number): [PublicKey, number] {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(marketIndex);
  return findPda([Buffer.from("position"), owner.toBuffer(), buf]);
}

export function findOrderBookPda(marketIndex: number): [PublicKey, number] {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(marketIndex);
  return findPda([Buffer.from("orderbook"), buf]);
}

export function findVaultAuthorityPda(): [PublicKey, number] {
  return findPda([Buffer.from("vault_authority")]);
}

export async function createQuoteVault(
  connection: Connection,
  payer: Keypair
): Promise<{ mint: PublicKey; vault: PublicKey }> {
  console.log("Creating USDC mint and vault...");

  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    6 // USDC decimals
  );

  const vault = await createAccount(connection, payer, mint, payer.publicKey);

  console.log(`  Mint: ${mint.toBase58()}`);
  console.log(`  Vault: ${vault.toBase58()}`);

  return { mint, vault };
}

export async function fundUserTokenAccount(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  user: PublicKey,
  amount: number = 10_000
): Promise<PublicKey> {
  console.log(`Funding ${user.toBase58()} with ${amount} USDC...`);

  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint, user);

  await mintTo(connection, payer, mint, ata.address, payer.publicKey, amount * 1e6);

  console.log(`  User token account: ${ata.address.toBase58()}`);
  return ata.address;
}

export async function delegateAccount(
  connection: Connection,
  payer: Keypair,
  account: PublicKey,
  validUntil: number = 0
): Promise<string> {
  console.log(`Delegating ${account.toBase58()} to ER...`);

  const ix = createDelegateInstruction({
    payer: payer.publicKey,
    delegatedAccount: account,
    ownerProgram: PROGRAM_ID,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);

  console.log(`  Delegation sig: ${sig}`);
  return sig;
}

export async function undelegateAccount(
  connection: Connection,
  payer: Keypair,
  account: PublicKey
): Promise<string> {
  console.log(`Undelegating ${account.toBase58()}...`);

  const ix = createCommitAndUndelegateInstruction(payer.publicKey, [account]);

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);

  console.log(`  Undelegation sig: ${sig}`);
  return sig;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function checkAccountOwner(
  connection: Connection,
  account: PublicKey
): Promise<PublicKey | null> {
  const info = await connection.getAccountInfo(account);
  return info?.owner || null;
}

export async function isDelegated(connection: Connection, account: PublicKey): Promise<boolean> {
  const owner = await checkAccountOwner(connection, account);
  return owner?.equals(DELEGATION_PROGRAM_ID) ?? false;
}

export function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
