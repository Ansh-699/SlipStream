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

Surviving unevidenced after the harden attack — each is stated so a reader can attack it later,
and none of them is load-bearing for a fix:

- **The MagicBlock delegation program's own behaviour.** Every proof that the ER cannot author a
  `UserAccount` byte is a proof about *this* program's ownership-write sites. It assumes the
  delegation program at `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` does not take ownership of an
  account for which this program never signed a delegate CPI. That program's source is not in this
  repository and was not read. If that assumption is false, no code change in this repository fixes
  it — the correct response would be to stop delegating, not to move the ceiling.
- **`credit.credit` is monotone-decreasing along honest ER paths.** Established by enumerating the
  six writers (one L1 `checked_add`, one L1 `saturating_sub`, two ER-reachable decrements, one
  zero-init, one `reconcile_credit` `saturating_sub`) and by both settlement entry points not
  referencing the type. Two consequences are *not* independently proven and are accepted: that the
  ER's decrement of `credit` and the `filled_margin` it stamps on a `FillEvent` are the same number,
  and that no future ER-side instruction adds an increment. The design does not depend on the first
  — the cap is `min(credit.credit, credit_outstanding)`, so a mismatch in either direction only ever
  lowers the payout.
- **R4 does not stall the live cursor immediately.** `Market.last_settled_sequence` reads 44,173 and
  the ER ring holds 40,094–44,189, so the 16 unsettled sequences 44,174–44,189 are contiguous and the
  contiguous-prefix rule should advance across them. This was computed from the ring header, not
  from the FillLog contents, which were not enumerated. If a gap exists inside that window the
  cursor stalls on the first post-upgrade settle, which is Open decision 7's territory.
- **The funding clamp values.** ±0.5 % per interval and 3 catch-up intervals are the intake ruling's
  numbers. No market-history analysis backs them; the ruling itself says so.

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

