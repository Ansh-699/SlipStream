# 2 · The OrderBook & PDA Storage

> The question everyone asks: **"How does a single Solana PDA hold a ~612 KB
> order book?"** This doc answers it byte by byte.

---

## 2.1 What a PDA is (quick grounding)

A **Program Derived Address (PDA)** is a Solana account whose address is derived
deterministically from a set of **seeds** plus the program ID, and which has *no
private key*. Because no key exists, only the owning program can sign for it
(via `invoke_signed`). PDAs are how Solana programs own and mutate persistent
state.

The OrderBook is a PDA derived from a seed like `["order_book", market_index]`.
There is exactly one per market. It is owned by the Slipstream program, which is
the only thing that can write to it — except that it is **delegated** to the ER,
so during a session the ER writes to it instead (doc 3).

---

## 2.2 The size problem

A Solana account can, in principle, be up to **10 MB**. So 612 KB is allowed *to
exist*. The problem is **creating** and **growing** it:

> A single instruction may grow an account by at most
> **`MAX_PERMITTED_DATA_INCREASE` = 10,240 bytes** (10 KiB) per CPI.

So you cannot `CreateAccount` a 612 KB account in one shot, and you cannot
`realloc` it to full size in one call. You must grow it **~61 chunks at a time.**

This same 10,240-byte cap reappears as the villain in doc 4: it's why the giant
book can never be re-delegated or undelegated, which is why settlement needs a
separate small account.

---

## 2.3 Exact layout (the 612 KB, accounted for)

The account is one contiguous byte buffer: a fixed **header** followed by four
fixed-capacity arrays and a free list. From `state/order_book.rs`:

```
compute_account_size =
    OrderBookHeader::LEN                       // 48 bytes
  + max_order_slots   * OrderSlot::LEN          // order slot pool
  + max_price_levels  * PriceLevel::LEN         // BID levels
  + max_price_levels  * PriceLevel::LEN         // ASK levels
  + max_fill_events   * FillEvent::LEN          // fill-event ring
  + max_order_slots   * 2                        // free list (u16 per slot)
```

With the deployed defaults:

| Constant | Value |
|---|---|
| `DEFAULT_MAX_ORDER_SLOTS` | 2048 |
| `DEFAULT_MAX_PRICE_LEVELS` | 512 (per side) |
| `DEFAULT_MAX_FILL_EVENTS` | 4096 |
| `DEFAULT_ORDERS_PER_USER` | 20 |

The arithmetic, exactly:

| Section | Count × size | Bytes |
|---|---|---:|
| Header | 48 | 48 |
| Order-slot pool | 2048 × 88 | 180,224 |
| Bid price levels | 512 × 16 | 8,192 |
| Ask price levels | 512 × 16 | 8,192 |
| Fill-event ring | 4096 × 104 | 425,984 |
| Free list | 2048 × 2 | 4,096 |
| **Total** | | **626,736** |

626,736 bytes ÷ 1024 = **~612 KB**. The fill ring alone (425 KB) is two-thirds of
it — see §2.7 on why it's that big.

---

## 2.4 Chunked allocation (how it's actually built)

Because of the 10,240-byte cap, the bootstrap builds the account incrementally
(this is real deploy plumbing, documented in the root README):

```
initialize_market (0x00)
   └─ creates the OrderBook PDA with an initial chunk,
      pre-funded with enough lamports for the FULL 612 KB rent.

grow_orderbook (0x17)   ← called ~61 times in a loop
   └─ reallocs the account up by ≤10,240 bytes each call,
      until data.len() == compute_account_size(...).

   On the final grow (account now full size):
   └─ init_free_list(): chain every slot 0→1→2→…→SENTINEL,
      set free_list_head = 0, free_slot_count = max_order_slots.
```

Pre-funding full rent up front matters: an account must stay **rent-exempt**, so
the lamports for the final 612 KB are deposited at creation even though the bytes
arrive later.

`626,736 / 10,240 ≈ 61.2`, so it takes ~61–62 `grow_orderbook` calls to reach
full size. Only once full is the free list initialized — before that the slot
pool isn't fully addressable.

---

## 2.5 Zero-copy access (why it's not deserialized)

You cannot afford to deserialize 612 KB into a heap struct inside a BPF program
(4 KB stack frame, tight compute budget). Slipstream uses **zero-copy**: it
reinterprets the raw account bytes *in place* as typed slices, copying nothing.

`OrderBookView::from_account_data` (in `state/order_book.rs`):

1. Validates `data.len()` ≥ expected size and `data[0]` == the OrderBook
   discriminator.
2. Reads the header's capacity fields.
3. Carves the one byte buffer into typed mutable slices with pointer arithmetic:

