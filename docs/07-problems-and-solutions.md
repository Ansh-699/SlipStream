# 7 · Problems in On-Chain Perps & How Slipstream Solves Them

> A standalone tour of the hard problems in building a perpetual-futures CLOB on
> Solana, and the concrete solution Slipstream ships for each. If you read only
> one doc to understand *why the system looks the way it does*, read this one.

Each section is: **the problem → why it's hard → Slipstream's solution → the
honest catch.**

---

## 7.1 Latency — a CLOB needs speed L1 can't give

**Problem.** A central-limit order book is high-frequency: market makers re-quote
constantly, takers expect instant fills. Solana L1's ~400 ms block time and
per-transaction fees make a native L1 order book unusable for real market-making.

**Why it's hard.** You can't just "make Solana faster." And moving the book
entirely off-chain would sacrifice the on-chain settlement and custody that make
a DEX trustworthy.

**Solution.** Run the matching engine inside a **MagicBlock Ephemeral Rollup**
(~10 ms blocks, sponsored cost) by **delegating the OrderBook account** to it.
The *same* on-chain program runs in the ER, so the matching logic is identical —
just faster. Orders place/cancel/match at rollup speed.
([doc 3](./03-ephemeral-rollups-and-delegation.md))

**The catch.** The ER is operator-run on devnet (no mainnet endpoint). Speed is
real; decentralization of the matching layer is a devnet concession.

---

## 7.2 Account size — a 612 KB book that can't be created in one tx

**Problem.** A real book needs thousands of order slots, price levels, and a long
fill history. Slipstream's is **626,736 bytes (~612 KB)**. Solana lets accounts be
up to 10 MB, but a single CPI can only **grow** an account by **10,240 bytes**.

**Why it's hard.** You can neither `CreateAccount` nor `realloc` to 612 KB in one
shot. And you can't afford to deserialize 612 KB into a heap struct in a BPF
program with a 4 KB stack.

**Solution.** Two techniques ([doc 2](./02-orderbook-and-pda-storage.md)):
- **Chunked allocation** — `initialize_market` creates an initial chunk pre-funded
  for full rent, then `grow_orderbook` reallocs ≤10,240 bytes per call (~61 times)
  until full, then initializes the free list.
- **Zero-copy** — the account is one `#[repr(C)]`/`Pod` byte buffer reinterpreted
  in place as typed slices (`OrderBookView`); "loading" it is O(1) pointer casts,
  not deserialization. Inside: an object-pooled slot array + free list and sorted
  price-level ladders for O(1) best-bid/ask and price-time priority.

**The catch.** None functionally — but the same 10,240-byte cap that forces
chunking *also* makes the book un-undelegatable, which cascades into problem 7.4.

---

## 7.3 Oracle trust — where does the price come from, and can you trust it?

**Problem.** Perps need a reference ("mark"/"index") price for funding,
liquidation, and PnL. A bad price means wrongful liquidations or free money.

**Why it's hard.** A single oracle is a single point of failure; oracles can go
stale, get frozen, or be swapped. And no oracle offers everything you need (e.g. a
30-minute TWAP).

**Solution.**
- Read SOL/USD from an actively-updated **Pyth Receiver `PriceUpdateV2`** feed,
  with **freshness checks** (stale prices are rejected).
- A mainnet design adds a **dual-oracle divergence check** (Pyth + Switchboard)
  plus a **`restricted_mode`** (closes-only, no liquidations) when they disagree,
  with hysteresis to exit.
- **Self-compute the 30-minute TWAP** on-chain: a 225-slot ring on the `Market`,
  cranked by `twap-keeper.ts`, since no oracle provides it natively.
  ([doc 5](./05-margin-funding-liquidation.md) §5.7–5.8)

**The catch (loudly disclosed).** On devnet, Switchboard is **dead** (the feed
reads 0), so the deployed build runs a **Pyth-only fallback**: it keeps freshness
but **skips the divergence check** and never enters restricted mode. Also, the
price instructions don't yet **bind** the passed oracle account to the market's
stored feed. Both are explicit pre-mainnet gaps in the root Trust Model.

---

## 7.4 Settlement — turning ER fills into real L1 positions

**Problem.** Matches happen in the ER, inside the OrderBook. But the *value* — who
owns what position, backed by which collateral — must live on L1. How do fills
cross the boundary?

