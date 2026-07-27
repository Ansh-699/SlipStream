# 8 · Glossary

> Every piece of jargon used across these docs and the codebase, in plain
> English. Skim it once; come back when a term bites.

---

## Trading & perpetual-futures terms

**Perpetual future (perp).** A derivative contract that tracks an underlying price
(here SOL/USD) with **no expiry date**. Held open indefinitely; tethered to spot
by funding payments.

**CLOB (central-limit order book).** The matching mechanism where makers post
resting limit orders and takers cross the spread, matched by **price-time
priority**. The opposite of an AMM (automated market maker), which prices trades
off a bonding curve / liquidity pool instead.

**Maker / taker.** A **maker** posts a resting order that adds liquidity (and earns
a rebate). A **taker** crosses the spread, removing liquidity (and pays a fee).

**Bid / ask / spread.** **Bid** = highest price a buyer will pay. **Ask** = lowest
a seller will accept. **Spread** = ask − bid. Best bid/ask is the "top of book."

**Limit order.** Buy/sell at a chosen price or better; rests in the book until
filled or cancelled.

**Market order.** Execute immediately at the best available price(s), crossing the
spread.

**Long / short.** **Long** = you profit if price rises (positive `size`). **Short**
= you profit if price falls (negative `size`).

**Notional.** Full value of a position = `size × price`. A 10-SOL position at $150
has $1,500 notional regardless of how much margin backs it.

**Leverage.** The multiple between your notional and your margin. 20× means $75 of
margin controls $1,500 of notional. Amplifies gains *and* losses.

