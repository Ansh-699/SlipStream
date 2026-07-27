# 1 · Architecture Overview

> Read this first. It gives you the whole system in one pass, then every other
> doc zooms into one piece of it.

---

## 1.1 What Slipstream is

Slipstream is an **on-chain perpetual-futures exchange** built around a
**central-limit order book (CLOB)**. "Perpetual futures" (perps) are derivative
contracts that track an underlying price (here, **SOL/USD**) with no expiry date;
traders hold leveraged long or short positions and pay/receive a periodic
**funding** payment that tethers the contract price to the spot price.

A CLOB is the matching mechanism every major exchange uses: makers post resting
**limit orders** at chosen prices, takers cross the spread to fill them, and the
engine matches by **price-time priority** (best price first, oldest order first
within a price).

The hard part is that a real CLOB is *high-frequency*. Quotes update constantly.
Putting that directly on Solana's base layer is infeasible (see §1.3). Slipstream's
entire architecture is the answer to one question:

> **How do you run a fast order book on a chain that is too slow and too
> constrained to host one — without giving up the chain's custody guarantees?**

The answer is a **split-state architecture**: hot order-book state lives on a
**MagicBlock Ephemeral Rollup (ER)** running at ~10 ms; all value-bearing state
(collateral, positions, the token vault) stays on **Solana L1**. A keeper bridges
the two. The rest of this doc explains that split.

---

## 1.2 The two execution environments (ER vs L1)

This is the single most important concept in the codebase. Internalize it and
everything else falls into place.

| | **Solana L1 (base layer)** | **MagicBlock Ephemeral Rollup (ER)** |
|---|---|---|
| Block time | ~400 ms | ~10 ms |
| Cost per tx | Real lamports | Sponsored / negligible |
| Holds | Collateral, Positions, the USDC vault, Market params, funding | A *delegated copy* of the OrderBook only |
| Security | Full Solana validator set | Trusts the MagicBlock operator (devnet) |
| Who writes here | Settlement, funding, liquidation, deposits/withdrawals | `place_order`, `cancel_order`, matching |

The bridge between them is **delegation** (covered fully in
[doc 3](./03-ephemeral-rollups-and-delegation.md)): an L1 account can be
*delegated* to the ER, after which the ER becomes the authority that mutates it.
Periodically the ER **commits** the account's new state back to L1.

**The safety boundary, stated once and for all:** *only the OrderBook account is
ever delegated to the ER.* Collateral, positions, and the vault are **never**
delegated — they live on L1 and only L1 instructions can move them. Therefore the
worst a buggy or malicious ER can do is scramble order *ordering*. It can never
move a single token of anyone's money. Doc 3 and the root README's Trust Model
expand on this.

---

## 1.3 Why this split exists (the constraints that force it)

Three Solana limits make a naive "order book in a PDA on L1" impossible *and*
unaffordable:

1. **Latency.** L1 blocks are ~400 ms. A trader cancelling/replacing a quote ten
   times a second would need ten L1 transactions per second per order — hopeless
   for market-making. The ER's ~10 ms blocks make this feasible.

2. **Cost.** Every L1 transaction costs lamports. High-frequency quoting on L1
   would bleed fees. ER transactions are sponsored / negligible.

3. **The 10,240-byte account-growth cap.** A single instruction (via CPI) can
   grow an account by at most `MAX_PERMITTED_DATA_INCREASE = 10,240` bytes. The
   full SOL-PERP OrderBook is **626,736 bytes (~612 KB)**. You literally cannot
   create it in one transaction; it must be grown in chunks
   ([doc 2](./02-orderbook-and-pda-storage.md)). This same cap is *also* what
   makes the 612 KB book impossible to re-delegate or undelegate freely, which
   drives the whole settlement design ([doc 4](./04-settlement-and-the-fill-log.md)).

So: the order book goes to the ER for speed and cost; the money stays on L1 for
safety; and because the book is enormous and un-undelegatable, settlement is
decoupled through a tiny side account.

---

## 1.4 The four layers (the actual code)

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 4 — Frontend (Next.js)                                     │
│  slipstream/frontend/                                             │
│  Wallet, order form (margin × leverage), live Pyth chart,         │
│  order book, positions. Talks to BOTH the ER (orders) and         │
│  L1 (positions/collateral) via RPC proxies.                       │
└───────────────▲───────────────────────────────────────▲──────────┘
                │                                         │
┌───────────────┴──────────────┐        ┌─────────────────┴─────────┐
│  Layer 3 — Keepers (TS bots)  │        │  Layer 2 — Client SDK     │
│  slipstream/keepers/          │        │  slipstream/client/       │
│  fill-log, funding, liq,      │        │  PDAs, account decoders,  │
│  twap, market-maker bots      │        │  instruction builders     │
└───────────────▲──────────────┘        └─────────────────▲─────────┘
                │                                          │
