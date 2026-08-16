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

All optional — the build falls back to the committed `deploy.json`. Set these to
point at a different deployment without editing code:

| Variable | Purpose | Default |
|---|---|---|
| `BASE_RPC_UPSTREAM` | L1 RPC the `/api/rpc/base` proxy forwards to | `https://api.devnet.solana.com` |
| `ER_RPC_UPSTREAM` | ER RPC the `/api/rpc/er` proxy forwards to | `https://devnet.magicblock.app` |
| `PYTH_BENCHMARKS_UPSTREAM` | Pyth Benchmarks history upstream | Pyth public endpoint |
| `NEXT_PUBLIC_PROGRAM_ID` | Override program ID | from `deploy.json` |
| `NEXT_PUBLIC_MARKET` | Override market address | from `deploy.json` |
| `NEXT_PUBLIC_ORDER_BOOK` | Override orderbook address | from `deploy.json` |
| `NEXT_PUBLIC_RPC_URL` / `NEXT_PUBLIC_ER_RPC` | Override direct RPC URLs | from `deploy.json` |
| `NEXT_PUBLIC_PHANTOM_APP_ID` | Phantom Portal app ID. Required for Google/Apple embedded wallets; without it only the Phantom browser extension ("injected") is offered | none |
| `NEXT_PUBLIC_PHANTOM_REDIRECT_URL` | OAuth redirect target, must be allowlisted in the Phantom Portal | `<origin>/auth/callback` |

## Production build

```bash
npm run build      # runs copy-manifest, then next build
npm start          # serve the production build
```

## Deploy

The live deployment runs the Next.js app under pm2 behind nginx on the project
server. `npm run build && npm start` produces the production server; point a
reverse proxy at port 3000.
