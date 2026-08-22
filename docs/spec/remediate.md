# Spec: `remediate` — closing the eight P0 defects found by `audit-e2e`

**Run:** `remediate` · **Tracking issue:** #30 · **Branch:** `factory/remediate` (HEAD `20c4280`)
**Input:** `docs/audit/audit-e2e/s{1,2,3,4,5,10}.md`, the repro artifacts under
`docs/audit/audit-e2e/repro/`, and the closing review `docs/review/audit-e2e/review-spec.md`.

## Assumptions (orchestrator rulings, intake)

Scope ruled A (auto, 5m silence): severity waves in this run; Wave 1 = the P0 set,
S5-01 first. HARD STOP: this run does not deploy, does not touch keys, sends no
transactions.

All seven strategist questions resolved to their recommended defaults:

1. **`withdraw_collateral`'s dead `reserved_margin` gate becomes live** — accept
   the restriction. Strictly safer, one line, and a user can withdraw credit first.
2. **`seed_credit_ledger` ships permanently.** The admin key can already replace
   the program, so it adds no trust that does not exist. Residual risk recorded:
   it is an authority-writable ledger field, and combined with a hostile ER it
   raises a ceiling — it cannot mint on its own.
3. **Halt matching when the ring is full of unmirrored fills.** A halt is
   recoverable; a destroyed fill is not.
4. **Leave `settle_trades` in the program, stop the settlement-keeper service.**
   Removing program surface under time pressure is its own risk. Consistent with
   S7-C12: nothing supervises that service today anyway.
5. **Funding clamp = ±0.5% per interval, 3 catch-up intervals** (bounds one call
   to ±1.5% of notional). THIS IS ECONOMIC POLICY, NOT SAFETY. The default is a
   guess at the right number; the *shape* (clamped premium, capped catch-up) is
   the safety property and does not depend on the values. Changing them later is
   a constant edit, not a redesign.
6. **The four S10-01 key-ceremony actions: NONE performed.** Mint authority,
   upgrade authority to multisig, `GlobalState.authority` rotation, treasury
   re-point are human-only. No code fix invented for a key-management problem.
7. **Deploy sequencing and downtime: operator's call.** Recorded plainly: the
   33,146 already-destroyed fills are unrecoverable under any ordering.

**P0 count, corrected.** 12 records reduce to **8** only if S4-06 and S4-07 merge
— which `s4.md`'s own `Pairs with` block asserts. The closing review's stated
merges alone give **9**. Slice cuts are identical either way. Quote 8-or-9, never
12, and never a bare number without the record count beside it.


## Goal

The audit found twelve P0 records that reduce to **eight distinct defects**. Six of them let
value be created or destroyed on the money path of a program that is deployed and holding
funds; one strands 13,313.24 USDC of live user principal behind a size check; one is a
key-custody concentration that mostly cannot be fixed in this repository at all.

This run designs and lands the code fixes. It **does not deploy**. Every fix must be provable
by a Mollusk regression test that fails against the current program and passes after, and no
fix may change the byte layout of an account type that has live instances.

The anchor is **S5-01**: a hostile ER can write any value into `TradingCredit.credit` and L1
pays it out of the vault. Everything else in this spec is arranged around the constraint that
decides it.

### The eight defects, and how twelve records reduce to them

| # | Defect | Records | Slice |
|---|---|---|---|
| 1 | A hostile ER mints `TradingCredit.credit`; L1 pays it out | `S5-01`, `S5-X04` | R1 |
| 2 | Legacy 56-byte `TradingCredit`s are unreachable by every instruction | `S1-01` | R2 |
| 3 | The fill-event ring overwrites unmirrored fills; the mirror cursor jumps the hole | `S2-01`, `S2-X01`, `S4-03`, (`S4-X01`, P1) | R3 |
| 4 | The settlement cursor is a high-water mark, so a fill absent from the batch settles zero times | `S4-01` | R4 |
| 5 | L1 applies ER-authored `FillLog` fields without re-deriving any of them | `S4-06`, `S4-07` | R4 |
| 6 | `pending_fills` is bumped per user and decremented per fill-side, with no reset | `S4-04` | R5 |
| 7 | An uncapped funding premium times uncapped catch-up intervals | `S3-01` | R6 |
| 8 | One key is upgrade, mint, admin, treasury, keeper and web-route signer | `S10-01` | R7 (code half only) |

Defects 4 and 5 land in the same two files and therefore share slice R4. `S4-06` and `S4-07`
are one defect by `s4.md`'s own `**Pairs with**` block: same precondition (an ER that authors
the committed bytes), same consequence (`Position.collateral` credited with value nothing
debited), same grade.

## Target flow

The change to the credit money path, stated as the sequence a reader should hold in mind:

1. `deposit_collateral` moves USDC into the vault and credits `UserAccount.free_collateral`. Unchanged.
2. `fund_trading_credit` debits `free_collateral`, credits `TradingCredit.credit`, **and raises an
   L1-authoritative ledger on the `UserAccount` by the same amount.** New third step.
3. `delegate_trading_credit` hands the whole `TradingCredit` to the delegation program. The ER now
   owns every byte of it. Unchanged, and unfixable — see `## Implementation decisions`.
4. Matching runs in the ER, draining `credit` into `margin_reserved` and then into `FillEvent.filled_margin`.
5. Settlement applies the committed fill on L1 **and lowers the same ledger by the margin it applied.** New.
6. `undelegate_trading_credit` returns the account. Its `credit` field is now whatever the ER says.
7. `withdraw_trading_credit` pays out **`min(credit.credit, ledger)`** and lowers the ledger. New cap.
8. `withdraw_collateral` moves `free_collateral` out of the vault. Unchanged.

Steps 2, 5 and 7 are the whole of defect 1's fix. Step 5 is also half of defect 5's fix.