┌───────────────┴──────────────────────────────────────────┴────────┐
│  Layer 1 — On-chain program (Pinocchio, Rust)                       │
│  slipstream/programs/slipstream/                                    │
│  40 instructions (0x00–0x27). Runs on L1 AND (delegated) in the ER. │
└─────────────────────────────────────────────────────────────────┘
```

**Layer 1 — the program.** Written in **Pinocchio**, a minimal zero-dependency
Solana SDK (no Anchor). It hand-rolls account parsing and uses **zero-copy**
`bytemuck` casts so the 612 KB book is never deserialized into a heap struct
(doc 2). The single program binary runs in *both* environments — the same
`place_order` code path executes inside the ER, while `settle_from_log` and
`liquidate_position` execute on L1. Instruction dispatch is a one-byte
discriminator (`0x00`–`0x27`) in `instructions/mod.rs`.

**Layer 2 — the client SDK** (`slipstream/client/src/`). TypeScript helpers:
`pda.ts` derives program addresses, `accounts.ts` decodes raw account bytes back
into JS objects (mirroring the Rust `#[repr(C)]` layouts), `instructions.ts`
builds the raw instruction buffers, `constants.ts` holds discriminators and seeds.

**Layer 3 — keepers** (`slipstream/keepers/src/`). Off-chain bots that crank the
parts of a perp DEX that need a heartbeat:
- `fill-log-keeper.ts` — the settlement pipeline (doc 4).
- `funding-keeper.ts` — calls `compute_funding` once per interval.
- `liquidation-keeper.ts` — scans positions, liquidates the unhealthy.
- `twap-keeper.ts` — folds oracle samples into the on-chain TWAP.
- `market-maker-bot.ts` — demo liquidity (tight spread, many levels, ~1.2 s loop).

**Layer 4 — frontend** (`slipstream/frontend/`). Next.js app. Crucially it speaks
to **two** RPC endpoints through proxies (`/api/rpc/[layer]`): the **ER** for
orders and live book, **L1** for positions/collateral/funding. The live price
chart streams real **Pyth** data over SSE (not polling) — see the chart hooks.

---

## 1.5 Lifecycle of an order (the end-to-end data flow)

This trace ties every layer together. Follow one market order from click to
settled position.

```
 1. DEPOSIT (L1)
    User deposits USDC → UserAccount.free_collateral (L1 vault holds tokens).

 2. FUND CREDIT (L1)
    User moves margin into a TradingCredit for SOL-PERP.

 3. DELEGATE (L1 → ER)
    TradingCredit is delegated to the ER. (OrderBook was delegated at deploy.)
    Optionally: authorize_session stamps a browser/session key (doc 6).

 4. PLACE ORDER (ER, ~10 ms)
    Frontend signs place_order with the session key and sends it to the ER.
    The ER matching engine crosses it against resting orders, reserves margin
    from TradingCredit, and writes a FillEvent into the OrderBook's fill ring.
    The frontend shows the position INSTANTLY from ER state ("pending settlement").

 5. MIRROR (ER)
    fill-log-keeper calls mirror_fills: copies new FillEvents out of the giant
    OrderBook into a small ~8 KB FillLog account (also delegated to the ER).

 6. COMMIT (ER → L1)
    Keeper calls commit_fill_log: the SMALL FillLog's state is committed to L1.
    The 612 KB OrderBook is NEVER committed (it can't be — doc 4).

 7. SETTLE (L1)
    Keeper calls settle_from_log on L1: reads the committed fills read-only and
    writes real Position accounts (size, entry_price, collateral, PnL), updates
    open interest and the insurance fund. The L1 Positions table now shows a
    real, settled position.

 8. ONGOING (L1)
    funding-keeper accrues funding every interval; liquidation-keeper closes
    unhealthy positions; the user can close_position to realize PnL back to
    collateral and withdraw.
```

The key insight in steps 5–7: settlement does **not** go through the order book.
A tiny side account (the FillLog) carries fills to L1 so the un-committable 612 KB
book never has to move. That design is the subject of doc 4 and was the project's
central engineering problem.

---

## 1.6 Where to go next

- **"How does a PDA even hold 612 KB?"** → [doc 2](./02-orderbook-and-pda-storage.md)
- **"What exactly is an ER / delegation / commit?"** → [doc 3](./03-ephemeral-rollups-and-delegation.md)
- **"How do ER fills become real positions?"** → [doc 4](./04-settlement-and-the-fill-log.md)
- **"How does leverage / funding / liquidation work?"** → [doc 5](./05-margin-funding-liquidation.md)
- **"What's the signing key in the browser?"** → [doc 6](./06-session-keys.md)
- **"Just give me the problems and solutions."** → [doc 7](./07-problems-and-solutions.md)
- **"What does <term> mean?"** → [doc 8](./08-glossary.md)