1. **The ownership-write inventory is exhaustive and does not contain it.** *(Corrected at harden.
   The earlier form of this proof enumerated the string `owner: &DELEGATION_PROGRAM_ID` and found
   three hits. That grep is **not** an enumeration of ownership transfer — it misses six further
   sites that write an account's owner slot directly, and it misses `CreateAccount`, which sets the
   owner of a brand-new account. The conclusion survives the corrected enumeration; the earlier
   proof did not establish it.)*

   Ownership of an account can change in this program by exactly four mechanisms. All four are
   enumerated below at this head, and none can name a `UserAccount`:

   | Mechanism | Sites | Targets | Why a `UserAccount` cannot be one |
   |---|---|---|---|
   | System `Assign` CPI → delegation program | 3 | `delegate_orderbook.rs:189`, `delegate_trading_credit.rs:227`, `delegate_fill_log.rs:195` | each target is PDA-checked against `SEED_ORDERBOOK` / `SEED_CREDIT` / `SEED_FILL_LOG` before any mutation, and `find_program_address` cannot return the same address for `SEED_USER` |
   | Direct owner-slot write, `unsafe { acc.assign(..) }` | 6 | `delegate_orderbook.rs:187,268`, `delegate_fill_log.rs:193,265`, `delegate_trading_credit.rs:225,309` | every one writes `pinocchio_system::ID`, never the delegation program, and every one is on an already-PDA-validated orderbook / fill-log / credit / delegate-buffer account |
   | `CreateAccount` CPI (sets a new account's owner) | 12 | all of them pass `owner: program_id` | it creates program-owned accounts; it cannot re-own an existing one |
   | CPI to the delegation program (`process_delegate`) | 3 | same three PDAs | the delegation program requires the account to already be owned by it, i.e. downstream of row 1 |

   The magic-program CPIs (`commit_orderbook`, `commit_fill_log`, `undelegate_orderbook`,
   `undelegate_trading_credit`, `emergency_undelegate`) are **not** a fifth mechanism: each pins
   `MAGIC_PROGRAM_ID` and `MAGIC_CONTEXT_ID`, PDA-checks its subject, and operates only on accounts
   the delegation program already owns.

   No `UserAccount`, `Position`, `Market`, `GlobalState` or vault appears in any row. This matches
   `PRODUCT.md` and `docs/01-architecture-overview.md`, and unlike those documents it is checkable —
   see R1's frozen check, which grades the **mechanism count**, so a fourth ownership-write site
   added later fails the check rather than silently invalidating this proof.

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

Proof (1) is the load-bearing one: it is an enumeration over every mechanism by which ownership can
change, so it holds for any future instruction unless a fifth mechanism or a fourth delegation
target is added — which is exactly what R1's frozen check grades.

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

**Confirmed on chain, not inferred.** *(Added at harden. The audit never read this field: `s4.md:278-280`
names the offsets it decoded — 0, 2 and 40 — and 48 is not among them, so the migration table's
"all with `reserved_margin == 0`" row was an inference from the source, not a measurement.)* A
read-only `getProgramAccounts` against `7qujfsb4ZPbQHYVZdqiXq1r8tVAMyyukX94obPqXbVwz` on
2026-08-22, filtered `dataSize == 56` and `memcmp offset 0 == DISC_USER_ACCOUNT`, returned **45
accounts, of which 45 read `reserved_margin == 0` at offset 48** (aggregate `free_collateral`
511,046.726977 USDC). Repurposing the field corrupts nothing that exists.

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

*(Re-read read-only at harden, 2026-08-22. The row counts below replace the earlier table, which
omitted the largest population entirely and understated the delegated legacy value by 2.8×.)*

| Population | Count | Value | Handled by |
|---|---|---|---|
| Modern 96-byte, program-owned (undelegated) | 1 | 500.00 USDC | R1's `seed_credit_ledger` |
| **Modern 96-byte, delegation-program-owned** | **45** | see below | **R1's `seed_credit_ledger`, after the owner undelegates** |
| Legacy 56-byte, program-owned (undelegated) | 4 | 13,313.24 USDC | R2's length-tolerant recovery |
| Legacy 56-byte, delegation-program-owned | 12 | **36,470.00 USDC** | **Nothing. Still stranded.** |
| `UserAccount`s (45 of 45 read `reserved_margin == 0` on chain) | 45 | 511,046.73 USDC free | Nothing needed |

**The 45 delegated modern credits are the whole live user base, and the earlier table did not list
them.** They matter twice. First, every one of them reads `credit_outstanding == 0` on its
`UserAccount`, so the moment the cap goes live their payout bound is zero until the operator seeds
each one — the grandfather instruction covers **up to 46 accounts, not 1**. Second, their `credit`
field is direct evidence that `S5-01` is not hypothetical: reading all 45 from both L1 and
`https://devnet.magicblock.app`, **22 of 45 hold a `credit` above 10^12 raw**, twenty-two of them the
identical value `7_017_392_213_830_636_841` (7,017,392,213,830.64 USDC) against a vault holding
roughly 511 thousand. The remaining 23 sum to 34,457.63 USDC. Those 22 are not currently extractable
— `reconcile_credit`'s `saturating_sub` zeroes them on undelegate because their `committed`
(11,016,084,772,046,666,000) exceeds their `credit` — but the field is demonstrably ER-authored
garbage today, which is the precondition the anchor slice exists to remove.

The twelve delegated legacy credits are unreachable from L1 by any instruction, because the program
owns none of their bytes and has no L1 undelegation path. That is `S5-02` (P1), out of scope, and
this run does not recover them. Saying so plainly is part of the deliverable.

**`seed_credit_ledger`** is the grandfather instruction: authority-signed, requires the credit to be
program-owned (undelegated), and sets `credit_outstanding` for a credit funded before the ceiling
existed. *(Revised at harden.)* It does **not** copy `credit.credit` verbatim. It takes the amount
as instruction data and writes `min(credit.credit, amount)`, so the ER-authored value can only ever
*lower* the seed, never raise it, and the operator must state the number it believes. Without that
bound the instruction is a direct write of an ER-authored u64 into the one field the whole ceiling
rests on, on 46 accounts, 22 of which currently carry impossible values. Requiring the authority to
name the amount costs one `u64` in the instruction data and removes the re-trust entirely.

It is **not** one-shot. The earlier `credit_outstanding == 0` precondition made it one, and that is
the wrong shape: see Decision 4b, where the ledger provably goes stale on live accounts and the
operator needs a repair path. The instruction therefore sets the ledger unconditionally. That is a
standing authority-gated write to the ledger, which is exactly the residual risk intake ruling 2
already recorded and accepted.

### Decision 4b — the ledger goes stale, and a stale ledger is a permanent lock

*(New at harden. This is the largest consequence the earlier draft did not carry, and it changes
what R1 must ship rather than only what the runbook must say.)*

Renaming `reserved_margin` makes two previously-dead guards live. The `close_user_account` one is
desirable. The `withdraw_collateral` one — gate 2, `withdraw_collateral.rs:82` — is stronger than
"you cannot withdraw free collateral while credit is parked in a market", because **there are two
ways `credit_outstanding` stays non-zero after the user has no credit left to withdraw**:

1. **A destroyed fill.** The ER drains `credit.credit` when a fill matches; L1 lowers
   `credit_outstanding` only when that fill *settles*. `S2-01` destroys fills and `S4-01` skips
   them — 33,146 sequences have already settled zero times, and nothing recovers them. For every
   affected user, `credit.credit` is gone but `credit_outstanding` is not, so `withdraw_trading_credit`
   has nothing to pay and gate 2 refuses `withdraw_collateral` **forever**.
2. **`close_trading_credit`.** It zeroes the account and refunds only rent; it never returns
   `credit` to `free_collateral` and never touches the `UserAccount` at all
   (`close_trading_credit.rs:63-73`). Its own doc comment claims the balance "is independently
   recoverable via the UserAccount accounting" (`:27-29`); no such accounting exists. Today that
   silently destroys the balance. After R1 it *also* leaves the ledger stale, and gate 2 locks the
   owner's entire `free_collateral`.

The population at risk is not hypothetical: 45 live `UserAccount`s hold **511,046.73 USDC** of
`free_collateral` behind that gate. Intake ruling 1 accepted gate 2 going live on the stated
premise that "a user can withdraw credit first". **That premise is false in both cases above**, so
this spec does not treat the ruling as covering them; it ships the repair the ruling's premise
assumed was unnecessary. Two changes, both small:

- `seed_credit_ledger` is a **set**, not a one-shot seed (above), so the operator can repair a
  stale ledger with the same instruction. No new instruction, no new error variant.
- R2 makes `close_trading_credit` **refuse** a credit that still holds `credit > 0`, forcing the
  owner through `withdraw_trading_credit`. That is a one-line guard in a file R2 already owns, it
  closes today's silent fund destruction, and it stops the lock at its source.

Anything beyond those two — automatic reconciliation, a per-user claim path — is out of scope.

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
`mirror_fills` advances `fill_event_head` and lowers `fill_event_count`. It can — both the
`OrderBook` and the `FillLog` are delegated, so `mirror_fills` executes inside the ER where the book
is writable. After the drain, "ring full" means "full of fills the mirror has not taken", which is
exactly the condition under which halting matching is correct.

**Three corrections at harden, each of which independently wedges the market if missed.**

1. **The drain is over already-mirrored entries, not over this call's appends.** The earlier
   wording — "drains the prefix it successfully mirrored" — implemented literally is a permanent
   deadlock, and the live state triggers it on the first call. The ER ring is full
   (`fill_event_count == max_fill_events == 4096`) of fills that are *already* mirrored, so a mirror
   call appends nothing, and `mirror_fills.rs:144-150` returns `FillQueueEmpty` **before** any drain
   could run. Nothing drains, the ring stays full, `place_order` stays halted. Verified against the
   unmodified program: the regression test for this case fails today with
   `Failure(Custom(285))` — `FillQueueEmpty`, error ordinal 29. The drain must therefore be defined
   as *advance `fill_event_head` and lower `fill_event_count` past every ring entry whose
   `sequence <= last_mirrored_sequence`*, and must run whether or not this call appended anything.
2. **The gap check must exempt a virgin log.** `last_mirrored_sequence` is per-FillLog and starts at
   zero, and the keeper rotates epochs routinely — `fill-log-keeper.ts:171-175` says so outright:
   *"a fresh epoch's FillLog re-mirrors the ring from sequence 0"*. On any fresh epoch the live
   ring's oldest surviving sequence (40,094) is far beyond `last_mirrored + 1` (1), so an
   unconditional gap check errors on **every rotation, forever**. The check applies only when the
   log already carries a cursor: skip it when `header.count == 0 && header.last_mirrored_sequence == 0`.
3. **`mirror_fills` needs the OrderBook passed writable.** It is read-only today
   (`mirror_fills.rs:72` borrows immutably; `client/src/instructions.ts:1262` passes
   `isWritable: false`). The drain cannot land without changing that account meta, so
   `client/src/instructions.ts` is part of R3's file set, not R5's.

The instruction stays permissionless. Draining is not a new capability: the drain is bounded by the
log's own `last_mirrored_sequence`, so a caller can only discard ring entries the FillLog already
holds, and the drain is ER-local state that is never committed to L1.

**No `OrderBookHeader` field is added.** The header sits before four variable-length arrays whose
offsets are computed from `OrderBookHeader::LEN`; growing it would misread the live 612 KB book,
which holds real resting orders. This rules out the `dropped_fill_count` /
`oldest_surviving_sequence` pair `S2-01` suggests. The oldest surviving sequence is derivable
without new state as `next_fill_sequence − fill_event_count`.

Consequence for `settle_trades`: it reads the same ring on L1 and shares
`Market.last_settled_sequence` with `settle_from_log`. *(Corrected at harden: it does **not** see
the drain. The OrderBook is delegated and, by design, never committed back — the L1 copy of
`83zMFL6cHjgXkQ7KRNcgtHaZ1fhyNgxhM8aMpPpEnMqe` still reads `head=0 tail=9 count=9
next_fill_sequence=10`, a pre-delegation snapshot, while the ER copy reads
`head=tail=3229 count=4096 next_fill_sequence=44190`. `settle_trades` is already effectively dead
against a delegated book.)* It nonetheless shares the cursor, so running both settlement paths
double-applies fees, positions and — after R1 — the `credit_outstanding` debit. The operator must
run exactly one. Carried to `## Open human decisions`.

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
- **Bound `fill.sequence` by the cursor's range.** *(Added at harden — without it the contiguity
  rule is trivially defeated and R4 closes nothing.)* `FillEvent.sequence` is a `u64` but the cursor
  is a `u32` overlaid on `Market::_padding2[0..4]`, and `set_last_settled_sequence` writes
  `(seq as u32)` (`market.rs:207-214`). A fill whose sequence is `2^32 + k` therefore moves the
  cursor **backwards** to `k`, re-opening every fill above `k` for replay. Verified against the
  unmodified program: a fill with `sequence = 4_294_967_307` against `last_settled = 10` is accepted
  and lands the cursor on 11. Reject any fill with `sequence > u32::MAX`.