## Non-goals

- **No deploy, no key operations, no transactions.** Devnet access in this run is read-only RPC.
  The program is not upgraded, `deploy.json` is not touched, no keypair is read or rotated.
- **No account-layout growth.** No `LEN` constant of any state type with live instances changes.
  `TradingCredit::LEN` stays 96, `UserAccount::LEN` stays 56, `Position::LEN` stays 96,
  `Market::LEN` and `OrderBookHeader::LEN` are untouched. `GlobalState` grows only through the
  append-past-`LEN` lazy-resize pattern it already uses.
- **No P1/P2/P3 findings.** The audit filed 39 P1, 70 P2 and 42 P3. Only P0 is in scope. Two P1s
  are adjacent and deliberately left open: the one-way delegation door (`S5-02`), which is why
  the twelve delegated legacy credits stay stranded after this run; and the latching circuit
  breaker (`S5-03`). Two free P3 corrections ride along inside slices that already own the file:
  the stale settlement comment (review `R-13`) and the `S3-C1` division enumeration.
- **No weakening of an existing check.** Every guard the program has today survives this run. The
  only guard whose *meaning* changes is `withdraw_collateral`'s dead `reserved_margin > 0` gate,
  which becomes live — see `## Open human decisions`.
- **No key ceremony.** The four role separations in defect 8 that need a human are named, not
  performed. See `S10-01` below.

## Assumptions

No timed rulings were present in the dispatch context. Every open decision is carried to
`## Open human decisions` rather than assumed.

- **2026-08-22** — The dispatch's "8 distinct P0 defects" is reconciled here as the twelve P0
  records minus the merges the review established (`S2-01`≡`S2-X01`≡`S4-03`, `S5-01`≡`S5-X04`)
  and the merge `s4.md` states in its own text (`S4-06` pairs with `S4-07`). If the orchestrator
  intends `S4-06` and `S4-07` as two defects, the count is nine and the slice cuts are unchanged.

## Implementation decisions

### The seam

**One seam, and it already exists: the L1/ER ownership boundary.** Every one of the eight defects
is a statement about what crosses it. The run adds no new seam and no new module. It changes the
interface of three existing modules that sit on that boundary — the trading-credit ledger, the
fill pipeline's cursors, and the settlement reader — and adds three small administrative
instructions to the existing dispatch module.

### Decision 1 — where the L1-authoritative credit ceiling lives, and why the ER cannot write it

**Verified: the constraint is real.** `delegate_trading_credit` zeroes the whole `TradingCredit`
account, writes the System program into its owner slot, and then `Assign`s it to the delegation
program (`delegate_trading_credit.rs:214-231`). It is the entire account, not a region of it. Any
field added to `TradingCredit` — high-water mark, `funded` counter, version tag, checksum — is
ER-writable the moment the account is delegated. **The ceiling cannot live in `TradingCredit`.**
The audit's own suggested remediation ("add an L1-authoritative `funded_total` to `TradingCredit`")
is therefore not a fix, and this spec does not follow it.

**The ceiling lives in `UserAccount`.** Three independent proofs that the ER cannot author its bytes:

1. **The delegation inventory is exhaustive and does not contain it.** An account leaves this
   program's ownership only through a System `Assign` whose target owner is the delegation
   program, and there are exactly three such sites in the whole program — `delegate_orderbook`,
   `delegate_trading_credit`, `delegate_fill_log`. Re-verified at this head:

   ```
   $ grep -rn "owner: &DELEGATION_PROGRAM_ID" programs/slipstream/src/
   programs/slipstream/src/instructions/delegate_orderbook.rs:191:        owner: &DELEGATION_PROGRAM_ID,
   programs/slipstream/src/instructions/delegate_trading_credit.rs:229:        owner: &DELEGATION_PROGRAM_ID,
   programs/slipstream/src/instructions/delegate_fill_log.rs:197:        owner: &DELEGATION_PROGRAM_ID,
   ```

   No `UserAccount`, `Position`, `Market`, `GlobalState` or vault. This matches `PRODUCT.md` and
   `docs/01-architecture-overview.md`, and unlike those documents it is checkable.

2. **`UserAccount` never appears in an ER transaction.** The two ER-native instructions are
   `place_order` and `cancel_order`. Neither mentions the type at all:

   ```
   $ grep -c "UserAccount" programs/slipstream/src/instructions/place_order.rs \
                            programs/slipstream/src/instructions/cancel_order.rs
   programs/slipstream/src/instructions/place_order.rs:0
   programs/slipstream/src/instructions/cancel_order.rs:0
   ```

   So the account is not merely undelegated; it is not in the account list of anything the ER runs.

3. **Even if it were passed, the ER could not write it.** An account not delegated to the ER
   validator is a read-only clone inside the ER runtime. A write attempt fails there, not silently.

Proof (1) is the load-bearing one: it is an enumeration over the only mechanism by which ownership
can change, so it holds for any future instruction unless a fourth `Assign` site is added.

### Decision 2 — the ceiling occupies the dead `reserved_margin` field, so no layout changes

`UserAccount` has no spare eight bytes: its `_padding1` is four bytes consumed by alignment before
`owner`. Growing the struct changes `UserAccount::LEN` from 56, and every load site rejects
`data.len() < Self::LEN` — which would brick all 45 live `UserAccount`s on the next upgrade. That
is precisely the S1-01 failure mode this run exists to stop repeating, so it is refused.

`UserAccount` already carries a dead u64. `reserved_margin` has exactly one write site in the whole
program, and it writes zero:

```
$ grep -rn "reserved_margin" programs/slipstream/src/
programs/slipstream/src/instructions/withdraw_collateral.rs:82:    if user.reserved_margin > 0 {
programs/slipstream/src/instructions/initialize_user.rs:63:    user.reserved_margin = 0;
programs/slipstream/src/state/user_account.rs:15:    pub reserved_margin: u64,
programs/slipstream/src/instructions/close_user_account.rs:16:///   - `reserved_margin == 0`
programs/slipstream/src/instructions/close_user_account.rs:34:/// them catch an open position: `reserved_margin` is never incremented anywhere
programs/slipstream/src/instructions/close_user_account.rs:79:    if user.reserved_margin != 0 {
```

`close_user_account.rs:34` states the fact in the source: *"`reserved_margin` is never incremented
anywhere"*. It is therefore provably zero on every account that exists, which is exactly the
correct initial value for a "credit outstanding" ledger. The field is renamed to
`credit_outstanding` and given a meaning. **Zero bytes move, no `LEN` changes, no realloc, no rent
top-up, no account is bricked.**

This is the codebase's own pattern, not a new one: `Market::mark_price_minute` is a u16 overlaid on
`Market._padding1` specifically "so `Market::LEN` is byte-identical" (`market.rs:137`).

Consequence to accept deliberately: the two existing guards that read the field
(`withdraw_collateral`'s gate 2 and `close_user_account`'s) stop being dead. `close_user_account`
refusing while credit is outstanding is correct and desirable. `withdraw_collateral` refusing to
pay out free collateral while credit is parked in a market is a behaviour change with a UX cost —
carried to `## Open human decisions`.

### Decision 3 — the ledger's invariant, and why it is exact rather than approximate

`credit_outstanding` is the L1's own record of how much of this user's collateral is currently
sitting inside a trading credit:

- `fund_trading_credit` raises it by the funded amount (`checked_add`), in the same instruction
  that lowers `free_collateral`.
- Settlement lowers it by the `filled_margin` it applies to each leg — the moment margin stops
  being credit and becomes position collateral.
- `withdraw_trading_credit` pays out at most `min(credit.credit, credit_outstanding)` and lowers
  the ledger by what it paid.

Under an honest ER these three are the complete set of transitions, so
`credit.credit == credit_outstanding` at all times and the cap never binds. Under a hostile ER,
`credit.credit` is arbitrary and `credit_outstanding` is not, so the payout is bounded by
`funded − settled − withdrawn`: **the ER cannot cause a single atom more to leave the vault than
the user put in.** That is the sentence `PRODUCT.md:38` claims and today does not have.

**Is `credit.credit` genuinely monotone-decreasing off-chain?** Checked, because a naive high-water
mark would break honest withdrawals if the ER could legitimately raise it. It is:

```
$ grep -c "TradingCredit" programs/slipstream/src/instructions/settle_from_log.rs \
                           programs/slipstream/src/instructions/settle_trades.rs
programs/slipstream/src/instructions/settle_from_log.rs:0
programs/slipstream/src/instructions/settle_trades.rs:0
```

Neither settlement entry point references the type at all — no profit, no rebate, no funding, no
insurance path writes it. The exhaustive writer set is the six sites in `S5-01`'s pasted grep: one
increment on L1 (`fund_trading_credit`, `checked_add`), one decrement on L1
(`withdraw_trading_credit`, `saturating_sub`), two decrements reachable from the ER
(`place_order`'s `checked_sub` and `reconcile_credit`'s `saturating_sub`), and one zero-init. A
monotone ceiling therefore never blocks an honest withdrawal, and the design does not need a
high-water mark at all — a running balance is both simpler and tighter.

**Named ceiling.** Without the settlement debit (the third transition), the cap degrades from
exact to "each user can extract at most their own cumulative realised trading losses". That is a
large improvement over "the entire vault" but it is not conservation. This is why the settlement
debit is a required part of the run and not an optional refinement, and why R1 and R4 must both
land before the next deploy.

**Named griefing surface.** A hostile ER can forge fills naming a victim and drive that victim's
`credit_outstanding` to zero, blocking their credit withdrawal. It is bounded: R4's `filled_margin`
re-derivation caps each forged debit at the honest margin for a fill of that size, and the victim's
`free_collateral` is untouched. A hostile ER already has unbounded griefing power over order flow;
this adds no new class.

### Decision 4 — migration, stated exactly

No bytes move and no size check changes, so there is no migration in the usual sense. What does
need a decision is the **pre-upgrade population**: accounts whose `credit.credit` is non-zero but
whose `credit_outstanding` reads zero, and which would therefore become un-withdrawable the moment
the cap goes live. The live devnet population, from `s1.md`'s read-only `getProgramAccounts` at
`2026-08-21T19:17Z`:

| Population | Count | Value | Handled by |
|---|---|---|---|
| Modern 96-byte, program-owned (undelegated) | 1 | 500.00 USDC | R1's `seed_credit_ledger` |
| Legacy 56-byte, program-owned (undelegated) | 4 | 13,313.24 USDC | R2's length-tolerant recovery |
| Legacy 56-byte, delegation-program-owned | 12 | ≈13,000 USDC | **Nothing. Still stranded.** |
| `UserAccount`s (all with `reserved_margin == 0`) | 45 | — | Nothing needed |

The twelve delegated credits are unreachable from L1 by any instruction, because the program owns
none of their bytes and has no L1 undelegation path. That is `S5-02` (P1), out of scope, and this
run does not recover them. Saying so plainly is part of the deliverable.

**`seed_credit_ledger`** is the grandfather instruction: authority-signed, requires the credit to be
program-owned (undelegated), requires `credit_outstanding == 0`, and sets it to `credit.credit`. It
is one-shot per account by that precondition. It re-trusts the credit's current value once, which
is acceptable only because the signer is `GlobalState.authority` — a key that can already replace
the program, so the instruction grants no capability its holder lacks. The ER cannot reach it.
Whether to ship a permanent authority-gated bypass at all is carried to `## Open human decisions`.

