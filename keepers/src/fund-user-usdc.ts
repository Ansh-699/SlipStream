import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, getAccount } from "@solana/spl-token";
import { loadKeypair, log } from "./shared/connection";
import { loadManifest, MANIFEST_PATH } from "./shared/manifest";

/**
 * Mint test USDC to a user wallet (operator is the live mint authority). SOL is
 * untouched. Run from the keepers package so module resolution + the deploy
 * manifest path both work:
 *
 *   USER=<pubkey> AMOUNT_USDC=50000 npx tsx src/fund-user-usdc.ts
 */
async function main() {
  const base = new Connection(process.env.BASE_RPC || "https://api.devnet.solana.com", "confirmed");
  const operator = loadKeypair();
  const user = new PublicKey(
    process.env.USER || "FQJKk3zjrMWRUjFaZ8BZuNzcpKjYKmAvVVQcPadDeA2r"
  );
  const amountUsdc = Number(process.env.AMOUNT_USDC || "50000");

  const manifest = loadManifest();
  if (!manifest.usdcMint) throw new Error(`usdcMint missing from ${MANIFEST_PATH}`);
  const mint = new PublicKey(manifest.usdcMint);

  log("FUND", `USDC mint: ${mint.toBase58()}`);
  log("FUND", `operator (mint authority): ${operator.publicKey.toBase58()}`);
  log("FUND", `user: ${user.toBase58()}`);

  const ata = await getOrCreateAssociatedTokenAccount(base, operator, mint, user);
  log("FUND", `user USDC ATA: ${ata.address.toBase58()}`);

  const atoms = BigInt(Math.round(amountUsdc * 1_000_000));
  const sig = await mintTo(base, operator, mint, ata.address, operator.publicKey, atoms);
  log("FUND", `minted ${amountUsdc} USDC -> ${sig}`);

  const acct = await getAccount(base, ata.address);
  log("FUND", `user USDC balance now: ${Number(acct.amount) / 1e6}`);
}

main().catch((e) => {
  console.error("fund-user-usdc failed:", e?.message ?? e);
  process.exit(1);
});