Plus the ledger debit from Decision 3, which is two lines in a block that already holds the
`UserAccount` mutably.

**What the contiguity rule must leave alone.** `settle_from_log` already `break`s without advancing
the cursor when a fill's maker/taker accounts are absent (`settle_from_log.rs:164-187`) — that is a
deliberate fix, not the stale high-water behaviour, and the spec's earlier "advance past the orphan"
description is out of date. The contiguous-prefix rule composes with it: both stop at the first fill
they cannot apply, and both require an operator to supply accounts or rotate the epoch. Do not
"simplify" the orphan `break` into a skip while implementing the cursor.

### Decision 7 — funding is clamped at the source, not gated at the caller

`S3-01` multiplies an unclamped premium by an unclamped interval count. The root cause is the
absence of both bounds, not the absence of a signer: with a per-interval rate clamp and a catch-up
interval cap, a permissionless `compute_funding` is harmless, and the instruction stays
permissionless as designed. `crank_twap`'s missing signer is `S5-03` (P1) and is not in scope.

The clamp *values* are economic policy and are carried to `## Open human decisions`.

**One thing the cap does not bound, stated so the operator is not surprised.** *(Added at harden.)*
`compute_funding.rs:45` advances `last_funding_ts` by `intervals * interval_secs`, not to `now`, on
purpose: "any partial remainder stays owed". Capping `intervals` therefore **defers** the
uncounted intervals rather than forgiving them — the live market's 48-interval backlog would be
paid down over 16 successive permissionless calls at the clamped rate, so the ±1.5 %-per-call bound
composes to roughly ±24 % of notional over the backlog. The per-call bound is the safety property
and it holds; the aggregate is not bounded by this fix. Whether the excess is deferred or forgiven
(`last_funding_ts = now` when `intervals > MAX_CATCHUP_INTERVALS`) is a policy choice and is carried
to `## Open human decisions`. Neither choice changes settlement math for existing positions: the
clamp only bounds future increments of `cumulative_funding_index`, and every position settles
against the index delta since its own snapshot, so no already-accrued value is rewritten.

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
  Decision 3; raise it on fund, cap and lower it on withdraw; add the authority-gated
  `seed_credit_ledger(amount)`, which writes `min(credit.credit, amount)` and is a set, not a
  one-shot (Decision 4b).