**`TradingCredit` gets a layout-version byte** in its ER-owned `_padding` (R2), as `S1-01`'s
remediation suggests. It is used only to dispatch a *read*, never to authorise a payout, so the ER
owning it is harmless: the worst a forged version byte does is route a load to the wrong offsets,
which the discriminator and length checks already bound.

### Decision 5 — the fill pipeline has three cursors and none of them checks contiguity

Defects 3 and 4 are one sentence at three hops:

| Hop | Cursor | What it does today | What it must do |
|---|---|---|---|
| Produce | `OrderBook.fill_event_head`, implicitly | overwrites the oldest entry at capacity and returns `Ok` | refuse when the ring is full of unmirrored fills |
| Mirror | `FillLog.last_mirrored_sequence` | jumps to the batch maximum without checking the ring's oldest surviving sequence | error naming the gap; drain what it mirrored |
| Settle | `Market.last_settled_sequence` | set to the batch maximum unconditionally | advance only across the contiguous run from `last_settled + 1` |

They are two slices because they are two disjoint file sets, not because they are two problems.
**They must ship in the same release**: fixing the settle hop alone converts silent loss into a
permanently stalled cursor, because the gaps the ring already created are still there.

The producer fix has a trap the current comment documents: `push_fill_event` used to error when
full, and that "bricked trading after `max_fill_events` cumulative fills" because nothing drains
`fill_event_count`. Refusing without a drain re-creates that wall. So the drain is part of the fix:
`mirror_fills` advances `fill_event_head` and lowers `fill_event_count` past the prefix it
successfully mirrored. It can — both the `OrderBook` and the `FillLog` are delegated, so
`mirror_fills` executes inside the ER where the book is writable. After the drain, "ring full"
means "full of fills the mirror has not taken", which is exactly the condition under which halting
matching is correct.

**No `OrderBookHeader` field is added.** The header sits before four variable-length arrays whose
offsets are computed from `OrderBookHeader::LEN`; growing it would misread the live 612 KB book,
which holds real resting orders. This rules out the `dropped_fill_count` /
`oldest_surviving_sequence` pair `S2-01` suggests. The oldest surviving sequence is derivable
without new state as `next_fill_sequence − fill_event_count`.

Consequence for `settle_trades`: it reads the same ring on L1 and shares
`Market.last_settled_sequence` with `settle_from_log`. Once `mirror_fills` drains, `settle_trades`
sees only the undrained tail, and R4's contiguity rule will make it stall rather than skip. That is
correct behaviour, and it means the operator must run exactly one settlement path. Carried to
`## Open human decisions`.

### Decision 6 — the settlement reader re-derives what it can and rejects what it cannot

`settle_from_log` and `settle_trades` validate the FillLog PDA, discriminator, capacity and account
length, then apply `price`, `size`, `maker`, `taker`, `maker_side` and `filled_margin` verbatim.
Three additions, all in the same validation block:

- **Bound `count` by `capacity`.** One comparison, alongside the existing `capacity == 0` check.
  Closes `S4-07`'s 819×-replay.
- **Compare the in-loop skip test against the running batch maximum, not the pre-loop snapshot**, so
  a duplicate sequence inside one batch is caught even if the header lies.
- **Re-derive the margin bound.** Reject any fill whose `filled_margin` exceeds
  `compute_initial_margin(compute_notional(fill.quantity, fill.price), market.max_leverage)`. Both
  helpers already exist and are already used by `place_order`. Closes `S4-06` without passing any
  new account into settlement.

Plus the ledger debit from Decision 3, which is two lines in a block that already holds the
`UserAccount` mutably.

### Decision 7 — funding is clamped at the source, not gated at the caller

`S3-01` multiplies an unclamped premium by an unclamped interval count. The root cause is the
absence of both bounds, not the absence of a signer: with a per-interval rate clamp and a catch-up
interval cap, a permissionless `compute_funding` is harmless, and the instruction stays
permissionless as designed. `crank_twap`'s missing signer is `S5-03` (P1) and is not in scope.

The clamp *values* are economic policy and are carried to `## Open human decisions`.

### Decision 8 — `S10-01` is mostly not a code defect, and this spec does not invent one

Stated plainly, because the dispatch asks for it:

**Four of the five role concentrations cannot be fixed in this repository by any code change.**
They are key-ceremony actions only the human operator can take, each with an existing tool:

- Move USDC mint authority to a faucet-only key (`spl-token authorize <mint> mint <new>`).
- Move BPF upgrade authority to a multisig (`solana program set-upgrade-authority`).
- Rotate `GlobalState.authority` to a cold key — the program already ships the two-step
  `propose_authority` / `accept_authority` path for exactly this.
- Re-point `GlobalState.treasury` away from the operator's personal wallet (same admin path).

The faucet route reading the same key out of an environment variable on a public HTTPS endpoint is
a deployment-configuration change, also not a code fix.

**One half is a genuine code defect and is in scope.** Three instructions —
`record_pending_fill`, `initialize_fill_log`, `delegate_fill_log` — gate on
`GlobalState.authority`, and the fill-log keeper signs exactly those with a hot key on the keeper
VM. There is no way to give that keeper a lesser key without a program change. R7 adds a distinct
`keeper` role on `GlobalState` and lets those three accept it. The other five keeper services and
both bots need no program change at all, per `s10.md`'s own instruction table, and moving them is
an ops action.

`GlobalState` is the one type that may grow, using the append-past-`LEN` lazy-resize pattern it
already uses for `pending_authority` (`propose_authority.rs:79-92`). The three gated instructions
accept the keeper only when the account is long enough *and* the field is non-zero, and otherwise
fall back to `authority` — so a not-yet-extended live `GlobalState` keeps working unchanged and
nothing is bricked before the operator runs `set_keeper`.

### Arithmetic discipline

