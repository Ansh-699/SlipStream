<p align="center">
  <img src="frontend/assets/banner-slipstream.png" alt="Slipstream" width="520" />
</p>

<h1 align="center">Slipstream</h1>

<p align="center">
  <strong>On-chain perpetual-futures CLOB on Solana — order matching at rollup speed, custody at L1 security.</strong>
</p>

<p align="center">
  <a href="https://slipstream.ansht.tech"><strong>🌐 Live demo →</strong></a> &nbsp;·&nbsp;
  <a href="https://slipstream.ansht.tech/docs">📚 Docs</a>
</p>

<p align="center">
  <em>Devnet MVP — deployed and verified on Solana devnet + the MagicBlock devnet Ephemeral Rollup.</em>
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

```
┌──────────────── Frontend (Next.js) ─────────────────┐
│ wallet · margin×leverage order form · live Pyth      │
│ chart · order book · positions                       │
└───────────┬─────────────────────────────┬───────────┘
            │ /api/rpc/er (orders)         │ /api/rpc/base (positions, $)
            ▼                              ▼
   ┌─────────────────┐            ┌──────────────────────┐
   │ MagicBlock ER    │  commit   │  Solana L1            │
   │ ~10 ms blocks    │ ────────▶ │  collateral, vault,   │
   │ OrderBook (612KB)│  via small│  positions, funding   │
   │ delegated here   │  FillLog  │  (never delegated)    │
   └─────────────────┘            └──────────────────────┘
            ▲                              ▲
            └────────── Keepers (pm2 bots) ─┘
              settlement · funding · liquidation · twap · expiry
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
| USDC mint (test) | `Fakb9gPACMBbfQgepdAEmPCYmNU4iKAqQhFKfrDU6gDr` |
| Pyth SOL/USD feed | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` |

Verify any of these on the [Solana Explorer (devnet)](https://explorer.solana.com/?cluster=devnet).

## Repository layout

```
slipstream/
├── programs/slipstream/   # on-chain program (Pinocchio, Rust)
├── client/                # TypeScript client SDK
├── keepers/               # off-chain keeper bots (settlement, funding, liq, twap)
├── frontend/              # Next.js trading UI
├── scripts/deploy.ts      # bootstrap: deploy + init + emit deploy.json
├── docs/                  # full technical documentation
└── deploy.json            # live on-chain addresses (source of truth)
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

## Trust Model (Honest Disclosure)

This section documents the MVP's **actual** security guarantees. Everything below is
disclosed on purpose. Where the deployed devnet program is weaker than a mainnet design
would be, that is stated plainly and flagged as a pre-mainnet gap.

### Spec-required disclosures

1. **No on-chain fraud proofs; the OrderBook delegation is the entire safety boundary.**
   Slipstream does **not** implement a re-execution / slashing verifier. MagicBlock's
   `delegation-program` provides delegation-scope isolation and a session timeout, not
   fraud proofs. Safety rests on a single fact: **only the non-financial `OrderBook`
   account is delegated to the ER.** All value-bearing state — `Position`, `UserAccount`,
   `TradingCredit` balances, and the token vaults — stays on L1 and is never delegated. A
   misbehaving or compromised ER can at worst corrupt order-book ordering; it cannot move
   funds, because funds never leave L1. (Req 9.1)

2. **The MagicBlock ER is devnet-only.** There is no public mainnet MagicBlock endpoint.
   This MVP is devnet-scoped by definition; the ER it talks to (`devnet.magicblock.app`)
   is a devnet service. (Req 9.2)

3. **The 30-minute TWAP is self-computed.** Neither Pyth nor Switchboard provides a native
   30-minute TWAP. Slipstream maintains its own on-chain accumulator: the `crank_twap`
   instruction (driven by a keeper) folds fresh oracle samples into a ring buffer on the
   `Market` account. (Req 9.3)

4. **Switchboard is unavailable inside the ER; dual-oracle checks run on L1 only.** Oracle
   injection into the ER supports Pyth Lazer / Stork only, so the cross-oracle divergence
   check cannot run inside the rollup. Dual-oracle validation runs exclusively on L1
   settlement (`compute_funding`, `liquidate_position`), never inside the ER. (Req 9.4)

### Additional devnet concessions

These are real weaknesses of the **deployed devnet build**, documented rather than hidden.
Each is a deliberate devnet concession and/or a gap that **must be closed before mainnet.**

- **DEVNET single-oracle (Pyth-only) fallback — must not exist on mainnet.** Switchboard is
  environmentally **dead** on devnet (the configured feed reads `value = 0`). The deployed
  program detects this and falls back to a single fresh Pyth feed: it keeps Pyth freshness
  but **skips the cross-oracle divergence check** and **does not enter `restricted_mode`**.
  This affects funding and liquidation and **must be removed for mainnet**.

- **Oracle accounts are not validated on-chain against the market's stored feeds.** The
  price-sensitive instructions parse whatever oracle account is passed. Before mainnet they
  must assert `passed_account == market.pyth_feed` (and likewise for Switchboard).

- **The live Pyth price comes from a Pyth Receiver `PriceUpdateV2` feed**
  (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`). The originally configured legacy Pyth
  V2 feed was frozen and failed freshness checks, so it was replaced with the live feed.

- **Funding accrues at most once per funding interval** (8h for SOL-PERP). `compute_funding`
  deliberately reverts if called again within the interval — a designed precondition, not a
  bug.

- **The OrderBook is allocated in chunks and delegated via a staged buffer.** A full
  SOL-PERP OrderBook exceeds Solana's 10,240-byte per-CPI growth cap, so it's grown
  incrementally (`grow_orderbook`) and delegated through a staged buffer PDA. Deployment
  plumbing, not a security property.

- **Switchboard On-Demand signatures are not verified.** The on-chain parser trusts the
  operator-posted account data. A documented gap to close before relying on Switchboard.

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

## Deployment

The bootstrap (`scripts/deploy.ts`) deploys the program, creates the USDC mint/vault,
initializes global state and the SOL-PERP market, grows and delegates the OrderBook, and
writes [`deploy.json`](./deploy.json). Keepers and the frontend read live addresses from
that manifest.