- **Migration/compat:** no `LEN` change, no realloc. All 45 live `UserAccount`s read zero on chain
  (verified read-only 2026-08-22), which is correct for every account except the **46** pre-upgrade
  funded credits — 1 undelegated plus 45 delegated — each of which needs one `seed_credit_ledger`
  call after its owner undelegates. `withdraw_collateral`'s previously-dead gate becomes live; see
  Decision 4b for the stale-ledger lock it creates and the repair R1 must ship with it.
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
  ER-owned `_padding` so a future `LEN` change cannot strand accounts again. **Also refuse to close a
  modern 96-byte credit that still holds `credit > 0`** (Decision 4b): today that silently destroys
  the balance, and after R1 it also strands `credit_outstanding` and locks the owner's
  `free_collateral` behind gate 2.
- **Migration/compat:** the recovery branch accepts **only** `data.len() == LEGACY_LEN` (56). Modern
  96-byte credits keep going through `withdraw_trading_credit` and R1's cap, so this path is not a
  ceiling bypass. This is the constraint that keeps R1 and R2 independent. The added refusal is a
  behaviour change for one live account (the single undelegated 96-byte credit holding 500.00 USDC),
  whose owner must call `withdraw_trading_credit` before closing.
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
  `last_mirrored_sequence + 1` — **except on a virgin log** (`count == 0 && last_mirrored_sequence == 0`),
  which the keeper produces on every epoch rotation — and errors naming the gap otherwise. It then
  **drains every ring entry whose `sequence <= last_mirrored_sequence`, whether or not this call
  appended anything**, so the ring cannot wall up. Both exceptions are load-bearing; see Decision 5.
