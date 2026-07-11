<h1 align="center">Slipstream</h1>
<p align="center">
  <img src="frontend/assets/banner-slipstream.png" alt="Slipstream" width="620" height="300" />
</p>

<p align="center">
  <a href="https://slipstream.ansht.tech"><strong>🌐 Live demo</strong></a> &nbsp;·&nbsp;
  <a href="https://slipstream.ansht.tech/docs">📚 Docs</a>
</p>

<p align="center">
  <strong>On-chain perpetual-futures CLOB on Solana  order matching at rollup speed, custody at L1 security.
  Devnet MVP deployed and verified on Solana devnet + the MagicBlock devnet Ephemeral Rollup.</strong>
</p>

<p align="center">
  <em></em>
</p>


---

## What it is

Slipstream is an **on-chain perpetual-futures exchange** built around a **central-limit
order book (CLOB)** — the same price-time-priority matching model real exchanges use,
not an AMM. It tracks **SOL/USD** with leverage up to 20×, funding, and liquidations.

The hard problem it solves: a real CLOB needs thousands of fast, cheap order updates,
which Solana's base layer (L1) can't host directly — but L1 *can* custody money safely.
Slipstream **splits the system**:

- **Order matching** runs inside a [MagicBlock](https://www.magicblock.gg/) **Ephemeral
  Rollup (ER)** at ~10 ms — fast, sponsored, ideal for high-frequency quoting.
- **All value-bearing state** (collateral, positions, the token vault, funding) stays on
  **Solana L1**, where it is never delegated and therefore never at risk from the ER.

> **The one safety fact that matters:** only the non-financial **OrderBook** account is
> delegated to the ER. Funds never leave L1, so a misbehaving ER can at worst scramble
> order *ordering* — it can never move money.

## What it does

| Capability | Status |
|---|---|
| Limit + market orders, price-time-priority matching in the ER | ✅ live |
| Margin × leverage (up to 20×), real notional/PnL accounting | ✅ live |
| ER → L1 settlement into real `Position` accounts (FillLog pipeline) | ✅ live |
| Funding rate (8h interval, self-computed 30-min TWAP) | ✅ live, keeper-cranked |
| Liquidations (health factor, liq price) | ✅ live, keeper-cranked |
| Session keys (sign once, trade many — no popup per order) | ✅ live |
| Live Pyth price chart (SSE stream + real OHLC history) | ✅ live |
| On-chain order book held in a single ~612 KB PDA | ✅ live |

## How it does it

```mermaid
flowchart TB
  subgraph FE["Frontend · Next.js"]
    UI["Wallet · Margin × Leverage Order Form<br/>Live Pyth Charts · Order Book · Positions"]
  end

  subgraph ER["MagicBlock ER · ~10ms blocks"]
    OB["OrderBook (612KB)<br/>delegated execution"]
  end

  subgraph L1["Solana L1"]
    BASE["Collateral · Vaults<br/>Positions · Funding<br/>(never delegated)"]
  end

  KEEP["Keepers (pm2 bots)<br/>settlement · funding · liquidation · twap · expiry"]

  UI -->|"/api/rpc/er (orders)"| OB
  UI -->|"/api/rpc/base (positions, balances)"| BASE
  OB -->|"commit via small FillLog"| BASE
  KEEP --> OB
  KEEP --> BASE
```

- **Program** (`programs/`): written in **Pinocchio** (minimal, zero-dep Solana SDK).
  The 612 KB order book is one flat `#[repr(C)]`/`Pod` account read via **zero-copy**
  slices and grown in 10 KB chunks (Solana's per-CPI growth cap). 34 instructions.
- **Settlement** (`FillLog` pipeline): because the 612 KB book can't be committed to L1
  (size cap + a verified 10-commit-per-account limit), a tiny ~8 KB epoch-rotatable
  FillLog carries fills L1-ward: `mirror_fills` (ER) → `commit_fill_log` (ER→L1) →
  `settle_from_log` (L1). The book stays delegated forever, never committed.
- **Client SDK** (`client/`): PDA derivation, account decoders, instruction builders.
- **Keepers** (`keepers/`): off-chain bots that crank funding, liquidation, TWAP, expiry,
  and the settlement pipeline.
- **Frontend** (`frontend/`): Next.js app; routes all RPC through same-origin proxies to
  avoid CORS and stream live Pyth prices.

📖 **Full technical deep-dive:** [`docs/`](./docs/README.md) — 8 docs covering the
architecture, PDA storage, ephemeral rollups, the settlement pipeline, margin/funding/
liquidation math, session keys, the problems-and-solutions tour, and a glossary.

## Try it

The fastest way is the live demo at **[slipstream.ansht.tech](https://slipstream.ansht.tech)**.
You'll need a Solana wallet (Phantom/Solflare/Backpack) set to **devnet**. See
[**New-user walkthrough**](#new-user-walkthrough) below for the exact click path
(get devnet SOL → deposit test USDC → fund credit → delegate to the ER → trade).

## Run / check locally

### Prerequisites
- Node 20+, a Solana wallet on **devnet**.
- (Only to rebuild the on-chain program: Rust + Solana CLI + `cargo build-sbf`.)

### Frontend
```bash
cd frontend
npm install
npm run dev          # http://localhost:3000
```
The build reads live on-chain addresses from the committed `deploy.json` (copied into the
app by `scripts/copy-manifest.mjs`). No env vars are required to run against the live
devnet deployment. To point at a different RPC, set `BASE_RPC_UPSTREAM` / `ER_RPC_UPSTREAM`
(see [`frontend/README.md`](./frontend/README.md)).

### Verify functionality
```bash
# Program unit tests (math, state, settlement helpers)
cargo test --manifest-path programs/slipstream/Cargo.toml

# Frontend production build (type-checks + compiles)
cd frontend && npm run build
```

### Keepers (optional, for a self-hosted deployment)
```bash
cd keepers
cp .env.example .env       # set BASE_RPC / ER_RPC / KEEPER_KEYPAIR
npm install
npm run funding            # or: liquidation · twap · expiry · fill-log-keeper
```

### On-chain addresses (devnet)
Source of truth is [`deploy.json`](./deploy.json). Current deployment:

| | Address |
|---|---|
| Program | `7qujfsb4ZPbQHYVZdqiXq1r8tVAMyyukX94obPqXbVwz` |
| Market (SOL-PERP) | `ECUp8pXzVLzxjVs8mtKBJma3mdcHf8zSC4cqPeBy8MPy` |
| OrderBook | `83zMFL6cHjgXkQ7KRNcgtHaZ1fhyNgxhM8aMpPpEnMqe` |
| Pyth SOL/USD feed | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` |

## Repository layout

```
slipstream/
├── programs/
│   └── slipstream/            # On-chain program (Pinocchio, Rust)
├── client/                    # TypeScript client SDK
├── keepers/                   # Off-chain keeper bots
│   ├── settlement/
│   ├── funding/
│   ├── liquidation/
│   └── twap/
├── frontend/                  # Next.js trading UI
├── scripts/
│   └── deploy.ts              # Bootstrap deploy + init + emit deploy.json
├── docs/                      # Full technical documentation
└── deploy.json                # Live on-chain addresses (source of truth)
```

---

## New-user walkthrough

Exactly what a brand-new user does to go from an empty wallet to a live trade. Everything
is **devnet** — no real money. (This is also the deposit/credit/ER flow end-to-end.)

1. **Wallet on devnet.** Install Phantom/Solflare/Backpack and switch the network to
   **Devnet** (Phantom: Settings → Developer Settings → Change Network → Devnet).
2. **Get devnet SOL** (pays transaction fees). Use a faucet:
   [faucet.solana.com](https://faucet.solana.com) or `solana airdrop 2 <your-address> --url devnet`.
   A small amount (~0.5 SOL) is plenty.
3. **Open the app** at [slipstream.ansht.tech](https://slipstream.ansht.tech) and click
   **Connect Wallet** (top right) → approve.
4. **Get test USDC.** The demo USDC is a devnet mint controlled by the operator. New
   wallets are funded with test USDC for the demo — if your balance is 0, ping the
   operator to mint you some (the mint authority drips USDC to demo wallets). This USDC is
   worthless test tokens, used only to post margin.
5. **Deposit + Init** (Trading Session panel, right column → scroll down). Enter an amount
   (e.g. `1000`) and click **Deposit + Init**. This moves USDC from your wallet into the
   protocol vault on **L1** and creates your trading-credit account. *(One wallet signature.)*
6. **Fund credit.** Enter how much of your deposited collateral to allocate to SOL-PERP
   (e.g. `500`) and click **Fund credit**. This earmarks margin for this market.
7. **Delegate to ER.** Click **Delegate to ER (start trading)**. This delegates your
   *trading-credit* (a scoped margin allowance — not your whole balance) to the Ephemeral
   Rollup so orders match at sub-second speed. *(One wallet signature.)*
8. **(Recommended) Create a session key.** Once delegated, click **Rotate session key**.
   This authorizes an in-browser key to sign orders for you — **no wallet popup per
   order**. It's scoped to your capped credit and expires automatically.
9. **Trade.** Use the order form (left of the session panel): pick **Margin ($)**,
   **Leverage** (1–20×), and a **Limit price** or **Market**. The form derives your
   position size. Place the order — it matches in the ER instantly and shows as a pending
   position.
10. **Watch it settle.** A keeper mirrors your fill from the ER to L1 within a few seconds;
    your **Positions** table (below the fold, "Your Activity") then shows the real settled
    position with live PnL, health, and liquidation price. Close it any time to realize PnL
    back to your collateral, then withdraw.

> Money flow, in one line:
> `wallet USDC → deposit → collateral (L1) → fund → credit → delegate → ER → trade → settle → Position (L1)`.

---

### Additional devnet concessions

### Summary: what holds vs. what must change before mainnet

| Property | Devnet MVP (actual) | Required for mainnet |
| --- | --- | --- |
| Fund safety | Only OrderBook delegated; funds stay on L1 | Same boundary, plus fraud proofs / verifier |
| Fraud proofs | None | Required |
| Oracle model | Pyth-only fallback (Switchboard dead) | True dual-oracle + divergence + restricted mode |
| Oracle account binding | Not validated against market feeds | Must assert passed account == market feed |
| Switchboard On-Demand sigs | Not verified | Must verify |
| ER environment | Devnet only | N/A (no mainnet ER endpoint) |
| TWAP | Self-computed on-chain accumulator | Same |

---

