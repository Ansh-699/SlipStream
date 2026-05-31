# Slipstream (Devnet MVP)

Slipstream is an on-chain perpetual-futures central-limit order book (CLOB) for Solana.
Order matching runs inside a [MagicBlock](https://www.magicblock.gg/) Ephemeral Rollup (ER)
for low-latency placement/cancellation, while collateral, positions, funding, and
settlement stay on the Solana base layer (L1). The on-chain program is written in
Pinocchio; a TypeScript client SDK, keeper bots, and a Next.js frontend wrap it.

**This is a devnet MVP.** It is deployed and verified on Solana devnet + the MagicBlock
devnet ER only. It is not production software and its security model is intentionally
weaker than a mainnet design would require (see the Trust Model below).

Live addresses (program ID, market, orderbook, USDC mint/vault, oracle feeds, market
parameters) are emitted by the bootstrap to [`../deploy.json`](../deploy.json) — always
treat that manifest as the source of truth rather than hard-coded constants.

---

## Trust Model (Honest Disclosure)

This section documents the MVP's **actual** security guarantees, not the aspirational
model described in the whitepaper (`slipstream.md` §8/§20). Everything below is disclosed
on purpose. Where the deployed devnet program is weaker than a mainnet design would be,
that is stated plainly and flagged as a pre-mainnet gap.

### Spec-required disclosures

These are the four guarantees the deployment spec (Requirement 9) requires us to state.

1. **No on-chain fraud proofs; the OrderBook delegation is the entire safety boundary.**
   Slipstream does **not** implement the re-execution / slashing verifier described in the
   whitepaper. MagicBlock's `delegation-program` provides delegation-scope isolation and a
   session timeout, not on-chain fraud proofs. Safety therefore rests on a single fact:
   **only the non-financial `OrderBook` account is delegated to the ER.** All
   value-bearing state — `Position`, `UserAccount`, `TradingCredit` balances, and the
   token vaults — stays on L1 and is never delegated. A misbehaving or compromised ER can
   at worst corrupt order-book ordering; it cannot move funds, because funds never leave
   L1. The OrderBook-only delegation is the safety mechanism. (Req 9.1)

2. **The MagicBlock ER is devnet-only.** There is no public mainnet MagicBlock endpoint.
   This MVP is devnet-scoped by definition; the ER it talks to (`devnet.magicblock.app`)
   is a devnet service. (Req 9.2)

3. **The 30-minute TWAP is self-computed.** Neither Pyth nor Switchboard provides a native
   30-minute TWAP. Slipstream maintains its own on-chain accumulator: the `crank_twap`
   instruction (driven by a keeper) folds fresh oracle samples into a ring buffer on the
   `Market` account. The TWAP used for funding/safety is ours, not an oracle-native
   product. (Req 9.3)

4. **Switchboard is unavailable inside the ER; dual-oracle checks run on L1 only.** Oracle
   injection into the ER supports Pyth Lazer / Stork only, so the cross-oracle (Pyth +
   Switchboard) divergence check cannot run inside the rollup. Dual-oracle validation runs
   exclusively on L1 settlement (`compute_funding`, `liquidate_position`), never inside the
   ER. (Req 9.4)

### Additional devnet concessions discovered during deployment

These were found while deploying and verifying the MVP on devnet. They are real
weaknesses of the **deployed devnet build** and are documented here rather than hidden.
Each one is a deliberate devnet concession and/or a gap that **must be closed before any
mainnet deployment.**

- **DEVNET single-oracle (Pyth-only) fallback — must not exist on mainnet.**
  Switchboard is environmentally **dead** on devnet: the configured Switchboard feed
  (`GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR`) is a legacy V2 account that reads
  `value = 0`. Because the dual-oracle check cannot function with a dead feed, the deployed
  program detects this ("Switchboard unavailable") and falls back to a **single fresh Pyth
  feed**: it still enforces Pyth freshness, but it **skips the cross-oracle divergence
  check** and **does not enter `restricted_mode`**. This affects funding and liquidation.
  This is a deliberate, loud devnet concession (see `oracle.rs` `dual_oracle_read` /
  `apply_dual_oracle`). It weakens the safety model to a single oracle and **must be
  removed for mainnet**, where both feeds must be live and the divergence/restricted-mode
  logic must be in force.

- **Oracle accounts are not validated on-chain against the market's stored feeds.**
  The price-sensitive instructions (`compute_funding`, `liquidate_position`, `crank_twap`)
  parse **whatever oracle account is passed** to them. They do **not** check that the
  passed account equals the market's stored `pyth_feed` / `switchboard_feed`. This is a
  trust gap: a caller could supply a different (but structurally valid) oracle account.
  **Before mainnet, these instructions must assert `passed_account == market.pyth_feed`**
  (and likewise for Switchboard). This is also what currently lets the devnet deployment
  switch Pyth feeds (see next item) without re-initializing the market.

- **The live Pyth price comes from a Pyth Receiver `PriceUpdateV2` feed.**
  The deployed program reads SOL/USD from the actively-updated Pyth Receiver
  `PriceUpdateV2` feed `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`
  (this is the `pythFeed` recorded in `deploy.json`). The originally-configured legacy
  Pyth V2 aggregate feed was frozen / decommissioned and failed freshness checks, so it
  was replaced with the live Receiver feed. The on-chain parser handles the
  `PriceUpdateV2` layout.

- **Funding accrues at most once per funding interval.** For SOL-PERP the funding interval
  is 8 hours. `compute_funding` deliberately reverts with `InvalidExpiryTimestamp` if
  called again within the same interval (`elapsed < funding_interval_secs`). This is the
  expected precondition, **not a bug** — funding is rate-limited by design.

- **The OrderBook is allocated in chunks and delegated via a staged buffer (deployment
  mechanics).** A full SOL-PERP OrderBook is far larger than Solana's per-CPI account
  growth cap (`MAX_PERMITTED_DATA_INCREASE` = 10,240 bytes). It therefore cannot be created
  in one shot. The bootstrap allocates it incrementally — `initialize_market` creates an
  initial chunk (pre-funded for full rent) and `grow_orderbook` reallocs up to 10,240 bytes
  per call until the account reaches full size, at which point the free list is
  initialized. Delegation to the ER is likewise staged through a delegate buffer PDA
  (`delegate_orderbook_prepare` → `delegate_orderbook`). This is deployment plumbing
  required by Solana's growth cap, not a security property — noted here so the deploy flow
  is understandable.

- **Switchboard On-Demand signatures are not verified.** The on-chain Switchboard parser
  trusts the operator-posted account data; it does **not** verify the On-Demand oracle
  signatures. This is a documented gap to close before relying on Switchboard for safety on
  mainnet.

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

The bootstrap (`../scripts/deploy.ts`) deploys the program, creates the USDC mint/vault,
initializes global state and the SOL-PERP market, grows and delegates the OrderBook, and
writes [`../deploy.json`](../deploy.json). Keepers and the frontend read live addresses
from that manifest. See the spec at
`.kiro/specs/slipstream-mvp-deployment/` for the full deployment plan.