- **Migration/compat:** no `OrderBookHeader` field is added, so the live 612 KB book decodes
  unchanged. The live ER ring is *currently* full and wrapped (`head == tail == 3229`,
  `count == 4096`, `next_fill_sequence == 44190`, oldest surviving 40094; re-read read-only
  2026-08-22), so on the first post-upgrade run matching halts until the mirror drains it. That is
  intended and must be in the deploy runbook. Passing the OrderBook **writable** to `mirror_fills` is
  a client change; the account meta and the program's mutable borrow must land together or the drain
  silently does nothing.
- **Files:**
  `programs/slipstream/src/state/order_book.rs`,
  `programs/slipstream/src/instructions/place_order.rs`,
  `programs/slipstream/src/instructions/mirror_fills.rs`,
  `client/src/instructions.ts`,
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

**The orchestrator pre-lands all of it at freeze.** *(Specified exactly at harden, because "append
only" is not an instruction a builder can follow deterministically and three-way merge on a `match`
arm is not safe by construction.)* No builder edits these three files; each issue's MUST-NOT-TOUCH
names them. The exact pre-land, in this order:

`programs/slipstream/src/instructions/mod.rs` — three `pub mod` lines appended after
`pub mod accept_authority;` (line 40):

    pub mod seed_credit_ledger;
    pub mod reset_pending_fills;
    pub mod set_keeper;

three `IX_*` constants appended after `IX_ACCEPT_AUTHORITY` (line 101). `0x27` is the highest
discriminator in use, so the next three are free:

    // Round 9 — remediate: credit ledger repair, pending-fills reset, keeper role.
    pub const IX_SEED_CREDIT_LEDGER: u8 = 0x28;
    pub const IX_RESET_PENDING_FILLS: u8 = 0x29;
    pub const IX_SET_KEEPER: u8 = 0x2A;

and three dispatch arms appended immediately before the `_ =>` fallback (line 165):

    IX_SEED_CREDIT_LEDGER => seed_credit_ledger::process(program_id, accounts, data),
    IX_RESET_PENDING_FILLS => reset_pending_fills::process(program_id, accounts, data),
    IX_SET_KEEPER => set_keeper::process(program_id, accounts, data),

`programs/slipstream/src/error.rs` — appended after `PositionStillOpen,` (line 65), inside the enum,
**never inserted**. `InvalidDiscriminator = 0x100` is at line 5, so `PositionStillOpen` is ordinal 60
(`0x13C`) and the new variants take 61, 62, 63 (`0x13D`, `0x13E`, `0x13F`). Inserting anywhere above
would re-label every keeper error code — `settlement-keeper.ts:38` decodes `FillQueueEmpty` as
"error.rs index 29", which is `0x11D`:

    // Round 9 — remediate. APPEND ONLY: keepers decode by ordinal.
    CreditCeilingExceeded,
    FillSequenceOutOfRange,
    LegacyLayoutRejected,

`tests/unit/src/lib.rs` — seven `#[cfg(test)] mod` lines appended at end of file, one per slice's new
test module, so a builder's new test file is registered before it exists:

    #[cfg(test)]
    mod test_credit_ceiling_regressions;
    #[cfg(test)]
    mod test_legacy_credit_recovery;
    #[cfg(test)]
    mod test_fill_ring_lossless;
    #[cfg(test)]
    mod test_settlement_reader_regressions;
    #[cfg(test)]
    mod test_pending_fills_regressions;
    #[cfg(test)]
    mod test_funding_clamp_regressions;
    #[cfg(test)]
    mod test_keeper_role_regressions;

