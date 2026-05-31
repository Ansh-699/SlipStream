# 5 · Margin, Funding & Liquidation

> The perp-mechanics doc: notional, leverage, margin, the collateral/credit model,
> the decimal-scaling bug that defeated leverage (and its fix), funding, TWAP, and
> liquidation. All grounded in `math/fixed_point.rs` and the live keepers.

---

## 5.1 Fixed-point scales (read this first or every number lies)

There are no floats on-chain. Everything is a scaled integer, and **mixing the
scales is the single most dangerous bug class in the codebase** (see §5.4). The
scales, from `math/fixed_point.rs`:

| Quantity | Decimals | Scale | "1.0" is |
|---|---|---|---|
| **Price** (quote, USDC) | 6 | `PRICE_SCALE = 1_000_000` | `$1.00` = `1_000_000` |
| **Size** (base, SOL) | 9 | `BASE_SCALE = 1_000_000_000` | `1 SOL` = `1_000_000_000` |
| **Funding index** | 18 | `FUNDING_SCALE = 1e18` | |
| **Basis points** | — | `BPS_SCALE = 10_000` | `1 bps` = `0.01%` |

So a **price** carries 6 decimals and a **size** carries 9 decimals. Any formula
that multiplies a size by a price must divide by **`BASE_SCALE` (1e9)** to land
back in 6-decimal quote terms. Dividing by the wrong scale is exactly the bug in
§5.4.

Market parameters (deployed SOL-PERP): `TICK_SIZE = 1000` (price granularity),
`LOT_SIZE = 100_000_000` = 0.1 SOL (size granularity), `max_leverage = 20`,
`funding_interval_secs = 8h`.

---

## 5.2 Notional, leverage, and margin

**Notional** = the full dollar value of a position = `size × price`. In code
(`compute_notional`):

```
notional = size * price / BASE_SCALE     // 9-dp size × 6-dp price → 6-dp quote
```

Example: 10 SOL at $150 → `10_000_000_000 × 150_000_000 / 1e9 = 1_500_000_000` =
**$1,500.00** (6-dp). ✔ (this is the unit test `test_compute_notional`.)

**Leverage** lets you control a large notional with a small deposit. **Initial
margin** is the deposit required (`compute_initial_margin`):

```
initial_margin = notional / max_leverage
```

$1,500 notional at 20× → **$75 margin** (unit test `test_initial_margin`). So with
$75 you control $1,500 of SOL exposure; a 1% move in SOL is a $15 swing — 20% of
your margin.

**Maintenance margin** is the lower threshold below which you get liquidated
(`compute_maintenance_margin`): `initial_margin / 2`. So for the example, $37.50.

> **Frontend model (the order form).** The UI deliberately asks for **Margin ($)
> + Leverage (1–20×) + Price** rather than raw size, because thinking in
> "how much am I risking and at what multiple" is far more intuitive than
> "how many base lots." It derives: `notional = margin × leverage`, then
> `size = notional / price` rounded to the 0.1-SOL lot. (This is the change made
> after the user found raw "size" entry confusing.)

---

## 5.3 The collateral / credit / committed / available model

This trips people up, so here it is explicitly. Margin lives in two account types
that play different roles (from `state/trading_credit.rs` and `state/position.rs`):

- **`UserAccount.free_collateral`** (L1, never delegated) — your unencumbered
  balance, withdrawable USDC.
- **`TradingCredit`** (delegated to the ER during a session) — margin you've
  allocated to a *specific market*. It has:
  - `credit` — total margin allocated to this market.
  - `committed` — how much of that credit is currently **reserved by live
    orders**.
  - `available() = credit − committed` — what new orders can still reserve.
- **`Position.collateral`** (L1) — margin backing an **open position** after a
  fill settles.

The flow of one dollar of margin:

```
free_collateral ──fund──▶ TradingCredit.credit
                              │
                  place order │ reserves margin
                              ▼
                       committed (held by the order's slot.margin_reserved)
                              │
                       fill   │ drains slot margin → FillEvent.filled_margin
                              ▼
                    Position.collateral  (on L1, after settle)
                              │
                  close/realize PnL back to free_collateral
```

**Why "committed" can look stale.** During ER matching only the *taker's*
TradingCredit is passed as a transaction account; the maker's can't be touched.
So a maker's `committed` becomes stale until their next action calls
`reconcile_credit`, which rescans the book for that owner's active slots,
recomputes the true committed sum, and deducts whatever was drained by fills
(that drained amount is exactly what flowed out to `Position.collateral`). This is
the `reconcile_credit` function and the invariant comments in `trading_credit.rs`.

---

## 5.4 The decimal bug that secretly disabled leverage (fixed)

A real bug, found and fixed (program redeployed). It's the perfect illustration
of §5.1.

**The bug:** `compute_notional` divided the 9-decimal `size` by **`PRICE_SCALE`
(1e6)** instead of **`BASE_SCALE` (1e9)** — a 1000× error. Because size carried 9
decimals but was only divided by 1e6, notional came out **1000× too large**,
which made margin (`notional / leverage`) absurdly large too. A $100 position
would lock ~$5,000 of credit — an effective **0.02× leverage, the opposite of
leverage.** Leverage was silently broken.

**The fix:** divide by `BASE_SCALE` (1e9) in both `compute_notional` and
`compute_unrealized_pnl`, and add the `BASE_SCALE` constant with a loud comment
explaining the trap. Unit tests were updated to the now-correct expected values
(`test_compute_notional` → $1,500 for 10 SOL @ $150; `test_unrealized_pnl_*`).

**Lesson:** when size (9-dp) and price (6-dp) meet, you *must* divide by the base
scale to return to quote terms. The frontend had the mirror of this bug —
`use-positions.ts` / `use-er-position.ts` were dividing PnL by the wrong factor —
and was fixed to `/1e9` to match.

