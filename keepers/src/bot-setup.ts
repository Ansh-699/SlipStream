import { getBaseConnection, getErConnection, log } from "./shared/connection";
import { getKeeperAddresses } from "./shared/manifest";
import {
  loadBotWallets,
  setupBotWallet,
  getOperator,
  getBotCounts,
  fmtUsdc,
  type BotWalletState,
} from "./shared/bot-wallets";

/**
 * bot-setup — idempotently provision the configured set of simulation bot
 * wallets (market makers + takers) for trading on the live SOL-PERP market.
 *
 * Run this ONCE before starting the bots. It is safe to re-run: each wallet is
 * topped up to a tiny SOL target only if below it, USDC is minted + credit
 * funded/delegated only when not already provisioned, and every account-creating
 * step is skipped when the account already exists.
 *
 *   BOT_MM_COUNT=2 BOT_TAKER_COUNT=2 npm run bot-setup
 *
 * Reports operator SOL before/after so the (tiny) cost of a run is visible.
 */
async function main() {
  const base = getBaseConnection();
  const er = getErConnection();
  const operator = getOperator();
  const addrs = getKeeperAddresses();
  const counts = getBotCounts();

  log("bot-setup", `operator ${operator.publicKey.toBase58()}`);
  log("bot-setup", `market=${addrs.market.toBase58()} index=${addrs.marketIndex} orderBook=${addrs.orderBook.toBase58()}`);
  log("bot-setup", `provisioning ${counts.mm} market-maker + ${counts.taker} taker wallet(s)`);

  const opSolBefore = (await base.getBalance(operator.publicKey)) / 1e9;
  log("bot-setup", `operator SOL before: ${opSolBefore.toFixed(6)}`);

  const wallets = loadBotWallets(counts);
  const states: BotWalletState[] = [];
  for (const w of wallets) {
    try {
      states.push(await setupBotWallet(base, er, operator, w));
    } catch (e: any) {
      log("bot-setup", `ERROR provisioning ${w.name}: ${e?.message ?? e}`);
      throw e;
    }
  }

  const opSolAfter = (await base.getBalance(operator.publicKey)) / 1e9;

  console.log("\n=== bot-setup summary ===");
  for (const s of states) {
    console.log(
      `  ${s.role.padEnd(5)} ${s.name.padEnd(8)} ${s.pubkey}  sol=${s.solBalance.toFixed(4)} ` +
        `credit=${fmtUsdc(s.creditTotal)} avail=${fmtUsdc(s.creditAvailable)} delegated=${s.creditDelegated} pos=${s.positionInitialized}`
    );
  }
  console.log(`\noperator SOL: ${opSolBefore.toFixed(6)} -> ${opSolAfter.toFixed(6)} (spent ${(opSolBefore - opSolAfter).toFixed(6)})`);
  console.log("bot-setup complete. Start the bots with `npm run bots` (and the keepers with `npm run all`).");
}

main().catch((err) => {
  console.error("bot-setup crashed:", err?.message ?? err);
  process.exit(1);
});