Because `mod` declarations are pre-landed, the freeze commit must also land a file for each of the
seven test modules or the tree does not compile at freeze. **Land the drafted regression tests as
those files, not empty placeholders.** Six of the seven are written and were run against the
unmodified program at harden; all 16 of their fix-assertions fail today with the exact evidence
recorded in each frozen check. They live at `docs/runs/remediate/draft-tests/`, which is under the
gitignored `docs/runs/` tree — so a builder's worktree will **not** contain them unless the freeze
commit copies them into `tests/unit/src/`. Doing so hands each builder a red test to turn green,
which is the shape the validation strategy already asks for, and it removes the handoff entirely.

Two caveats for the copy:

- The drafts are written against the **post-fix** field name `credit_outstanding`, so
  `tests/unit/src/test_credit_ceiling_regressions.rs` and
  `tests/unit/src/test_settlement_reader_regressions.rs` do not compile until R1's rename lands. If
  the freeze must compile, land those two with `credit_outstanding` renamed back
  (`sed 's/credit_outstanding/reserved_margin/g'`) and let R1 and R4 rename them forward; that is
  exactly how the before-state evidence was captured.
- `test_funding_clamp_regressions.rs` does not compile until R6 exports its two constants — its
  before-state failure *is* `E0432`. Land it commented out, or accept a red freeze for that one file
  and record it as a ruling.

## Validation strategy

**This run changes the money path of a deployed on-chain program. A document check is not
acceptance.** Every slice is graded by a Mollusk regression test that fails against the current
program and passes after the fix, in `tests/unit/src/`, alongside the existing 98 in that crate.
The suite is `cargo test --workspace`, which is **123 tests**: 25 in `programs/slipstream` plus 98
in `tests/unit`. `target/deploy/slipstream.so` must be rebuilt with
`cargo build-sbf --manifest-path programs/slipstream/Cargo.toml` first, or 38 of the 98 fail with
"Program file not found" — `*.so` is gitignored (`.gitignore:11`), so a fresh checkout has none and
**every frozen check must carry the build step**. Verified at harden: without the build the suite
reports `60 passed; 38 failed`; with it, `25 passed` and `98 passed`. The per-manifest `cargo test`
form runs only the 25 non-Mollusk tests and is never a gate.