`Cargo.toml:8-13` keeps `[profile.release]` at the workspace root with `overflow-checks = true`,
recorded there because a past deploy wrapped arithmetic silently. All new money arithmetic uses
`checked_add` / `checked_sub` and returns `MathOverflow`. The one deliberate exception is the
settlement-side ledger debit, which saturates at zero: a lying ER must not be able to abort honest
settlement by over-debiting, and the value is a floor, not a balance. It carries a comment saying so.

`programs/slipstream/src/error.rs` gains new variants. **Append only** — the keepers decode errors
by ordinal (`settlement-keeper.ts:38` names `FillQueueEmpty` as "error.rs index 29"), so inserting
a variant silently re-labels every error after it.

## Slices

Seven slices, one builder each, disjoint file sets. Two registration files are shared and
append-only; see the note below the table.

### R1 — Credit ceiling *(anchor)* · closes `S5-01` + `S5-X04`

- **Module:** the trading-credit ledger. **Interface:** `fund_trading_credit` and
  `withdraw_trading_credit`, plus the `UserAccount` field they now maintain.
- **Fix:** rename the dead `reserved_margin` to `credit_outstanding` and give it the invariant in
  Decision 3; raise it on fund, cap and lower it on withdraw; add the authority-gated one-shot
  `seed_credit_ledger`.
- **Migration/compat:** no `LEN` change, no realloc. All 45 live `UserAccount`s read zero, which is
  correct for every account except the one pre-upgrade funded credit, which `seed_credit_ledger`
  covers. `withdraw_collateral`'s previously-dead gate becomes live — see the ruling.
- **Files:**
  `programs/slipstream/src/state/user_account.rs`,
  `programs/slipstream/src/instructions/fund_trading_credit.rs`,
  `programs/slipstream/src/instructions/withdraw_trading_credit.rs`,
  `programs/slipstream/src/instructions/initialize_user.rs`,
  `programs/slipstream/src/instructions/withdraw_collateral.rs`,
  `programs/slipstream/src/instructions/close_user_account.rs`,
  `programs/slipstream/src/instructions/seed_credit_ledger.rs` *(new)*,
  `frontend/src/lib/slipstream/accounts.ts`,
  `frontend/src/hooks/use-positions.ts`,
  `client/src/accounts.ts`,
  `keepers/src/inspect-user.ts`,
  `tests/unit/src/test_credit_ceiling_regressions.rs` *(new)*.

### R2 — Legacy credit recovery · closes `S1-01`

- **Module:** `TradingCredit` loading. **Interface:** `close_trading_credit`, plus a length-tolerant
  read path on the state type.
- **Fix:** before the typed load, accept `data.len() >= LEGACY_LEN` and read `owner`, `credit`,
  `committed`, `active_orders` by fixed offset — identical in both layouts — credit `credit` back to
  the caller's `UserAccount.free_collateral`, then close for rent. Add the layout-version byte in the
  ER-owned `_padding` so a future `LEN` change cannot strand accounts again.
- **Migration/compat:** the recovery branch accepts **only** `data.len() == LEGACY_LEN` (56). Modern
  96-byte credits keep going through `withdraw_trading_credit` and R1's cap, so this path is not a
  ceiling bypass. This is the constraint that keeps R1 and R2 independent.
- **Files:**
  `programs/slipstream/src/instructions/close_trading_credit.rs`,
  `programs/slipstream/src/state/trading_credit.rs`,
  `tests/unit/src/test_legacy_credit_recovery.rs` *(new)*.

### R3 — Lossless fill ring · closes `S2-01`, `S2-X01`, `S4-03` (and the P1 `S4-X01`)

- **Module:** the fill-event ring's producer/consumer contract. **Interface:** `push_fill_event` and
  `mirror_fills`.
- **Fix:** `push_fill_event` returns `FillQueueFull` instead of overwriting; `place_order` surfaces
  it so matching halts rather than destroying a fill. `mirror_fills` requires the ring's oldest
  surviving sequence (`next_fill_sequence − fill_event_count`) to be at most
  `last_mirrored_sequence + 1` and errors naming the gap otherwise, and drains the prefix it
  mirrored so the ring cannot wall up.
- **Migration/compat:** no `OrderBookHeader` field is added, so the live 612 KB book decodes
  unchanged. The live ring is *currently* full and wrapped (`head == tail == 3229`,
  `count == 4096`), so on the first post-upgrade run matching halts until the mirror drains it. That
  is intended and must be in the deploy runbook.
- **Files:**
  `programs/slipstream/src/state/order_book.rs`,
  `programs/slipstream/src/instructions/place_order.rs`,
  `programs/slipstream/src/instructions/mirror_fills.rs`,
  `tests/unit/src/test_fill_ring_lossless.rs` *(new)*.

### R4 — Settlement reader hardening · closes `S4-01`, `S4-06`, `S4-07`

- **Module:** the settlement reader. **Interface:** `settle_from_log` and `settle_trades`.
- **Fix:** contiguous-prefix cursor (advance only across an unbroken run from `last_settled + 1`,
  stop at the first gap); reject `count > capacity`; compare the in-loop skip test against the
  running batch maximum; re-derive the `filled_margin` bound from `compute_initial_margin` /
  `compute_notional` and reject anything above it; debit `credit_outstanding` by the applied margin
  on both legs. Delete the stale comment the code contradicts twenty lines below it (review `R-13`).
- **Migration/compat:** the live cursor sits at 44,173 with 33,146 sequences already jumped. The
  contiguity rule does not recover them — nothing can — and it will stall the cursor on the next gap
  it meets. That stall is the correct signal and must be in the runbook. Depends on R1 for the
  `credit_outstanding` field; no file overlap, so this is a blocking edge, not a conflict.
