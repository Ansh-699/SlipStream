# Slipstream keepers

Off-chain bots for the Slipstream perpetual-futures exchange. They resolve their
live addresses from the repo-root `deploy.json` (the Deploy_Manifest) via
`shared/manifest.ts`, share connection/keypair helpers in `shared/connection.ts`,
and use the client SDK builders/decoders in `../client/src`.

## Keepers

| Script | File | What it does |
| --- | --- | --- |
| `npm run settlement` | `src/settlement-keeper.ts` | Subscribes to OrderBook FillEvents on the ER and runs `record_pending_fill` + `settle_trades` on L1 (turns fills into positions). |
| `npm run funding` | `src/funding-keeper.ts` | Periodically computes funding. |
| `npm run liquidation` | `src/liquidation-keeper.ts` | Liquidates underwater positions. |
| `npm run twap` | `src/twap-keeper.ts` | Cranks the market TWAP from the live Pyth feed. |
| `npm run expiry` | `src/expiry-keeper.ts` | Handles expiries. |
| `npm run all` | — | Runs all of the above concurrently. |

## Simulation bots (devnet only)

These are **devnet simulation bots**, not production components. The live deploy
has no real users yet, so the bots generate realistic order-book activity —
resting liquidity, a moving price, fills, and the positions/funding/liquidation
paths downstream — so the frontend shows real depth and trades. The user
approved using bots to simulate trading.

There are two bots plus a one-time wallet provisioner:

- **`src/bot-setup.ts`** (`npm run bot-setup`) — load-or-create a small, fixed,
  persistent set of bot keypairs at `keepers/.bot-keys/*.json` (gitignored,
  reused across runs) and idempotently provision each for trading:
  top up SOL to a tiny target *only if below it*, mint USDC from the operator
  (the live mint authority), then run
  `initialize_user → deposit_collateral → initialize_trading_credit →
  fund_trading_credit → delegate_trading_credit → initialize_position`, skipping
  any step already done. **Run this once before starting the bots.**
- **`src/market-maker-bot.ts`** (`npm run market-maker`) — posts a two-sided
  `POST_ONLY` ladder around the live Pyth mid (feed
  `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`), cancelling and re-placing when
  the mid moves beyond a threshold. POST_ONLY means it never crosses (always a
  maker). Adds depth to the book.
- **`src/taker-bot.ts`** (`npm run taker`) — periodically crosses the spread with
  small 1-lot **IOC** orders biased toward mean-reversion around the Pyth mid,
  generating fills. (It uses IOC *limit* orders rather than MARKET because the
  deployed `place_order` derives MARKET slippage bounds from `last_mark_price`,
  which is stale on this market; an IOC limit priced through the top-of-book
  crosses cleanly and is still a pure taker.)
- **`npm run bots`** — runs the market-maker + taker concurrently.

### How the full simulation runs

The order book is **delegated to the MagicBlock ER**, so orders are placed there
and matched there, emitting FillEvents. The **settlement keeper is required** to
turn those fills into on-chain positions (`record_pending_fill` + `settle_trades`
on L1). So the full sim is the keepers and the bots running together:

```bash
# 1. one-time: provision the bot wallets (idempotent, safe to re-run)
npm run bot-setup

# 2. in one terminal: run the keepers (settlement turns fills into positions)
npm run all

# 3. in another terminal: run the bots (liquidity + trades)
npm run bots
```

Stop either with Ctrl-C. The bots are long-running by default; set `MAX_CYCLES=N`
to bound them (used by the smoke test).

### Configuration (env)

Wallet set / funding (`bot-setup`):

| Var | Default | Meaning |
| --- | --- | --- |
| `BOT_MM_COUNT` | `2` | number of market-maker wallets |
| `BOT_TAKER_COUNT` | `2` | number of taker wallets |
| `BOT_SOL_TARGET` | `0.08` | per-wallet SOL top-up target |
| `BOT_MINT_USDC` | `8000000000` | USDC (6-dp atoms) minted per wallet on first setup |
| `BOT_DEPOSIT_USDC` | `6000000000` | USDC deposited as collateral |
| `BOT_CREDIT_USDC` | `5000000000` | USDC moved into delegated trading credit |

Market maker:

| Var | Default | Meaning |
| --- | --- | --- |
| `BOT_MM_SPREAD_BPS` | `10` | per-step spread from mid |
| `BOT_MM_LEVELS` | `3` | levels per side |
| `BOT_MM_SIZE_LOTS` | `1` | lots per order (1 lot = 0.1 SOL) |
| `BOT_MM_INTERVAL_MS` | `5000` | cycle interval |
| `BOT_MM_REFRESH_BPS` | `15` | mid-move threshold to cancel/replace |

Taker:

| Var | Default | Meaning |
| --- | --- | --- |
| `BOT_TAKER_INTERVAL_MS` | `12000` | base cycle interval |
| `BOT_TAKER_JITTER_MS` | `6000` | random extra wait per cycle |
| `BOT_TAKER_CROSS_PROB` | `0.7` | probability a wallet trades in a cycle |
| `BOT_TAKER_SIZE_LOTS` | `1` | lots per taker order |
| `BOT_TAKER_MAX_SLIPPAGE_BPS` | `100` | max bps past top-of-book to price the IOC |
| `BOT_TAKER_REVERT_BIAS` | `0.7` | strength of the mean-reversion side bias |
| `MAX_CYCLES` | `0` (∞) | bound the bot to N cycles (smoke testing) |

### Cost / SOL & USDC

- **SOL is the scarce resource.** Each bot wallet is topped up to only
  `BOT_SOL_TARGET` (≈0.08 SOL) and reused across runs, so re-runs are mostly
  no-ops. Funding comes from the faucet first, falling back to a minimal operator
  System transfer for exactly the shortfall (the devnet faucet 429s).
- **USDC is free** here because the operator (`A5sV4Pkk…`) is the live USDC mint
  authority, so collateral/credit are minted as needed. Note the on-chain margin
  math scales base size (9-dp) against 6-dp credit, so one resting 0.1-SOL lot at
  ~$80 reserves a few hundred "USDC" of credit — hence the multi-thousand default
  credit per wallet. This costs no extra SOL.
- The `.bot-keys/` directory holds the persistent wallet secret keys. It is
  gitignored — never commit it.