**Why it's hard.** The obvious route (commit the OrderBook to L1) is blocked twice
over: the 612 KB book **can't be committed/undelegated** (the 10 KB growth cap +
unclean undelegate + it defeats the "book lives in ER" premise), and MagicBlock
enforces a **hard 10-commit-per-account cap** (verified live; funding an escrow
doesn't lift it). Without solving this, you can trade fast but never actually
*own* a settled position — the product would be useless.

**Solution — the FillLog pipeline** ([doc 4](./04-settlement-and-the-fill-log.md)):
- A small **~8 KB FillLog** account (ring of 80 fills) carries settlement instead
  of the book. Being small, it's created in one CPI and committed cheaply.
- Pipeline: **`mirror_fills`** (ER: copy new book fills → log) → **`commit_fill_log`**
  (ER→L1: snapshot the small log) → **`settle_from_log`** (L1: write real
  Positions, skipping orphan fills). `place_order` is untouched.
- **Epoch rotation** beats the 10-commit cap: the cap is *per account*, so the
  keeper mints a fresh epoch PDA (new budget) when one nears the limit — proven
  live (epoch 0 capped at 10, epoch 1 got a fresh 10) → **unbounded settlement**.
- The OrderBook **stays delegated forever, never committed.**

**The catch.** Settlement is a few seconds behind (async, batched). The frontend
hides this by showing the position instantly from ER state ("pending settlement")
while L1 catches up.

---

## 7.5 Margin & leverage correctness — the scaling trap

**Problem.** With no floats on-chain, everything is scaled integers. Price is
6-decimal, size is 9-decimal. Mixing scales produces silently wrong money.

**Why it's hard.** The bug doesn't crash — it produces plausible-looking numbers
that are off by orders of magnitude.

**Solution.** A disciplined fixed-point module (`math/fixed_point.rs`) with
explicit `PRICE_SCALE`/`BASE_SCALE` constants and unit tests pinning the expected
values. `notional = size×price / BASE_SCALE`; `margin = notional / leverage`.
The UI works in **margin × leverage × price** so users never touch raw lots.
([doc 5](./05-margin-funding-liquidation.md))

**The catch (a real bug, now fixed).** `compute_notional` originally divided by
`PRICE_SCALE` (1e6) instead of `BASE_SCALE` (1e9) — a **1000× error** that made a
$100 position lock ~$5,000 of credit, i.e. **0.02× leverage**, the opposite of
leverage. Fixed in both notional and PnL math (and the mirroring frontend bug),
with a loud comment so it can't recur.

---

## 7.6 Custody / safety — what stops the fast layer from stealing funds?

**Problem.** The ER is fast but (on devnet) operator-trusted. If it could touch
funds, a misbehaving ER could rob everyone.

**Why it's hard.** A full solution is on-chain **fraud proofs** / a re-execution
verifier — heavy machinery Slipstream's MVP does **not** implement.

**Solution — delegate only what's safe to lose.** **Only the OrderBook** (order
ordering, non-financial) and scoped `TradingCredit`s are delegated. `Position`,
`UserAccount.free_collateral`, the insurance fund, and the **token vault** are
**never** delegated — only L1 instructions move them. Therefore the worst a
malicious ER can do is **scramble order ordering**; it can never move a token.
**The OrderBook-only delegation boundary IS the safety mechanism.**
([doc 3](./03-ephemeral-rollups-and-delegation.md) §3.5)

**The catch.** No fraud proofs (documented Req 9.1 gap). Safety rests entirely on
the delegation boundary, which is sound *because funds never leave L1* — but a
mainnet build would add a verifier on top.

---

## 7.7 Signing UX — trading without 1000 wallet prompts

**Problem.** Active trading means hundreds of signatures. Per-order wallet prompts
are unusable; pasting your main key into a webpage is dangerous.

**Solution — session keys** ([doc 6](./06-session-keys.md)). Approve once
(`authorize_session`); a disposable browser key then auto-signs orders. It's
**scoped** to one TradingCredit/market, **expiring** (`session_expiry`), and
**signer-only** (everything attributes to `owner`). A leaked key can at most churn
orders inside one credit until expiry — it can never move funds.

**The catch.** You trust the browser to hold the session key for the session's
lifetime; the bound is the scope + expiry, not zero-trust.

---

## 7.8 MEV / ordering fairness

**Problem.** On a public L1 mempool, searchers can front-run/sandwich orders.

**Why it's hard.** Solana has no public mempool the way Ethereum does, but
ordering inside any matching engine still matters.

**Solution.** Matching happens inside the ER with **price-time priority** enforced
by the sorted price-level ladders + per-level FIFO slot lists (doc 2). Orders
aren't sitting in a public L1 mempool waiting to be sandwiched; they go straight to
the ER matcher. The fill ring is an immutable audit trail of the resulting
sequence.

**The catch.** Fair ordering inside the ER ultimately trusts the ER operator's
sequencing (devnet). This folds back into 7.6: it's an *ordering* trust, not a
*funds* trust — the operator can reorder, but cannot steal.

---

## 7.9 The pattern across all of these

Notice the recurring shape of every solution:

> **Split the system by trust and frequency. Put hot, non-financial,
> high-frequency state where it can move fast (the ER). Keep valuable,
> low-frequency state where it's safe (L1). Bridge them with the smallest, most
> rotatable artifact possible (the FillLog), and never expose anything valuable to
> the fast layer.**

Latency, account size, settlement, custody, and UX are all the same trade made at
different layers. That single principle is Slipstream's architecture.

---

## 7.10 Quick reference

| Problem | Solution | Honest catch |
|---|---|---|
| Latency | OrderBook delegated to ~10 ms ER | Operator-run (devnet) |
| 612 KB account | Chunked `grow_orderbook` + zero-copy | Same cap blocks undelegation |
| Oracle trust | Pyth + freshness, self-computed TWAP, (mainnet) dual-oracle | Devnet Pyth-only fallback |
| Settlement | Small FillLog + mirror→commit→settle + epoch rotation | Few-seconds latency |
| Margin correctness | Fixed-point module + tests | Fixed a real 1000× scaling bug |
| Custody safety | Only OrderBook delegated; funds stay on L1 | No fraud proofs |
| Signing UX | Scoped, expiring session keys | Browser holds the session key |
| MEV/ordering | ER price-time priority, no public mempool | Trusts ER sequencing (devnet) |