- **Files:**
  `programs/slipstream/src/instructions/settle_from_log.rs`,
  `programs/slipstream/src/instructions/settle_trades.rs`,
  `tests/unit/src/test_settlement_reader_regressions.rs` *(new)*.

### R5 — `pending_fills` symmetry and reset · closes `S4-04`

- **Module:** the pending-fills counter. **Interface:** the keeper's user-list construction, plus a
  new authority-gated `reset_pending_fills`.
- **Fix:** the bump and the decrement must count the same unit. The decrement is per (fill, side)
  and lives in files R4 owns, so the symmetry is restored on the producing side instead: the keepers
  list a user once per side they appear on rather than once per batch. `record_pending_fill` needs no
  change. Add `reset_pending_fills` so the 13 already-stuck accounts holding 438,643.10 USDC can be
  cleared.
- **Migration/compat:** none on-chain. The invariant now lives partly in an off-chain script, which
  is weaker than an on-chain rule — named as a ceiling, with the durable fix (gate withdrawal on a
  specific unsettled sequence rather than a free-running counter) recorded as follow-up.
- **Files:**
  `programs/slipstream/src/instructions/reset_pending_fills.rs` *(new)*,
  `keepers/src/fill-log-keeper.ts`,
  `keepers/src/settlement-keeper.ts`,
  `tests/unit/src/test_pending_fills_regressions.rs` *(new)*.

### R6 — Funding rate clamp · closes `S3-01`

- **Module:** the funding-rate calculation. **Interface:** `compute_funding` and the `funding` math
  module.
- **Fix:** clamp the per-interval premium to a bounded rate and cap the catch-up interval count.
  Both bounds are named constants in the math module with the reasoning in a comment. The
  instruction stays permissionless.
- **Migration/compat:** none — no state layout, no account. The live market's 16.22-day gap will
  produce a clamped catch-up instead of −908% of notional.
- **Files:**
  `programs/slipstream/src/instructions/compute_funding.rs`,
  `programs/slipstream/src/math/funding.rs`,
  `tests/unit/src/test_funding_clamp_regressions.rs` *(new)*.

### R7 — Keeper role separation · closes the code half of `S10-01`

- **Module:** `GlobalState`'s authority model. **Interface:** the three authority-gated fill-log
  instructions, plus a new `set_keeper`.
- **Fix:** a `keeper` pubkey appended past `GlobalState::LEN` using the existing lazy-resize
  pattern; `record_pending_fill`, `initialize_fill_log` and `delegate_fill_log` accept it in
  addition to `authority`.
- **Migration/compat:** the live `GlobalState` is not yet extended. The three instructions fall back
  to `authority` whenever the account is short or the field is zero, so nothing breaks before the
  operator calls `set_keeper`. The other four role separations are human key-ceremony actions and
  are **not** in this slice — see Decision 8.
- **Files:**
  `programs/slipstream/src/state/global_state.rs`,
  `programs/slipstream/src/instructions/record_pending_fill.rs`,
  `programs/slipstream/src/instructions/initialize_fill_log.rs`,
  `programs/slipstream/src/instructions/delegate_fill_log.rs`,
  `programs/slipstream/src/instructions/set_keeper.rs` *(new)*,
  `tests/unit/src/test_keeper_role_regressions.rs` *(new)*.

### Shared registration files

Three files cannot be made disjoint, because every slice that adds a module or a test must register
it. All three take **append-only, single-line** edits:

- `programs/slipstream/src/instructions/mod.rs` — R1, R5, R7 each add one `pub mod`, one `IX_*`
  constant and one dispatch arm.
- `programs/slipstream/src/error.rs` — new variants, appended, never inserted (ordinals are decoded
  off-chain).
- `tests/unit/src/lib.rs` — every slice adds one `#[cfg(test)] mod` line.

Recommended handling: the orchestrator pre-lands the module registrations, `IX_*` constants,
dispatch arms and error variants for all three new instructions at freeze, so no builder edits
these files. Failing that, they are three-way-merge-safe by construction.

## Validation strategy

**This run changes the money path of a deployed on-chain program. A document check is not
acceptance.** Every slice is graded by a Mollusk regression test that fails against the current
program and passes after the fix, in `tests/unit/src/`, alongside the existing 98. The suite is
`cargo test --workspace`; `target/deploy/slipstream.so` must be rebuilt with
`cargo build-sbf --manifest-path programs/slipstream/Cargo.toml` first, or the Mollusk tests fail
with "Program file not found". The per-manifest `cargo test` form runs only the 25 non-Mollusk tests
and is never a gate. Tests follow the existing harness shape (`SBF_OUT_DIR` set to
`target/deploy`, `Mollusk::new`, `bytemuck::Zeroable` account fixtures) — `test_record_pending_fill_regressions.rs`
is the closest model.

