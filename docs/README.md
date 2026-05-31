# Slipstream — Technical Documentation

Slipstream is an **on-chain perpetual-futures central-limit order book (CLOB)** on
Solana. Order matching runs inside a **MagicBlock Ephemeral Rollup (ER)** for
sub-second placement/cancellation; collateral, positions, funding, and
settlement live on the **Solana base layer (L1)**. The program is written in
**Pinocchio** (a minimal, zero-dependency Solana runtime), wrapped by a
TypeScript SDK, keeper bots, and a Next.js frontend.

> This is a **devnet MVP**. Several mechanisms are deliberately weaker than a
> mainnet design would require; every such concession is called out explicitly
> in the relevant doc and in the root `slipstream/README.md` Trust Model.

---

## How to read these docs

Start at the top and go down — each builds on the previous.

| # | Doc | What it answers |
|---|-----|-----------------|
| 1 | [Architecture Overview](./01-architecture-overview.md) | The whole system at a glance: ER vs L1, the four layers, data flow of an order. |
| 2 | [The OrderBook & PDA Storage](./02-orderbook-and-pda-storage.md) | **How does a PDA hold a ~612 KB order book?** Account size limits, the 10,240-byte CPI growth cap, chunked allocation, zero-copy, ring buffers. |
| 3 | [Ephemeral Rollups & Delegation](./03-ephemeral-rollups-and-delegation.md) | What an ER is, what delegation/commit/undelegate mean, the sponsored-commit cap, why only the OrderBook is delegated. |
| 4 | [Settlement & the Fill-Log Pipeline](./04-settlement-and-the-fill-log.md) | How ER fills become real L1 positions without ever committing the giant order book; epoch rotation. |
| 5 | [Margin, Funding & Liquidation](./05-margin-funding-liquidation.md) | Perps mechanics: notional, leverage, margin, health factor, liquidation price, funding rate, and the decimal-scaling pitfall. |
| 6 | [Session Keys](./06-session-keys.md) | Sign-once-trade-many: scoped, expiring browser keys; why it's safe. |
| 7 | [Problems in On-Chain Perps & How Slipstream Solves Them](./07-problems-and-solutions.md) | The hard problems (latency, account size, oracle trust, settlement, MEV) and the concrete solution for each. |
| 8 | [Glossary](./08-glossary.md) | Every jargon term, plain-English. |

---

## The 30-second version

- **Problem:** a real CLOB needs thousands of order updates per second. Solana
  L1 (~400 ms blocks, fees per tx, 10 KB per-CPI account-growth cap) cannot host
  a high-frequency matching engine directly, but it *can* custody funds safely.
- **Idea:** split the system. Put the **hot, high-frequency, non-financial**
  state (the order book) on a MagicBlock **Ephemeral Rollup** that runs at
  ~10 ms. Keep **all value-bearing state** (collateral, positions, vault) on
  **L1**, where it is never delegated and therefore never at risk from the ER.
- **Result:** orders place/cancel/match at rollup speed; money stays on Solana
  with Solana's security; a keeper periodically **commits** matched trades back
  to L1 and **settles** them into real positions.

The single most important safety fact: **only the OrderBook account is delegated
to the ER.** Funds never leave L1, so a misbehaving ER can at worst scramble
order *ordering* — it can never move money.
