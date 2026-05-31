# 4 · Settlement & the Fill-Log Pipeline

> The project's central engineering problem: **how do ER fills become real L1
> positions when the order book they live in can never be committed?** This doc
> is the full answer, and it describes a mechanism that is *working end-to-end on
> devnet*.

---

## 4.1 The problem, stated precisely

After matching in the ER, a fill exists only as a `FillEvent` in the OrderBook's
fill ring — inside a 612 KB account that lives in the ER. To turn that into a real
**Position** on L1 (so the user actually owns SOL exposure and can be funded,
liquidated, and paid out), the fill data must reach L1.

The obvious route — **commit the OrderBook to L1** — is blocked by two facts
established in doc 3:

1. **The OrderBook can never be committed/undelegated** (612 KB ≫ the 10,240-byte
   per-CPI growth cap; undelegation doesn't complete cleanly; and dragging the
   whole book to L1 defeats the "book lives in the ER" premise).
2. **The 10-commit-per-account cap** would cap any account we *did* commit after
   just 10 snapshots.

So settlement cannot ride on the order book. It needs a different vehicle.

> Without this piece the whole product is useless: you could place orders fast,
> but you could never actually *own* a settled position. Solving it was the final
> load-bearing piece.

---

## 4.2 The idea: decouple settlement with a tiny side account

Introduce a small, separate **FillLog** account that carries fills to L1 *instead
of* the order book:

- It's **small** (~8 KB) → it can be created in **one** CPI and committed cheaply.
- It's a **PDA keyed by epoch** → when its 10-commit budget runs low, mint a fresh
  one (new epoch) with a brand-new budget.
- The **OrderBook stays delegated forever, never committed** → it never hits a
  commit cap, and never has to move its 612 KB.

The flow, end to end:

```
  ER                                   ER                ER→L1            L1
 ┌──────────┐  mirror_fills  ┌────────┐ commit_fill_log ┌──────┐ settle ┌──────────┐
 │ OrderBook│ ─────────────▶ │FillLog │ ───────────────▶│  L1  │ ──────▶│ Positions│
 │ (612 KB, │  copy new      │ ~8 KB  │  ScheduleCommit │ copy │ _from_ │  (real,  │
 │ delegated│  FillEvents    │ ring of│  (cheap, own    │ of   │ _log   │  settled)│
 │ forever) │  seq>cursor    │ 80     │   budget)       │ log  │        │          │
 └──────────┘                └────────┘                 └──────┘        └──────────┘
```

---

## 4.3 The FillLog account (`state/fill_log.rs`)

```
FillLogHeader (32 bytes) + ring of 80 FillEvents (80 × 104)  ≈  8,352 bytes
```

Deliberately sized so the **whole account stays well under the 10,240-byte cap** —
that's the entire point. Key header fields:

- `epoch: u32` — the FillLog PDA is derived from `["fill_log", market_le,
  epoch_le]`, so **bumping the epoch yields a brand-new account with a fresh
  10-commit budget.**
- `capacity` / `count` / `head` — a standard ring buffer of `FillEvent`s.
- `last_mirrored_sequence: u64` — the highest OrderBook fill `sequence` already
  copied into this log, so the mirror step resumes exactly where it left off and
  each orderbook fill is appended once.

`push()` appends to the ring; if full, it overwrites the oldest (a safety valve —
in normal operation the keeper commits + settles faster than 80 new fills accrue,
so live fills are never lost).

---

## 4.4 The five instructions (0x1D–0x21)

Added in "Round 5", these are the entire pipeline. `place_order` is **completely
untouched** — there is zero new work on the hot trading path.

| Ix | Name | Runs on | What it does |
|---|---|---|---|
| `0x1D` | `initialize_fill_log` | L1 | Create the small PDA in one CreateAccount CPI. |
| `0x1E` | `delegate_fill_log` | L1 | Delegate it to the ER (the proven small-account flow, mirroring `delegate_trading_credit`). |
| `0x1F` | `mirror_fills` | **ER** | Copy OrderBook fills with `sequence > last_mirrored_sequence` into the FillLog ring. Streams **one fill at a time** (a `[FillEvent; 80]` stack array would overflow the 4 KB BPF frame). |
| `0x20` | `commit_fill_log` | **ER** | `ScheduleCommit` the **small** log to L1 (cheap; uses the log's own commit budget). |
| `0x21` | `settle_from_log` | **L1** | Read the committed log **read-only**, write/update `Position` accounts, OI, fees, insurance fund. **Skips orphan fills.** |

### Why `mirror_fills` streams one at a time

A BPF program has a ~4 KB stack frame. An `[FillEvent; 80]` local is 80 × 104 =
8,320 bytes — instant stack overflow. So the mirror copies fills individually
rather than buffering a batch on the stack.

### Why `settle_from_log` skips "orphan" fills

A `FillEvent` references a `maker` and a `taker`. Some fills involve a party that
has **no L1 account** (e.g. a maker/taker from a prior bot session that was torn
down). Settling such a fill is impossible — there's no Position to write. Rather
than letting one orphan fill wedge the whole queue, `settle_from_log` **skips it
and advances the cursor past it**, so settlement never stalls.

### Reusing the battle-tested settlement math

`settle_from_log` doesn't reinvent position accounting — it reuses
`settle_trades`' `update_position` helper (VWAP entry, realized PnL, OI updates,
fee/insurance handling). The FillLog work added `pub(crate)` helpers and
`try_find` variants so both settlement paths share the same core logic.