| Slice | Test | Attack / wrong state it reproduces | Fails today because |
|---|---|---|---|
| R1 | `test_er_inflated_credit_cannot_exceed_l1_ledger` | An ER-committed `TradingCredit` with `credit = 1_000_000_000_000` against a `UserAccount` that funded 50 USDC; `withdraw_trading_credit` for the full inflated amount | today it succeeds and moves ~1M USDC into `free_collateral`; the test asserts failure and an unmoved `free_collateral` |
| R1 | `test_honest_fund_then_withdraw_round_trips` | Fund 100, withdraw 100, ledger returns to zero — pins that the cap never blocks an honest user | today `credit_outstanding` does not exist; guards the fix against over-tightening |
| R1 | `test_seed_credit_ledger_rejects_non_authority` | A stranger calling the grandfather instruction to raise their own ceiling | today the instruction does not exist |
| R2 | `test_close_trading_credit_recovers_legacy_56_byte_account` | The live devnet 56-byte credit holding 13,163.24 USDC; close it and recover the balance | today `close_trading_credit` returns `InvalidAccountData` at the 96-byte guard and the funds stay stranded |
| R2 | `test_legacy_recovery_rejects_modern_length_account` | Using the recovery branch on a 96-byte credit to bypass R1's ceiling | today there is no branch; pins that R2 cannot become a hole in R1 |
| R3 | `test_place_order_refuses_to_overwrite_unmirrored_fill` | A book whose fill ring is full of unmirrored fills; a matching order that would evict the oldest | today `push_fill_event` overwrites, returns `Ok`, and the oldest `FillEvent` is destroyed; the test asserts `FillQueueFull` and an unchanged oldest sequence |
| R3 | `test_mirror_fills_errors_on_sequence_gap` | A committed ring whose oldest surviving sequence is `last_mirrored + 5` | today `mirror_fills` steps over the hole and advances the cursor to the batch maximum |
| R4 | `test_settle_from_log_stops_at_sequence_gap` | A FillLog holding sequences {1, 2, 5} with `last_settled = 0` | today the cursor lands on 5 and orphans 3 and 4 forever; the test asserts it lands on 2 |
| R4 | `test_settle_from_log_rejects_count_above_capacity` | A committed header with `capacity = 2`, `count = 100` — `S4-07`'s replay | today the two stored fills are applied fifty times and `Position.collateral` is minted; the test asserts rejection and unchanged collateral |
| R4 | `test_settle_rejects_filled_margin_above_leverage_bound` | A `FillEvent` with a forged `filled_margin` far above `compute_initial_margin` for its own quantity and price — `S4-06` | today the forged value is added to `Position.collateral` verbatim |
| R4 | `test_settlement_debits_credit_outstanding` | An honest fill; the ledger must fall by the margin applied | today the field is dead; pins the exactness of R1's invariant |
| R5 | `test_reset_pending_fills_requires_authority_and_unblocks_withdrawal` | The live devnet account stuck at `pending_fills = 7` with a non-zero balance: a stranger is rejected, the authority clears it, and `withdraw_collateral` then succeeds | today no instruction can lower the counter and the withdrawal is permanently refused |
| R6 | `test_compute_funding_clamps_premium_and_intervals` | The live devnet replay: 18.93% premium × 48 catch-up intervals = −908% of notional in one permissionless call | today the index moves to −9.12; the test asserts the clamped bound |
| R7 | `test_fill_log_instructions_accept_keeper_and_reject_stranger` | The fill-log keeper signing with a non-admin key | today `record_pending_fill` accepts only `global.authority`, so the keeper-signed call fails |
| R7 | `test_set_keeper_requires_authority` | A stranger installing themselves as keeper | today the instruction does not exist |

Two cross-slice checks the closing review must make, because no single slice can:

1. **No `LEN` regression.** `TradingCredit::LEN == 96`, `UserAccount::LEN == 56`,
   `Position::LEN == 96`, `OrderBookHeader::LEN` and `Market::LEN` unchanged against the freeze.
   A one-line assertion in the existing layout test is enough, and it is the check that would have
   caught `S1-01` before it shipped.
2. **R1 and R4 land together.** R1 alone leaves the ceiling loose by each user's realised losses;
   R4 alone leaves the vault open through `filled_margin`. Neither is complete without the other.

The check-runner grades the frozen checks; the closing review audits the merged whole. No new
grading machinery.

## Domain language

- **credit ledger** — `UserAccount.credit_outstanding`: L1's own record of how much of a user's
  collateral is currently parked inside trading credits. Never delegated, never written by the ER.
  Occupies the u64 previously named `reserved_margin`.
- **credit ceiling** — the payout bound `min(credit.credit, credit_outstanding)` applied by
  `withdraw_trading_credit`. The ER may lower a payout, never raise one.
- **grandfather seed** — the one-shot, authority-gated `seed_credit_ledger`, which sets the ledger
  for a credit funded before the ceiling existed.
- **contiguous-prefix cursor** — a settlement cursor that advances only across an unbroken run from
  `last_settled + 1` and stops at the first gap, replacing today's high-water mark.
- **lossless ring** — a fill-event ring that refuses at capacity instead of overwriting, paired with
  a mirror that drains what it has taken.
- **keeper role** — a `GlobalState` pubkey, distinct from `authority`, accepted by the three
  fill-log instructions so the settlement keeper's hot key is not the admin key.
- **legacy credit** — a 56-byte `TradingCredit` created before the session-keys layout. Reachable
  only through R2's length-tolerant recovery branch.

## Open human decisions

Each is a policy, economics, or ceremony call this spec must not make for the operator.

1. **`withdraw_collateral`'s gate 2 becomes live.** Renaming `reserved_margin` turns a dead check
   into "you cannot withdraw free collateral while credit is parked in a market". Options: accept
   the restriction (conservative, one line, no new code) | drop the gate so `withdraw_collateral`
   consults only `free_collateral` and `pending_fills`. **Default: accept.** It is strictly safer,
   and the user can always withdraw the credit first.
2. **Ship a permanent authority-gated `seed_credit_ledger`, or a one-release migration?** A
   permanent instruction is a standing bypass of the ceiling for whoever holds the admin key —
   which, per `S10-01`, is the concentrated hot key. **Default: ship it permanently**, because the
   holder can already replace the program, and because the alternative knowingly strands the live
   500 USDC. Revisit once the key ceremony in Decision 8 has happened.
3. **Halting matching versus destroying fills.** R3 makes `place_order` fail when the ring is full
   of unmirrored fills. That is an availability regression on keeper failure. **Default: halt.** The
   audit grades destruction P0; a halt is recoverable and a destroyed fill is not.
4. **One settlement path or two.** After R3's drain, `settle_trades` will stall rather than settle.
   Options: retire the `settle_trades` entry point | leave both instructions and stop the
   settlement-keeper service. **Default: leave the instruction, stop the service** — no program
   surface is removed under time pressure, and the operator can revert by stopping the other keeper
   instead.