**Margin.** Collateral backing a position. **Initial margin** = `notional /
leverage` (required to open). **Maintenance margin** = `initial / 2` (fall below
and you're liquidated).

**Collateral.** Funds backing your account/position. In Slipstream: `free_collateral`
(unencumbered, withdrawable) vs `Position.collateral` (backing an open position).

**Credit / committed / available.** On a `TradingCredit`: **credit** = margin
allocated to a market; **committed** = reserved by live orders; **available** =
`credit − committed` (what new orders can still use).

**PnL (profit and loss).** **Unrealized** = mark-to-market gain/loss on an open
position. **Realized** = locked in when you close or partially close.

**Mark price.** The reference price used for PnL/liquidation (here, the Pyth feed).

**Funding / funding rate.** Periodic payment between longs and shorts that tethers
the perp price to spot. Accrues at most once per **funding interval** (8h for
SOL-PERP). Tracked via a `cumulative_funding_index`; each position snapshots the
index and owes/earns the delta.

**TWAP (time-weighted average price).** Average price over a window (30 min here),
used to smooth funding/safety. **Self-computed** on-chain because no oracle offers
it natively.

**Liquidation.** Forced closing of a position whose **health factor** drops below
1.0 (net margin ≤ maintenance margin), to protect the system from bad debt.

**Health factor.** `net_margin / maintenance_margin` (6-dp, `1_000_000 = 1.0`).
≥ 1.0 safe; < 1.0 liquidatable.

**Liquidation price.** The mark price at which health hits 1.0 — i.e. where you'd
get liquidated.

**VWAP entry.** Volume-weighted average entry price when adding to an existing
position, so the blended entry is priced correctly.

**Open interest (OI).** Total size of all open longs / shorts in a market.

**Insurance fund.** A reserve that absorbs bad debt from liquidations that can't
fully cover losses.

**Tick size / lot size.** **Tick** = smallest price increment (`TICK_SIZE = 1000`).
**Lot** = smallest size increment (`LOT_SIZE = 0.1 SOL`).

**bps (basis points).** Hundredths of a percent. 1 bps = 0.01%. Used for fees
(`taker_fee_bps`, `maker_rebate_bps`).

---

## Solana terms

**L1 (base layer / Layer 1).** The main Solana chain. ~400 ms blocks, full
validator security, real fees. Holds all of Slipstream's value-bearing state.

**PDA (Program Derived Address).** An account whose address is derived from
**seeds + program ID** and has **no private key**, so only the owning program can
sign for it. How programs own persistent state.

**Account.** Solana's unit of storage. A blob of bytes (up to 10 MB) owned by a
program, kept alive by being **rent-exempt** (holding enough lamports).

**Rent / rent-exempt.** Accounts must hold a minimum lamport balance proportional
to their size to persist. Slipstream pre-funds the OrderBook's full-size rent at
creation even though bytes are added later.

**CPI (cross-program invocation).** One program calling another. Subject to limits
like the account-growth cap.

**`MAX_PERMITTED_DATA_INCREASE` (10,240 bytes).** The max an account can grow per
instruction/CPI. The reason the 612 KB book is built in ~61 chunks and can't be
undelegated.

**Lamport.** The smallest unit of SOL (1 SOL = 1e9 lamports).

**BPF / SBF.** The bytecode Solana programs compile to. Runs in a sandbox with a
**~4 KB stack frame** and a compute-unit budget — why big arrays can't live on the
stack and why zero-copy matters.

**Discriminator.** A leading byte (or bytes) identifying an account type or
instruction. Slipstream uses a one-byte instruction discriminator (`0x00`–`0x27`)
and per-account-type discriminators (`DISC_ORDER_BOOK`, `DISC_FILL_LOG`, …).

**Signer.** An account that authorized a transaction with its key. Distinct from
**owner** (the program/pubkey that controls an account).

---

## MagicBlock / Ephemeral Rollup terms

**Ephemeral Rollup (ER).** A temporary, high-speed (~10 ms) execution environment
that runs the same Solana program against **delegated** accounts at sponsored
cost, periodically folding results back to L1.

**Delegation.** Handing an L1 account's mutation authority to the ER. After
delegation the ER (not L1) writes the account. In Slipstream: the OrderBook
(forever) and each TradingCredit (per session).

**Commit.** The ER snapshots a delegated account's state back to L1; the account
**stays delegated**. Triggered by a **ScheduleCommit** CPI to the magic program.

**Undelegate.** Returning authority from the ER to L1. **Impossible** for the
612 KB OrderBook (growth cap + unclean path + defeats the premise).

**Sponsored-commit cap.** The hard limit of **10 commits per delegated account**
on the public devnet node (verified live; funding an escrow doesn't lift it).
Beaten by **epoch rotation**.

**Epoch rotation.** Because the commit cap is per-account, the FillLog is a PDA
keyed by an `epoch` number; bumping the epoch mints a fresh account with a fresh
budget of 10 → unbounded settlement.

**Delegation program (`DELeGGvXpWV2fqJUEqsQ…`).** MagicBlock program that records
delegation and enforces scope + session timeout (not fraud proofs).

**Magic program (`Magic11111…`).** Target of ScheduleCommit / undelegate CPIs from
inside the ER.

---

## Slipstream-specific accounts & instructions

**OrderBook.** The ~612 KB delegated PDA holding order slots, sorted price levels,
and the fill-event ring. One per market. (doc 2)

**FillLog.** The small (~8 KB) epoch-rotatable PDA that carries fills from ER to
L1 for settlement, so the OrderBook never has to be committed. (doc 4)

**Market.** L1 account holding market params (leverage, fees, tick/lot, funding
interval), oracle feeds, OI, the TWAP ring, the funding index, and the
`last_settled_sequence` settlement cursor.

**Position.** L1 account: a user's open exposure in a market (`size`,
`entry_price`, `collateral`, `realized_pnl`, funding snapshot).

**UserAccount.** L1 account holding `free_collateral` and long-lived user
lifecycle state. **Never delegated.**

**TradingCredit.** Per-(user, market) account holding margin **delegated to the
ER** during a session; carries the **session key** fields. (docs 5, 6)

**OrderSlot / PriceLevel / FillEvent.** The in-book structures: a resting order, a
sorted price ladder entry, and a recorded match, respectively. (doc 2)

**Session key.** A scoped, expiring browser key (`session_authority` +
`session_expiry` on TradingCredit) authorized once to sign orders for the owner.
(doc 6)

**`mirror_fills` / `commit_fill_log` / `settle_from_log`.** The three-step
settlement pipeline: copy book fills → FillLog (ER); snapshot FillLog → L1; write
Positions from the committed log (L1). (doc 4)

**`grow_orderbook`.** Reallocs the OrderBook up to 10,240 bytes per call until it
reaches full size; called ~61 times at deploy. (doc 2)

**`reconcile_credit`.** Rescans the book for an owner's active slots to repair a
stale `TradingCredit.committed` after fills drained margin the maker couldn't see
in real time. (doc 5)

**`crank_twap` / `compute_funding` / `liquidate_position`.** L1 keeper-driven
instructions for the TWAP accumulator, periodic funding accrual, and liquidating
unhealthy positions. (doc 5)

---

## Stack / tooling terms

**Pinocchio.** A minimal, zero-dependency Rust SDK for Solana programs (no Anchor).
Slipstream's on-chain program is written in it; it hand-rolls account parsing and
uses zero-copy.

**Zero-copy.** Reading/writing an account by reinterpreting its raw bytes in place
as typed structs (no deserialization/copy). Requires `#[repr(C)]` + `Pod` layouts.

**`bytemuck` / `Pod` / `Zeroable`.** Rust crate + traits enabling safe zero-copy
casts between bytes and plain-old-data structs.

**`#[repr(C)]`.** A fixed, predictable struct memory layout (C ABI) so the bytes
match across Rust and the TypeScript decoders.

**Ring buffer.** A fixed-size circular array with head/tail indices that wrap
around. Used for the fill-event queue, the FillLog, and the TWAP buffer.

**Free list.** An intrusive linked list of unused slots enabling O(1)
allocate/free without heap allocation or fragmentation (the order-slot pool).

**Object pool.** A pre-allocated, reused set of fixed slots managed by a free list
— what the OrderBook uses instead of dynamic allocation.

**Fixed-point.** Representing fractional numbers as scaled integers (price ×1e6,
size ×1e9) because floats aren't used on-chain. Mixing scales is the classic bug.

**Keeper.** An off-chain bot that periodically calls on-chain instructions that
need a heartbeat (funding, liquidation, TWAP, settlement, market-making).

**Pyth.** The price oracle providing SOL/USD via a Receiver `PriceUpdateV2` feed,
with on-chain freshness checks.

**Switchboard.** A second oracle intended for dual-oracle divergence checks —
**dead on devnet** (reads 0), hence the Pyth-only fallback.

**SSE (server-sent events).** The streaming protocol the frontend uses to pull
real-time Pyth prices (a true push stream, not polling).
