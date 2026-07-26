/**
 * One-shot admin script: point a market's recorded oracle feeds at the live ones.
 *
 * Background: `initialize_market` was the only writer of `Market.pyth_feed` /
 * `Market.switchboard_feed`, and until the oracle-identity check landed nothing read
 * them. The operational Pyth feed was migrated from the legacy V2 aggregate to the
 * Receiver PriceUpdateV2 account, but the market kept pointing at the old one —
 * which is now frozen ~700 days stale at $139. This rewrites it via
 * set_market_oracle (0x25).
 *
 * Usage (from keepers/):
 *   npx tsx --env-file=.env src/set-market-oracle.ts [--dry-run]
 */
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getBaseConnection, loadKeypair, sendAndConfirm, log } from "./shared/connection";
import { getKeeperAddresses, loadManifest } from "./shared/manifest";

const IX_SET_MARKET_ORACLE = 0x25;

// Market field offsets (repr(C), see programs/slipstream/src/state/market.rs).
const OFF_PYTH_FEED = 80;
const OFF_SWITCHBOARD_FEED = 2024;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const connection = getBaseConnection();
  const addrs = getKeeperAddresses();
  const manifest = loadManifest();
  const authority = loadKeypair();

  if (!manifest.globalState) throw new Error("deploy.json is missing `globalState`");
  const globalState = new PublicKey(manifest.globalState);
  const switchboardFeed = new PublicKey(
    manifest.switchboardFeed ?? addrs.pythFeed.toBase58()
  );

  const before = await connection.getAccountInfo(addrs.market);
  if (!before) throw new Error(`market ${addrs.market.toBase58()} not found`);
  const currentPyth = new PublicKey(before.data.subarray(OFF_PYTH_FEED, OFF_PYTH_FEED + 32));
  const currentSb = new PublicKey(
    before.data.subarray(OFF_SWITCHBOARD_FEED, OFF_SWITCHBOARD_FEED + 32)
  );

  log("SET-ORACLE", `market             ${addrs.market.toBase58()}`);
  log("SET-ORACLE", `authority          ${authority.publicKey.toBase58()}`);
  log("SET-ORACLE", `pyth_feed   before ${currentPyth.toBase58()}`);
  log("SET-ORACLE", `pyth_feed   after  ${addrs.pythFeed.toBase58()}`);
  log("SET-ORACLE", `switchboard before ${currentSb.toBase58()}`);
  log("SET-ORACLE", `switchboard after  ${switchboardFeed.toBase58()}`);

  if (currentPyth.equals(addrs.pythFeed) && currentSb.equals(switchboardFeed)) {
    log("SET-ORACLE", "already correct — nothing to do");
    return;
  }
  if (dryRun) {
    log("SET-ORACLE", "--dry-run: not sending");
    return;
  }

  const data = Buffer.alloc(1 + 32 + 32);
  data[0] = IX_SET_MARKET_ORACLE;
  addrs.pythFeed.toBuffer().copy(data, 1);
  switchboardFeed.toBuffer().copy(data, 33);

  const ix = new TransactionInstruction({
    programId: addrs.programId,
    keys: [
      { pubkey: globalState, isSigner: false, isWritable: false },
      { pubkey: addrs.market, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });

  const sig = await sendAndConfirm(connection, new Transaction().add(ix), [authority]);
  log("SET-ORACLE", `sent ${sig}`);

  const after = await connection.getAccountInfo(addrs.market);
  const nowPyth = new PublicKey(after!.data.subarray(OFF_PYTH_FEED, OFF_PYTH_FEED + 32));
  log("SET-ORACLE", `verified pyth_feed ${nowPyth.toBase58()}`);
  if (!nowPyth.equals(addrs.pythFeed)) throw new Error("verification FAILED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