5. **The funding clamp values.** `MAX_FUNDING_RATE_PER_INTERVAL` and `MAX_CATCHUP_INTERVALS` are
   economic parameters, not safety constants. **Default: ±0.5% per interval and 3 catch-up
   intervals**, which bounds a single permissionless call to ±1.5% of notional while leaving normal
   funding (documented at the 1 bps scale in the math module) far inside the clamp. The operator
   should set these against the market's real funding history.
6. **The four key-ceremony actions in `S10-01`.** Mint-authority transfer, upgrade-authority
   multisig, `GlobalState.authority` rotation, and treasury re-point. **No default and no code.**
   Only the human can perform these, and this run performs none of them.
7. **Deploy sequencing and downtime.** R3 halts matching until the currently-full live ring drains,
   and R4 will stall the settlement cursor at the first of the existing gaps. Both are correct
   behaviour and both are user-visible. **No default** — the maintenance window is the operator's
   call, and the 33,146 already-destroyed fills are not recoverable by any ordering.

## Verified facts

Every claim below was re-derived at this head, in this working tree, during this run. Nothing is
taken from the audit on trust.

| Fact | Source | Verified |
|---|---|---|
| `delegate_trading_credit` `Assign`s the whole `TradingCredit` to the delegation program, so the ER owns every byte | `delegate_trading_credit.rs:214-231`, read in full | 2026-08-22 |
| Exactly three `Assign`-to-delegation sites exist: `OrderBook`, `TradingCredit`, `FillLog`. `UserAccount` is not among them | `grep -rn "owner: &DELEGATION_PROGRAM_ID" programs/slipstream/src/` → 3 hits | 2026-08-22 |
| The two ER-native instructions never mention `UserAccount` | `grep -c UserAccount place_order.rs cancel_order.rs` → `0`, `0` | 2026-08-22 |
| `reserved_margin` has one write site and it writes zero; it is never incremented anywhere | `grep -rn reserved_margin programs/slipstream/src/` → 6 hits, one write (`initialize_user.rs:63`, `= 0`), two read guards, three comments | 2026-08-22 |
| Neither settlement entry point references `TradingCredit`, so `credit.credit` is monotone-decreasing off L1 | `grep -c TradingCredit settle_from_log.rs settle_trades.rs` → `0`, `0` | 2026-08-22 |
| `UserAccount::LEN` is 56 with only 4 alignment padding bytes; no spare u64 exists besides `reserved_margin` | `user_account.rs:8-16` | 2026-08-22 |
| `GlobalState` already has an append-past-`LEN` lazy-resize precedent (`PENDING_AUTHORITY_OFFSET = 104`, `EXTENDED_LEN = 136`, rent top-up then `resize`) | `propose_authority.rs:30-96`, `accept_authority.rs:18-45` | 2026-08-22 |
| `initialize_trading_credit` rejects any non-empty account, so a legacy credit cannot be re-initialised — `S1-01` has no escape | `initialize_trading_credit.rs:45-47` | 2026-08-22 |
| `push_fill_event` overwrites at capacity and returns `Ok`; its comment states the "keeper runs continuously" premise the audit falsifies | `order_book.rs:191-221` | 2026-08-22 |
| `settle_trades` reads the committed `OrderBook` ring read-only and shares `Market.last_settled_sequence` with `settle_from_log`; both keeper services are live | `settle_trades.rs:33-49`, `:106-131`; `keepers/src/settlement-keeper.ts`, `keepers/src/fill-log-keeper.ts` | 2026-08-22 |
| `settle_from_log` compares `count` only against `0`; there is no `count <= capacity` check | `settle_from_log.rs:103-132` | 2026-08-22 |
| `record_pending_fill` bumps each listed `UserAccount` exactly once and is already authority-gated | `record_pending_fill.rs:44-84` | 2026-08-22 |
| Error ordinals are decoded off-chain by index, so `error.rs` is append-only | `keepers/src/settlement-keeper.ts:38` | 2026-08-22 |
| `[profile.release] overflow-checks = true` is at the workspace root for a recorded reason | `Cargo.toml:8-17` | 2026-08-22 |
| Off-chain decoders read `reservedMargin` at byte offset 48 in four places and must be renamed with the field | `frontend/src/lib/slipstream/accounts.ts:178,192`, `client/src/accounts.ts:174,188`, `frontend/src/hooks/use-positions.ts:18,49`, `keepers/src/inspect-user.ts:22` | 2026-08-22 |
| Live devnet credit population: 1 modern 96-byte (500 USDC), 4 legacy 56-byte program-owned (13,313.24 USDC), 12 legacy 56-byte delegation-owned | `docs/audit/audit-e2e/s1.md` read-only `getProgramAccounts`, 2026-08-21T19:17Z | audit, not re-read (read-only RPC only; no re-read performed this run) |

## Preflight evidence

- **Repo state.** Working tree at `/home/anshtyagi/Documents/slip-grant/SlipStream`, branch
  `factory/remediate` at `20c4280`. Only `docs/spec/remediate.md` was created; no other file was
  modified.
- **Toolchain.** `cargo test --workspace` runs green at this head — exit 0, with the Mollusk
  harness reporting `98 passed; 0 failed`. `target/deploy/slipstream.so` is present, so the Mollusk
  tests resolve the program. The rebuild command
  (`cargo build-sbf --manifest-path programs/slipstream/Cargo.toml`) was **not** run this session;
  builders must run it before their tests.
- **Devnet.** No RPC call was made in this session. All live-state figures are quoted from the
  audit's own read-only reads at 2026-08-21T19:13Z–19:36Z and are attributed as such.
- **Deploy safety.** No key was read, no transaction was constructed, no `deploy.json` field was
  touched.