```rust
let ptr = data.as_mut_ptr();
let header      = &mut *(ptr as *mut OrderBookHeader);
let order_slots = slice::from_raw_parts_mut(ptr.add(off) as *mut OrderSlot, max_slots);
let bid_levels  = slice::from_raw_parts_mut(...);
let ask_levels  = slice::from_raw_parts_mut(...);
let fill_events = slice::from_raw_parts_mut(...);
let free_list   = slice::from_raw_parts_mut(...);
```

This is sound because every struct is **`Pod`** (plain-old-data) and
**`#[repr(C)]`** — a fixed, predictable, padding-explicit layout with no pointers
and no enums. `bytemuck` enforces the `Pod`/`Zeroable` bounds. The cost of
"loading" the book is therefore O(1): a handful of pointer casts, regardless of
the 612 KB. Mutations write straight into the account buffer.

> **Why explicit padding?** Notice fields like `_pad1: [u8; 3]` and `_pad2: [u8; 2]`
> in the header. `#[repr(C)]` requires fields to be naturally aligned; the program
> spells out the padding so the Rust layout is byte-identical across platforms and
> matches what the TypeScript decoder in `client/src/accounts.ts` expects. A
> mismatch here would silently corrupt every read.

---

## 2.6 The data structures inside

### Order-slot pool + free list (object pool)

`OrderSlot` (88 bytes) is one resting/working order: side, type, `order_id`,
`owner`, `price`, `size`, `remaining_size`, `expiry_ts`, and `margin_reserved`
(the margin this order holds against the user's `TradingCredit`).

Slots are managed as an **object pool** with an intrusive **free list**:
- `free_list[i]` stores the index of the *next* free slot, forming a singly
  linked chain ending in `SENTINEL`.
- `alloc_slot()` pops `free_list_head` in O(1).
- `free_slot()` clears the slot and pushes it back in O(1).

No heap allocation, no fragmentation, deterministic cost — exactly what an
on-chain matching engine needs.

### Price levels (sorted ladders)

Each side keeps an array of `PriceLevel` (16 bytes: `price`, `head_slot`,
`tail_slot`, `order_count`). **Bids are sorted descending, asks ascending**, so
the best bid/ask is always index 0 — O(1) to read the top of book. Within a level,
orders form a linked list through the slots (`next_at_level`/`prev_at_level`),
preserving **time priority**. Inserting a new price shifts the array to keep it
sorted (`insert_bid_level`/`insert_ask_level`); lookups use binary search
(`find_bid_level`/`find_ask_level`).

So matching is: read level 0 (best price), walk its slot linked-list oldest-first
(price-time priority), fill, drain margin, emit a `FillEvent`.

### Fill-event ring (the audit trail)

Matches don't immediately touch L1 — they can't, the book is in the ER. Instead
each fill is pushed onto a **ring buffer** of `FillEvent`s (the `push_fill_event`
/ `pop_fill_event` / `peek_fill_event` methods, indices `fill_event_head` /
`fill_event_tail` / `fill_event_count`, wrapping modulo `max_fill_events`). This
ring is the source of truth that the settlement pipeline later mirrors and
settles (doc 4). It's also what the frontend's "Recent Trades" reads — from
`fill_event_head`, the oldest live fill.

---

## 2.7 Why the fill ring is 4096 entries (425 KB)

The fill ring is deliberately huge because of the settlement model. Fills
accumulate in the book until a keeper mirrors and settles them (doc 4). The ring
must hold enough history that no live fill is overwritten before it's been
mirrored to L1. At 4096 entries the book can absorb a large burst of trading
between keeper passes without losing a fill. The tradeoff is size — but a Solana
account can be up to 10 MB, so 612 KB is comfortably within budget; the binding
constraint was never total size, it was the **per-CPI 10 KB growth cap** (§2.2),
which §2.4 works around.

---

## 2.8 Settlement progress without mutating the book

One subtlety: on L1, the book is delegated to the ER, so L1 code can read the
committed fill ring but **must not** mutate its head/count (that's the ER's job).
So "which fills have I already settled?" can't be tracked by popping the ring on
L1. Instead the **`Market` account** stores a `last_settled_sequence` cursor
(tucked into spare padding bytes as a little-endian `u32`, so the `Market` layout
didn't change). Settlement advances this cursor; fills are settled exactly once
across repeated keeper calls. Details in doc 4.

---

## 2.9 Takeaways

- A PDA can hold 612 KB; the challenge is the **10,240-byte per-CPI growth cap**,
  solved by **chunked `grow_orderbook` allocation** (~61 calls).
- The book is one flat `#[repr(C)]`/`Pod` byte buffer read via **zero-copy**
  slices — O(1) to "load" regardless of size.
- Inside: an **object-pooled slot array + free list**, **sorted price-level
  ladders** (best price at index 0, time priority within a level), and a giant
  **fill-event ring** that feeds settlement.
- The same growth cap that complicates creation makes the book **un-undelegatable**,
  which is the whole reason settlement is decoupled — straight to
  [doc 3](./03-ephemeral-rollups-and-delegation.md) and
  [doc 4](./04-settlement-and-the-fill-log.md).
