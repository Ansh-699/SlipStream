// pm2 ecosystem for the SlipStream keepers + market-maker (production box).
// Each is a long-running tsx process. --env-file loads keepers/.env
// (BASE_RPC / ER_RPC / KEEPER_KEYPAIR / DEPLOY_MANIFEST) into process.env.
//
// Usage (from keepers/):  pm2 start ecosystem.config.js
const path = require("path");
const KEEPERS = __dirname;
const TSX = path.join(KEEPERS, "node_modules/.bin/tsx");
const ENV_FILE = path.join(KEEPERS, ".env");

function keeper(name, script, extraEnv) {
  return {
    name: `slipstream-${name}`,
    cwd: KEEPERS,
    script: TSX,
    args: `--env-file=${ENV_FILE} src/${script}`,
    interpreter: "none",
    autorestart: true,
    // A keeper that dies within 30s is crash-looping; stop after 50 tries
    // instead of restarting forever (a boot-time crash loop once burned the
    // RPC quota at ~1 restart/18s for days).
    min_uptime: "30s",
    max_restarts: 50,
    restart_delay: 5000,
    env: extraEnv || {},
    out_file: path.join(process.env.HOME || "/root", `.pm2/logs/${name}-out.log`),
    error_file: path.join(process.env.HOME || "/root", `.pm2/logs/${name}-err.log`),
  };
}

module.exports = {
  apps: [
    keeper("fill-log", "fill-log-keeper.ts"),
    keeper("funding", "funding-keeper.ts"),
    keeper("liquidation", "liquidation-keeper.ts"),
    keeper("twap", "twap-keeper.ts"),
    keeper("expiry", "expiry-keeper.ts"),
    // Market maker: deep, tight two-sided liquidity around the live Pyth mid so
    // normal-sized orders fill within slippage and an eaten side refills fast.
    // 2 wallets × 6 levels × 2.0 SOL/order ≈ 24 SOL depth per side, both inside
    // the 100 bps band. Replenishes when a side is eaten (price defense).
    // 2s cadence: the previous 1s cadence roughly doubled base-RPC usage for
    // no visible depth benefit and contributed to quota exhaustion.
    keeper("market-maker", "market-maker-bot.ts", {
      // mm-v2: the original mm-0/mm-1 TradingCredits are stuck half-delegated
      // (L1 says delegated so fund_trading_credit refuses; the ER never took
      // ownership so the magic program refuses to undelegate). A credit PDA
      // derives from the owner key, so fresh wallets are the only way out.
      BOT_MM_PREFIX: "mm-v2",
      BOT_MM_COUNT: "2",
      BOT_MM_SIZE_LOTS: "20", // 20 lots × 0.1 SOL = 2.0 SOL per order
      BOT_MM_LEVELS: "6",
      BOT_MM_SPREAD_BPS: "2",
      BOT_MM_INTERVAL_MS: "2000",
      BOT_MM_REFRESH_BPS: "8",
    }),
    // Taker: continuously crosses the MM's book so the demo shows live fills
    // (Recent Trades / Trade History / toasts / the fills indexer all need real
    // fills to move). Idles harmlessly when its trading credit runs low —
    // topup-takers refills it. Modest cadence to keep base-RPC load in check.
    keeper("taker", "taker-bot.ts", {
      // taker-v2: same half-delegated credit deadlock as mm — see BOT_MM_PREFIX.
      BOT_TAKER_PREFIX: "taker-v2",
      BOT_TAKER_INTERVAL_MS: "15000",
      BOT_TAKER_JITTER_MS: "8000",
      BOT_TAKER_CROSS_PROB: "0.8",
      BOT_TAKER_SIZE_LOTS: "2",
    }),
  ],
};
