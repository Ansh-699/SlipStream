// pm2 ecosystem for the SlipStream keepers + market-maker (production box).
// Each is a long-running tsx process. --env-file loads keepers/.env
// (BASE_RPC / ER_RPC / KEEPER_KEYPAIR / DEPLOY_MANIFEST) into process.env.
//
// Usage (from keepers/):  pm2 start ecosystem.config.js
//
// Log rotation: the out_file/error_file paths below grow unbounded on their
// own — pm2 does not rotate app logs by default. Install pm2's own log
// rotation module ONCE per box (not per-app, no ecosystem.config.js change
// needed):
//   pm2 install pm2-logrotate
//   pm2 set pm2-logrotate:max_size 50M
//   pm2 set pm2-logrotate:retain 14
// For the SQLite fills indexer (keepers/data/fills.db, separate from these
// logs), see INDEXER_RETENTION_DAYS in .env.example.
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
    // Set on the production box (kept): keepers sit ~58M, so 220M is a leak
    // guard, not a normal-operation bound. A memory restart counts against
    // max_restarts, which is why that ceiling is raised rather than removed.
    max_memory_restart: "220M",
    // S7-02. The quota burn this policy was written against is a restart *rate*
    // problem, but `max_restarts: 50` + `restart_delay: 5000` bounded the
    // restart *count*: ~4 minutes of boot-time failure exhausted the budget and
    // pm2 parked the app in `errored` permanently, silently, until a human ran
    // `pm2 restart`. That converted every transient RPC outage into an
    // indefinite one -- the failure mode that left this fleet down for 17 days.
    //
    // exp_backoff_restart_delay is pm2's own answer: the delay grows
    // exponentially from 5s and caps at 15s, so a sustained outage costs ~4
    // boot attempts/minute instead of 12, while the process is still trying
    // when the RPC comes back. max_restarts is raised past any real outage
    // rather than removed, because pm2's default when it is absent is 16 --
    // stricter than the value being replaced. pm2 resets the counter once the
    // app stays up past min_uptime, so a keeper that recovers starts clean.
    min_uptime: "30s",
    max_restarts: 10000,
    exp_backoff_restart_delay: 5000,
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