> Note: `funding.rs` math was deliberately **left alone** during this fix; it
> operates in its own 18-decimal funding scale and wasn't part of the notional bug.

---

## 5.5 Unrealized PnL and health factor

**Unrealized PnL** (`compute_unrealized_pnl`), in 6-dp quote:

```
long :  (mark − entry) × |size| / BASE_SCALE
short:  (entry − mark) × |size| / BASE_SCALE
```

Long 1 SOL entered at $100, mark $110 → +$10. Short 1 SOL entry $100, mark $90 →
+$10. (Unit tests `test_unrealized_pnl_long_profit` / `_short_profit`.)

**Health factor** (`compute_health_factor`), 6-dp where `1_000_000 = 1.0`:

```
net_margin = collateral + unrealized_pnl + accrued_funding
health     = net_margin × PRICE_SCALE / maintenance_margin   (0 if net_margin ≤ 0)
```

Health ≥ 1.0 is safe; **health < 1.0 ⇒ liquidatable**. Example: collateral $100,
PnL −$30, maint margin $25 → net $70, health 2.8. (`test_health_factor`.)

**Entry price uses VWAP** when adding to a position (`compute_vwap_entry`):
`new_entry = (old_size·old_entry + fill_size·fill_price) / (old_size+fill_size)`,
so averaging into a position is priced correctly.

---

## 5.6 Liquidation (real, and shown in the UI)

Liquidation is **fully implemented and live** (`liquidate_position` on L1, driven
by `keepers/src/liquidation-keeper.ts`). The keeper scans every `Position`,
computes health, and liquidates those under maintenance. The frontend shows a
**Liq. Price** and **Health** column per position.

**Liquidation price** is the mark price at which health hits 1.0 — i.e. where
losses eat the position down to maintenance margin. The frontend derives margin
for this from `size × entry / leverage` rather than trusting the stored
`collateral` field, which fixed a real "504-health / —" display bug: stored
collateral was a sum of old-scale `filled_margin` values, so deriving margin from
the position's own size/entry gives the correct liq price and health.

A subtlety worth knowing: a **zombie position** with unsettleable pending fills
can make the liquidation keeper retry-spam (it keeps hitting `GracePeriodActive`).
It's a known cleanup item, flagged honestly rather than hidden.

---

## 5.7 Funding (real, not decorative)

**Funding** is the periodic payment that tethers the perp price to spot: when the
perp trades above the index, longs pay shorts (and vice-versa), nudging traders to
push the contract price back toward the oracle.

In Slipstream funding is **real** (`compute_funding` on L1, driven by
`keepers/src/funding-keeper.ts`, cranked live on devnet):

- It accrues **at most once per `funding_interval_secs`** (8h for SOL-PERP).
  Calling again within the interval deliberately reverts with
  `InvalidExpiryTimestamp` — that's a designed precondition (rate limiting),
  **not a bug**.
- It folds into the market's `cumulative_funding_index` (an 18-dp i128 split into
  hi/lo for `Pod` compatibility). Each `Position` stores a
  `funding_index_snapshot`; a position's accrued funding is the delta between the
  current index and its snapshot.
- On devnet it runs in a **Pyth-only fallback** because Switchboard is dead there
  (see §5.8).

---

## 5.8 The oracle & the 30-minute TWAP (honest disclosure)

Price comes from **Pyth** — specifically the actively-updated Pyth Receiver
`PriceUpdateV2` feed `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` (recorded as
`pythFeed` in `deploy.json`). The originally configured legacy Pyth V2 aggregate
feed was frozen and failed freshness checks, so it was swapped for the live
Receiver feed; the on-chain parser handles the `PriceUpdateV2` layout.

**TWAP** (time-weighted average price) is **self-computed**, because neither Pyth
nor Switchboard offers a native 30-minute TWAP. The `Market` account holds a ring
buffer (`twap_prices: [u64; 225]`); the `crank_twap` instruction (driven by
`twap-keeper.ts`) folds fresh oracle samples in, and `get_twap()` averages them.
The TWAP used for funding/safety is **ours, not an oracle product** (Trust Model
Req 9.3).

Two honest devnet concessions around oracles (from the root Trust Model):

1. **Pyth-only fallback.** The configured Switchboard feed reads `value = 0` on
   devnet (a dead legacy V2 account), so the **dual-oracle divergence check is
   skipped** and `restricted_mode` is never entered on devnet. This weakens safety
   to a single oracle and **must be removed before mainnet**.
2. **Oracle accounts aren't bound on-chain to the market's stored feeds** — the
   price instructions parse whatever oracle account is passed. A pre-mainnet gap:
   they must assert `passed_account == market.pyth_feed`.

These are flagged loudly on purpose; they are devnet concessions, not the intended
mainnet model.

---

## 5.9 Takeaways

- Everything is scaled integers: **price 6-dp, size 9-dp** — multiply size×price,
  divide by **`BASE_SCALE` (1e9)** to get quote terms.
- `notional = size×price`, `initial_margin = notional/leverage`,
  `maintenance = initial/2`; the UI works in **margin × leverage × price**.
- Margin flows `free_collateral → credit → committed → Position.collateral`;
  `reconcile_credit` repairs stale maker `committed`.
- The **1000× notional bug** (÷PRICE_SCALE instead of ÷BASE_SCALE) silently killed
  leverage and is fixed.
- **Funding, liquidation, and TWAP are all real and cranked live**; funding is
  rate-limited to once per 8h by design.
- Oracle is **Pyth** with a devnet **Pyth-only fallback** (Switchboard dead) —
  a documented pre-mainnet gap.
