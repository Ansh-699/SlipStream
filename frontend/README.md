# Slipstream Frontend

Next.js trading interface for the Slipstream on-chain perpetual-futures CLOB.
Streams a live Pyth price chart, renders the ER order book, and lets a connected
wallet trade (margin × leverage), manage positions, and run a trading session.

> Part of the [Slipstream](../README.md) monorepo. This is a **devnet** app.

## Architecture (frontend-relevant)

- **Two RPC layers via same-origin proxies.** The browser cannot call the
  MagicBlock ER directly (CORS), so all RPC goes through Next API routes:
  - `POST /api/rpc/base` → Solana L1 (positions, collateral, funding)
  - `POST /api/rpc/er` → MagicBlock ER (orders, live book)
- **Live prices.** `GET /api/pyth/history` proxies Pyth Benchmarks for historical
  OHLC; the live tick stream comes from Pyth Hermes SSE.
- **Addresses** are resolved at build time from `deploy.json` (copied into
  `src/lib/deploy-manifest.generated.json` by `scripts/copy-manifest.mjs`), with
  optional `NEXT_PUBLIC_*` overrides.

## Local development

```bash
npm install
npm run dev        # http://localhost:3000  (runs copy-manifest first)
```

## Environment variables

Mostly optional — the build falls back to the committed `deploy.json`. The one
worth setting on any real deployment is `BASE_RPC_UPSTREAM`: Solana's public
devnet endpoint rate-limits aggressively, and when it does the faucet returns
503 and balances stop loading. A free devnet key from Helius, Alchemy or
QuickNode resolves it, and the same value serves both the RPC proxy and the
faucet.

| Variable | Purpose | Default |
|---|---|---|
| `BASE_RPC_UPSTREAM` | L1 RPC used by both the `/api/rpc/base` proxy and the faucet. **Set this** — the default public endpoint throttles hard (HTTP 429) and the faucet fails with it | `https://api.devnet.solana.com` |
| `ER_RPC_UPSTREAM` | ER RPC the `/api/rpc/er` proxy forwards to | `https://devnet.magicblock.app` |
| `PYTH_BENCHMARKS_UPSTREAM` | Pyth Benchmarks history upstream | Pyth public endpoint |
| `NEXT_PUBLIC_PROGRAM_ID` | Override program ID | from `deploy.json` |
| `NEXT_PUBLIC_MARKET` | Override market address | from `deploy.json` |
| `NEXT_PUBLIC_ORDER_BOOK` | Override orderbook address | from `deploy.json` |
| `NEXT_PUBLIC_RPC_URL` / `NEXT_PUBLIC_ER_RPC` | Override direct RPC URLs | from `deploy.json` |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy app ID (dashboard.privy.io). **Required** — the wallet provider throws by name without it. Enable Google + Wallet login and Solana embedded wallets on the app, and allowlist the site origin | none |
| `PRIVY_APP_ID` | Same id, server-side, for verifying faucet access tokens | none |
| `PRIVY_VERIFICATION_KEY` | Optional ES256 verification key (SPKI PEM, Settings → Basics). With it the faucet verifies tokens offline; without it Privy's JWKS is fetched on first use | none |

## Production build

```bash
npm run build      # runs copy-manifest, then next build
npm start          # serve the production build
```

## Deploy

The live deployment runs the Next.js app under pm2 behind nginx on the project
server. `npm run build && npm start` produces the production server; point a
reverse proxy at port 3000.