**Clippy is not clean at this head, and a naive check would fail every builder.**
`cargo clippy -p slipstream -- -D warnings` exits **101** today on four pre-existing errors: three
`unexpected_cfgs` for `cfg(target_os = "solana")` at `lib.rs:11` and one `too_many_arguments` at
`order_slot.rs:53`. None is in scope. The gate form that is clean today, and that still fails on
anything new, is
`cargo clippy -p slipstream -- -D warnings -A unexpected_cfgs -A clippy::too_many_arguments`
(verified exit 0). Tests follow the existing harness shape (`SBF_OUT_DIR` set to
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
| R3 | `test_mirror_fills_drains_already_mirrored_prefix_with_zero_appends` | A full ring whose every entry is already mirrored — the live state, and the case that wedges the market | today the call returns `FillQueueEmpty` before any drain, so the ring never clears and R3's halt is permanent |
| R4 | `test_settle_from_log_stops_at_sequence_gap` | A FillLog holding sequences {1, 2, 5} with `last_settled = 0` | today the cursor lands on 5 and orphans 3 and 4 forever; the test asserts it lands on 2 |
| R4 | `test_settle_from_log_rejects_count_above_capacity` | A committed header with `capacity = 2`, `count = 100` — `S4-07`'s replay | today the two stored fills are applied fifty times and `Position.collateral` is minted; the test asserts rejection and unchanged collateral |
| R4 | `test_settle_rejects_filled_margin_above_leverage_bound` | A `FillEvent` with a forged `filled_margin` far above `compute_initial_margin` for its own quantity and price — `S4-06` | today the forged value is added to `Position.collateral` verbatim |
| R4 | `test_settlement_debits_credit_outstanding` | An honest fill; the ledger must fall by the margin applied | today the field is dead; pins the exactness of R1's invariant |
| R4 | `test_settle_rejects_sequence_above_cursor_range` | A fill with `sequence = 2^32 + 11` against `last_settled = 10` | today it is accepted and the u32 cursor truncates to 11, moving backwards and defeating the contiguity rule outright |
| R5 | `test_reset_pending_fills_requires_authority_and_unblocks_withdrawal` | The live devnet account stuck at `pending_fills = 7` with a non-zero balance: a stranger is rejected, the authority clears it, and `withdraw_collateral` then succeeds | today no instruction can lower the counter and the withdrawal is permanently refused |
| R6 | `test_compute_funding_clamps_premium_and_intervals` | The live devnet replay: 18.93% premium × 48 catch-up intervals = −908% of notional in one permissionless call | today the index moves to −9.12; the test asserts the clamped bound |
| R7 | `test_fill_log_instructions_accept_keeper_and_reject_stranger` | The fill-log keeper signing with a non-admin key | today `record_pending_fill` accepts only `global.authority`, so the keeper-signed call fails |
| R7 | `test_set_keeper_requires_authority` | A stranger installing themselves as keeper | today the instruction does not exist |
| R7 | `test_fill_log_instructions_fall_back_to_authority_when_unextended` | The live, not-yet-extended `GlobalState` | **guard, not a fix test — passes before and after.** It pins that the fallback keeps the live deployment working before `set_keeper` is ever called |

Two cross-slice checks the closing review must make, because no single slice can:

1. **No `LEN` regression.** `TradingCredit::LEN == 96`, `UserAccount::LEN == 56`,
   `Position::LEN == 96`, `OrderBookHeader::LEN` and `Market::LEN` unchanged against the freeze.
   *(Corrected at harden.)* Those assertions **already exist** — `test_state.rs:177,182,316,411` and
   `:36-37` — and they did **not** catch `S1-01`, because `S1-01` is not a silent layout drift: the
   `LEN` change from 56 to 96 was deliberate, and whoever made it simply updated the assertion
   alongside. A `LEN` assertion cannot catch that class. What would have caught it is a **reachability**
   check — that no live account length is refused by a load site — which is precisely what R2's
   `test_close_trading_credit_recovers_legacy_56_byte_account` asserts. Both are graded: the `LEN`
   assertions as a cheap guard, the reachability test as the real one. Do not describe the `LEN`
   assertion as the `S1-01` check.
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

1. **`withdraw_collateral`'s gate 2 becomes live — and the "withdraw credit first" escape does not
   always exist.** *(Reopened at harden, on evidence, not on preference.)* Intake ruling 1 accepted
   the restriction on the stated premise that "a user can withdraw credit first". Decision 4b shows
   two live cases where they cannot: a destroyed fill (33,146 sequences already, unrecoverable) and
   `close_trading_credit`, which zeroes the balance without touching the ledger. In both, gate 2
   locks the owner's `free_collateral` permanently. 511,046.73 USDC sits behind that gate across 45
   accounts. The ruling stands; what needs a decision is the repair. Options: **ship the two repairs
   in Decision 4b** (`seed_credit_ledger` as a set, `close_trading_credit` refusing a non-empty
   credit) | drop gate 2 entirely so `withdraw_collateral` consults only `free_collateral` and
   `pending_fills`. **Default: ship the two repairs.** They are a `u64` of instruction data and a
   one-line guard, both inside files the slices already own, and they keep the safer gate.
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
8. **Deferred or forgiven funding backlog.** With `MAX_CATCHUP_INTERVALS` capping `intervals`,
   `compute_funding` still advances `last_funding_ts` by only the capped intervals, so the live
   market's 48-interval backlog is paid down over ~16 further permissionless calls — roughly ±24 %
   of notional in aggregate. Options: leave it deferred (each call bounded, aggregate unbounded) |
   set `last_funding_ts = now` whenever `intervals > MAX_CATCHUP_INTERVALS`, forgiving the excess.
   **Default: forgive.** A 16-day gap is an operator outage, not a market signal, and a catch-up cap
   whose remainder is simply deferred does not cap anything.
9. **`seed_credit_ledger` becomes a repeatable set rather than a one-shot seed.** Decision 4b needs
   a repair path for a ledger that goes stale, and the cheapest one is to drop the
   `credit_outstanding == 0` precondition. That makes the instruction a standing authority-gated
   write to the ledger — the residual risk intake ruling 2 already recorded, but now permanent and
   repeatable rather than one-shot per account. Options: repeatable set | one-shot seed plus a
   separate repair instruction. **Default: repeatable set.** It is the same key, the same
   capability, and one fewer instruction; the `min(credit.credit, amount)` bound is what makes it
   safe, not the one-shot precondition.

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
| Live devnet credit population, **re-read at harden**: 1 modern 96-byte program-owned (500.00 USDC), **45 modern 96-byte delegation-owned**, 4 legacy 56-byte program-owned (13,313.24 USDC), 12 legacy 56-byte delegation-owned (**36,470.00 USDC**, not the ≈13,000 previously quoted) | read-only `getProgramAccounts` on `api.devnet.solana.com` | 2026-08-22 |
| 45 of 45 live `UserAccount`s read `reserved_margin == 0` at offset 48; aggregate `free_collateral` 511,046.726977 USDC. The audit never read this field (`s4.md:278-280` lists offsets 0, 2, 40 only) | read-only `getProgramAccounts`, `dataSize 56` + `memcmp offset 0 == 3`, `dataSlice {40,16}` | 2026-08-22 |
| 22 of the 45 delegated modern credits hold `credit >= 10^12` raw, 22 of them the identical `7_017_392_213_830_636_841`; the other 23 sum to 34,457.63 USDC. Same values on L1 and on `devnet.magicblock.app` | read-only `getAccountInfo` per key, both endpoints | 2026-08-22 |
| Ownership can change by four mechanisms, not one: 3 `Assign` CPIs, **6 direct `unsafe { acc.assign(..) }` owner writes**, 12 `CreateAccount` CPIs (all `owner: program_id`), 3 delegation-program CPIs. All PDA-validated; none can name a `UserAccount` | `grep -rn "assign\|CreateAccount\|DELEGATION_PROGRAM_ID" programs/slipstream/src/`, each site read | 2026-08-22 |
| L1's copy of the OrderBook is a pre-delegation snapshot (`head=0 tail=9 count=9 next_fill_sequence=10`) while the ER copy reads `head=tail=3229 count=4096 next_fill_sequence=44190`; `Market.last_settled_sequence = 44173` | read-only `getAccountInfo` on both endpoints; `Market::_padding2[0..4]` | 2026-08-22 |
| `mirror_fills` borrows the OrderBook **immutably** and `createMirrorFillsInstruction` passes it `isWritable: false`, so R3's drain needs a client change | `mirror_fills.rs:72`, `client/src/instructions.ts:1262` | 2026-08-22 |
| A fresh epoch's FillLog re-mirrors from sequence 0, so `last_mirrored_sequence` resets on every rotation | `keepers/src/fill-log-keeper.ts:171-175` | 2026-08-22 |
| `Market.last_settled_sequence` is a **u32** and `set_last_settled_sequence` writes `(seq as u32)`, so a `u64` fill sequence above `u32::MAX` moves the cursor backwards | `market.rs:198-214`; reproduced against the unmodified program | 2026-08-22 |
| `close_trading_credit` never touches the `UserAccount` and never returns `credit` to `free_collateral`; its doc comment claiming the balance is "independently recoverable via the UserAccount accounting" is false | `close_trading_credit.rs:27-29`, `:63-73` | 2026-08-22 |
| `cargo clippy -p slipstream -- -D warnings` exits **101** at this head on 4 pre-existing errors (`lib.rs:11` ×3 `unexpected_cfgs`, `order_slot.rs:53` `too_many_arguments`) | run at harden | 2026-08-22 |
| `cargo test --workspace` is 123 tests (25 + 98) and needs `cargo build-sbf` first; without it, 38 fail | run at harden, both ways | 2026-08-22 |

## Preflight evidence

- **Repo state.** Working tree at `/home/anshtyagi/Documents/slip-grant/SlipStream`, branch
  `factory/remediate` at `20c4280`. Only `docs/spec/remediate.md` was created; no other file was
  modified.
- **Toolchain.** *(Re-verified at harden.)* `target/deploy/slipstream.so` was **absent** at this
  head — `*.so` is gitignored — and `cargo test --workspace` reported `60 passed; 38 failed`. After
  `cargo build-sbf --manifest-path programs/slipstream/Cargo.toml` (exit 0) the suite is green:
  `25 passed` in `programs/slipstream` and `98 passed` in `tests/unit`, 123 total. Every frozen
  check carries the build step for that reason.
- **Devnet.** *(Superseded at harden.)* Read-only RPC reads **were** performed this session against
  `https://api.devnet.solana.com` and `https://devnet.magicblock.app`: `getProgramAccounts` and
  `getAccountInfo` only. No transaction was constructed, no keypair was read, no write of any kind
  was issued. The rows they produced are marked `2026-08-22` in `## Verified facts`; everything else
  remains attributed to the audit's reads at 2026-08-21T19:13Z–19:36Z.
- **Deploy safety.** No key was read, no transaction was constructed, no `deploy.json` field was
  touched.