---

## 4.5 The settlement cursor (settle-exactly-once)

Because the OrderBook is delegated to the ER, L1 code may **read** its committed
fill ring but must **not** mutate the ring's head/count (only the ER may). So "how
far have I settled?" can't be tracked by popping the ring on L1.

Instead, the **`Market` account** owns a `last_settled_sequence` cursor. It's
stored in the first 4 bytes of the `Market`'s trailing padding interpreted as a
little-endian `u32` — chosen so `Market::LEN` is byte-identical to the deployed
layout and **no market re-init was needed**. (A `u32` covers ~4.29B fills, far
beyond an MVP.) Each settlement pass advances the cursor; fills settle **exactly
once** across repeated keeper calls. (See `Market::last_settled_sequence` /
`set_last_settled_sequence` in `state/market.rs`.)

So there are two independent progress markers, one per stage:
- `FillLogHeader.last_mirrored_sequence` — how far **mirroring** (ER) has gotten.
- `Market.last_settled_sequence` — how far **settlement** (L1) has gotten.

---

## 4.6 Epoch rotation = unbounded settlement

This is the clever bit that turns a hard 10-commit cap into **unlimited**
settlement. The cap is *per account*, so the keeper just keeps minting fresh
accounts:

```
epoch 0 FillLog:  commit, commit, … (×10) → CAPPED
                   rotate ↓
epoch 1 FillLog:  brand-new PDA → fresh budget of 10 → commit ×10 → CAPPED
                   rotate ↓
epoch 2 FillLog:  …
```

**Proven live:** epoch 0 committed exactly 10 then capped; epoch 1 (a fresh PDA)
got another full 10. Since each commit can flush up to the ring's 80 fills, one
epoch covers up to ~800 fills before it needs rotating. Old-epoch logs are drained
of their last fills, then abandoned (~8 KB rent each — trivial on devnet).

The keeper rotates **before** hitting the wall (it rotates around commit #9) so it
never actually trips the cap in steady state.

---

## 4.7 The keeper (`keepers/src/fill-log-keeper.ts`)

The off-chain loop that drives the pipeline (`npm run fill-log-keeper`,
configurable via `FILL_LOG_START_EPOCH`):

```
loop:
  mirror_fills      # ER: copy new OrderBook fills → FillLog
  commit_fill_log   # ER→L1: snapshot the log (rotate epoch at commit #9)
  settle_from_log   # L1: drain the committed log into Positions, in windows of 8
```

Settling in windows of 8 keeps each L1 transaction within account/compute limits.
The keeper has been running continuously through multiple epochs.

---

## 4.8 Verified result (it actually works)

From the live devnet run (`.superstack/fill-log-settlement-SOLVED.md`): bots'
ER fills produced **real, settled L1 Position accounts** — e.g. a taker holding a
SHORT 0.1 and another holding a LONG 0.4, with real collateral and realized PnL,
and the Market's open interest updated accordingly. The frontend's L1 Positions
table fills in for real once settlement lands, while `use-er-position` shows the
position instantly in the meantime.

---

## 4.9 Cost & latency summary (honest)

| Aspect | Reality |
|---|---|
| Trading speed | **Unaffected** — commits are async snapshots, never on the trade path. |
| Settlement latency | A few seconds (ER commit → L1 land → settle), batched. |
| Per-commit cost | ~0.0001 SOL. |
| Per-epoch cost | One abandoned ~8 KB FillLog's rent. Negligible on devnet. |
| Hot-path risk | **Zero** — `place_order` was never modified. |

---

## 4.10 Takeaways

- The 612 KB OrderBook **can't be committed**, so settlement rides a **small
  ~8 KB FillLog** instead.
- Pipeline: **`mirror_fills` (ER)** → **`commit_fill_log` (ER→L1)** →
  **`settle_from_log` (L1)**; `place_order` is untouched.
- Two cursors track progress: `last_mirrored_sequence` (ER side) and the
  `Market.last_settled_sequence` (L1 side, settle-exactly-once).
- **Epoch rotation** beats the 10-commit cap by minting fresh budgeted accounts —
  proven live, giving unbounded settlement.
- Orphan fills (no L1 account) are skipped so the queue never stalls.
- Next: what those settled positions actually mean financially →
  [doc 5](./05-margin-funding-liquidation.md).
