# Review spec: `audit-e2e` closing review

- **Run:** `audit-e2e` — run shape **A (audit-only)**, verified: `git diff 698dd4f..9316020`
  touches `.gitignore` and `docs/{spec,checks,audit}/` and nothing else.
- **Reviewed at:** `9316020`. Freeze `b98f0508b01af619f84a6cbb82b6326ebbcd7f9f`;
  `git diff b98f050..9316020 -- docs/checks/` is empty, so freeze integrity holds
  independently of the check-runner's self-report.
- **Deliverable under review:** `docs/audit/audit-e2e/s1.md .. s13.md` (117 own findings,
  44 routed cross-slice notes; 10 P0 / 39 P1 / 70 P2 / 42 P3).
- **This file is a run artifact.** It is not the run's hardened spec and it authorises no
  edit to product code, to the mutable test suite, or to `docs/checks/`.

## What held up

Independently re-verified, no change required:

- **Evidence integrity.** All 753 `path:line` evidence citations across the thirteen
  findings files resolve to a real file at a line that exists. The six that do not resolve
  in a clean worktree (`DESIGN.md`, `frontend/src/lib/deploy-manifest.generated.json`,
  `frontend/src/content/docs/06-session-keys.md`) are the three untracked/generated
  artifacts the spec's **R3** puts in scope on purpose, and all three resolve in the
  working tree.
- **Class coverage.** All 128 class ids in `docs/checks/audit-e2e/classes.tsv` appear in
  their own slice's `## Cleared` section. No class was dropped.
- **Tag discipline.** Every P0/P1 carries exactly one `[reachable-now]`/`[mainnet-only]`
  tag and no P2/P3 carries one, across all 161 records.
- **Proof discipline.** 155 of 157 CONFIRMED records carry a pasted command output, repro
  artifact, live account read, or layout table. The two that do not (`S2-X01`, `S3-X02`)
  point at another record's proof, which is legitimate.
- **Partition.** All 61 tracked files under `programs/` are named in the spec; the stable
  count command returns 251 at the reviewed head, as the spec claims.
- **`s4.md` and `s6.md` `## Cleared` sections were spot-checked hard and hold.** The shared
  settlement cursor, the byte-identical fee/rebate/insurance scaling across both entry
  points, the FillLog PDA/capacity/length bounds and modulo-reduced ring indices, the
  `max_leverage`-has-no-setter claim, the `place_order`/`execute_trigger` builder parity,
  `FILL_LOG_HEADER_SIZE = 24`, `computeOrderBookAccountSize = 626_736`, and the
  `_padding2`/`lastSettledSequence` overlay all re-verified correct. Both slices state
  their blind spots accurately.
- **No slice padded.** All six slices under the minimum-one-finding rule produced a
  substantive finding in the class they were obligated on, and none used the P3
  "the established state does not reach my file set" escape hatch the spec permits.
- **Six P0s upheld unchanged:** `S1-01`, `S2-01`, `S4-01`, `S4-04`, `S4-06`, `S5-01`. Each
  was re-derived from source in this review, and none is mitigated by anything the
  auditor missed. In particular `S1-01` has no escape: `initialize_trading_credit.rs:45-47`
  rejects the 56-byte account with `AccountAlreadyInitialized`, and no `resize` call in the
  program targets a `TradingCredit`.

## Requirements

One requirement per verified finding. Each carries its severity and its file:line
verification.

### R-01 (P1) — `S3-01`'s proof monetises an exploit path that cannot execute

`docs/audit/audit-e2e/s3.md` `S3-01` is a genuine P0 and its mechanism is confirmed:
`compute_funding` has no signer check (`programs/slipstream/src/instructions/compute_funding.rs:19-25`),
no clamp on the premium (`programs/slipstream/src/math/funding.rs:22-26`) and no cap on
`intervals` (`programs/slipstream/src/instructions/compute_funding.rs:41`). The record's
`**Proof.**` block is what fails. It converts the poisoned index into money through
`claim_funding`, citing `claim_funding.rs:66-104`, and prices the payment at the live
oracle, `$91.317865` (`docs/audit/audit-e2e/repro/s3/live_positions.py:22`,
`docs/audit/audit-e2e/repro/s3/funding_catchup.py`). Two errors:

1. `claim_funding` does not use the oracle price. It uses
   `market.mark_price_for_close(now_ts)` (`programs/slipstream/src/instructions/claim_funding.rs:61-63`),
   which returns `last_mark_price` — `$74.11`, frozen — not the oracle reading.
2. On the reviewed deployment `mark_price_for_close` returns `None`
   (`programs/slipstream/src/state/market.rs:173-182`, mark 16 days old against
   `MARK_PRICE_MAX_STALENESS_MINS = 30` at `programs/slipstream/src/state/market.rs:16`),
   so `claim_funding` errors `OracleStale` and pays nothing. **S3's own `S3-03` states this
   at the same evidence line** ("Every path by which the *owner* can act on the same
   position — `close_position`, `claim_funding`, `execute_trigger`'s stop-loss — is gated
   on `mark_price_for_close`, which is `None` whenever the crank is dead"). The two records
   in one slice file contradict each other.

The headline figures `$72,322.04` credited and `$42,616.68` "net new withdrawable claim
minted on the vault" are therefore not reproducible as written.

The finding survives, and the `[reachable-now]` tag survives, through a path S3 analysed
but never connected: `liquidate_position` is permissionless, prices off the live oracle,
realises funding into `Position.collateral` and `UserAccount.free_collateral`
(`programs/slipstream/src/instructions/liquidate_position.rs:138-142`, `:203-206`,
`:220-227`), and has no `mark_price_for_close` dependency at all. A poisoned index makes
every short liquidatable at a `total_settlement` that goes negative and drains
`insurance_fund_balance` to zero as bad debt
(`programs/slipstream/src/instructions/liquidate_position.rs:227-237`), while the long
side's minted claim latches until the crank resumes.

**Required:** rewrite `S3-01`'s `**Proof.**` and `**Blast radius.**` to monetise through
`liquidate_position`, restate any `claim_funding`-denominated figure at `last_mark_price`
and mark it as latched-until-crank, and correct the two repro scripts so their pasted
output matches what the cited instruction actually computes. Severity P0 and the
`[reachable-now]` tag stay.

### R-02 (P1) — `S1`'s `## Cleared` clears the product's central safety claim by an argument delegation invalidates

`docs/audit/audit-e2e/s1.md` `## Cleared` bullet **S1-C8** reads: "the cap is enforced and
cannot be raised without the owner's signature. `TradingCredit.credit` has exactly three
writers in the program … `README.md:44-50`'s 'capped, not unlimited' claim holds on the L1
side." The enumeration is over program source only. `TradingCredit` is delegated
(`programs/slipstream/src/instructions/delegate_trading_credit.rs:227-231`), after which the
ER owns every byte of it, so the ER is a fourth writer the enumeration does not contain.
`S5` files exactly this as a **P0** against class **S1-C8** (`S5-X04`,
`docs/audit/audit-e2e/s5.md`), verified here at
`programs/slipstream/src/instructions/withdraw_trading_credit.rs:53-58` — the withdraw
checks `credit.credit >= amount` against the field itself and nothing else, then moves the
amount into `UserAccount.free_collateral`, which `withdraw_collateral` pays out of the
vault. The bullet's own closing sentence ("Whether the ER honours `credit.available()` is
`S2-C11`, not S1") routes the question to a class that does not answer it — see R-03.

A reader of `s1.md` alone sees the run's most load-bearing product claim marked clean.

**Required:** rewrite the `S1-C8` bullet to a **not clear** verdict citing `S5-X04`, in the
shape `S5` and `S4` already use for classes covered by a finding, and drop the `S2-C11`
routing sentence.

### R-03 (P1) — `S2`'s `## Cleared` clears a hostile-sequencer class with a premise that assumes the sequencer is honest

`docs/audit/audit-e2e/s2.md` `## Cleared` bullet **S2-C11** is titled "ER-side execution
under a hostile sequencer" and clears a list — "price-level sortedness, intra-level FIFO
order, free-list integrity, index bounds, self-trade rejection and the POST_ONLY cross
test" — as **survives**, on the stated grounds "because the sequencer runs the same
verified program over the same delegated state." Under a hostile sequencer that premise is
the thing in question. The rest of the run establishes it is false: `S5-01` and the
`## Cleared` bullet `S5-C2` in `docs/audit/audit-e2e/s5.md` establish that the ER owns
every byte of a delegated account and that L1 re-validates none of it, and `S4-06` and
`S4-07` establish the same for the committed `FillLog`. The delegated `OrderBook`
(`programs/slipstream/src/instructions/delegate_orderbook.rs:187-193`) is in exactly that
position: nothing in `settle_from_log` or `settle_trades` re-derives sortedness, the free
list, or self-trade absence from the committed bytes.

The concrete consequence, which no record in the run states:
`OrderBookView::from_account_data` (`programs/slipstream/src/state/order_book.rs:79-100`)
validates the discriminator and the total length and nothing else. It never checks
`free_list_head < max_order_slots`, `free_slot_count <= max_order_slots`, or
`bid_level_count <= max_price_levels_per_side`. `alloc_slot`
(`programs/slipstream/src/state/order_book.rs:161-170`) then does
`self.free_list[head as usize]` with `head = header.free_list_head`, guarded only by
`free_slot_count == 0` — the exact field `S2-C3` calls "bounded by construction". A
committed `free_list_head` pointing at an *active* slot makes `alloc_slot` hand out a live
slot, so `OrderSlot::init` (`programs/slipstream/src/instructions/place_order.rs:274-284`)
overwrites another user's resting order and its `margin_reserved`, and `reconcile_credit`
(`programs/slipstream/src/state/trading_credit.rs:130-142`) then writes that user's
`committed`/`active_orders` down to match. An ER-committed free-list corruption converts
into L1 margin loss — not "at worst order *ordering*".

`S2-C11` does correctly route `FillEvent` contents to S4/S5, so the slice half-saw it. The
**survives** list, and `S2-C3`'s matching "bounded by construction" claim, are the defect.

**Required:** rewrite the `S2-C11` **survives** list and the `S2-C3` bullet to say what actually survives (nothing
that is only a property of ER-written bytes), or reclassify those properties as
**assumed, not verified**, with the same `S5-C2` citation the rest of the run uses.

### R-04 (P1) — `S3`'s `S3-C13` clears the stale-mark gate with a claim the cited writer falsifies

`docs/audit/audit-e2e/s3.md` `## Cleared` bullet **S3-C13** states "the `stamp == 0` escape
at `:157-158` is not reachable with a non-zero price, because `crank_twap` is the only
writer of `last_mark_price` and it stamps on the adjacent line (`crank_twap.rs:71-76`)".
The producer-contract block at the top of the same file restates it harder: the hole is
"**unreachable with a non-zero price**".

The cited writer produces exactly that state.
`programs/slipstream/src/instructions/crank_twap.rs:75-76` computes
`let now_min = ((now_ts / 60) as u64 % 65536) as u16;` and stamps it. `now_min` is **0**
whenever `floor(unix_ts / 60) % 65536 == 0` — one 60-second window every 65,536 minutes
(45.51 days). Inside that window `crank_twap` writes a non-zero oracle price to
`last_mark_price` (`:72`) and a stamp of `0` (`:76`) on adjacent lines.
`programs/slipstream/src/state/market.rs:156-158` then returns `true` unconditionally for
any age, so `mark_price_for_close` (`programs/slipstream/src/state/market.rs:173-182`)
hands out `last_mark_price` forever afterwards. The function's own doc comment at
`programs/slipstream/src/state/market.rs:139-140` names the case — "the ~1-in-45-days
minute that hashes to 0" — so the clearing sentence contradicts the comment on the
function it is clearing.

This is an undiscovered defect, not only a bad clearance. `crank_twap` is permissionless
(`programs/slipstream/src/instructions/crank_twap.rs:19-29`, no signer in the account
list), so any caller can choose to crank inside that window. A crank that runs there and
then stops permanently disables the staleness gate for
`programs/slipstream/src/instructions/close_position.rs:119-125`,
`programs/slipstream/src/instructions/claim_funding.rs:61-63` and
`programs/slipstream/src/instructions/execute_trigger.rs:78-86` — the exact failure the
gate exists to prevent, and the one the run leans on in `S3-03`, `S5-C7`, `S13-02` and
`S13-04`.

**Required:** replace the `S3-C13` bullet's unreachability claim, and file the reachable
`stamp == 0` window as a new `S3` finding. It meets the P1 bar (a required gate stops
working) and carries `[reachable-now]`.

### R-05 (P1) — `S3`'s `S3-C9` clears a lifecycle whose recovery branch is dead code

`docs/audit/audit-e2e/s3.md` `## Cleared` bullet **S3-C9** reads "`liquidation_intent`
lifecycle. Sound." and states it understood the hazard: "The `Ok(false)` returns at `:306`
and `:315` are correct and the comment at `:253-259` documents the rollback bug that made
them necessary."

The same rollback bug is still live one branch away.
`programs/slipstream/src/instructions/liquidate_position.rs:157-163`:

```rust
if !liquidation_intent_acc.data_is_empty() {
    close_liquidation_intent(program_id, liquidation_intent_acc, position_acc, liquidator)?;
}
return Err(SlipstreamError::HealthFactorAboveThreshold.into());
```

`close_liquidation_intent` (`:337-362`) zeroes the account data and moves its lamports;
line 162 then returns `Err`, which reverts every account mutation in the transaction. The
clear never persists. The comment at `:252-259` describes this identical pattern for the
creation branch and explains why `Ok(false)` was mandatory there — the codebase knows the
shape and missed this instance.

Consequence: a `LiquidationIntent` written during a dip survives the position's recovery.
On the next dip with `pending_fills > 0`, `handle_grace_window` (`:307-317`) finds the
stale intent, `is_expired(now)` is true (`deadline_ts = created_ts + GRACE_WINDOW_SECS`,
long past), and returns `Ok(true)` — the position is liquidated immediately in that same
call with no grace window at all. The grace window is the protection `S4-04` and
`record_pending_fill.rs:26-32` both describe as gating liquidation.

**Required:** replace the `S3-C9` bullet's "Sound" verdict, and file the dead recovery
branch as a new `S3` finding at P1 `[reachable-now]`.

### R-06 (P1) — `S9`'s `S9-C2` clears XSS reachability with a wrong mechanism and an incomplete sink list

`docs/audit/audit-e2e/s9.md` `## Cleared` bullet **S9-C2** clears "XSS reachability of the
session key" as **Sound**, on two grounds. Both fail.

1. *"`frontend/src/lib/docs.ts:89-92` hand-escapes `&`, `<`, `>` into the
   `<pre class="mermaid">` block, so graph source cannot break out."* The escaping is
   undone by an `innerHTML` round-trip the bullet never mentions.
   `frontend/src/app/docs/mermaid-runner.tsx:33` stores `el.textContent` — the **decoded**
   text — into `data-src`, and `:30` writes it back with `el.innerHTML = src` on the next
   render pass, which the `themechange` listener at `:59` fires. `securityLevel: "strict"`
   at `:39` governs mermaid's own label rendering and runs after line 30.
2. *"No `eval`, `new Function`, or `srcdoc` anywhere in `frontend/src`."* True and
   irrelevant: the sink that is present is `dangerouslySetInnerHTML={{ __html: doc.html }}`
   at `frontend/src/app/docs/[slug]/page.tsx:24` and
   `frontend/src/app/docs/page.tsx:12`, over `marked.parse()` output
   (`frontend/src/lib/docs.ts:97`) with `marked ^14.1.4`
   (`frontend/package.json:27`, raw-HTML passthrough by default, no `dompurify` in the
   tree). **`S9` files that sink itself, as `S9-05`.** The `## Cleared` bullet clears the
   class the slice's own P2 sits in.

Exploitability is bounded today — docs are repo markdown compiled at build time — but the
clearance's stated mechanism is wrong and its enumeration omits the live sink, on the
origin that holds the `localStorage` session secret (`S9-04`).

**Required:** rewrite the `S9-C2` bullet to a **not clear** verdict citing `S9-05`, drop
the "cannot break out" claim, and add the `mermaid-runner.tsx:30` round-trip as a second
evidence line under `S9-05`.

### R-07 (P2) — `S10-01`'s headline claim is false for most keeper instructions, and its pasted grep does not match its pasted output

`S10-01`'s five roles are real; I re-derived all five, and the `GlobalState.authority` /
`GlobalState.treasury` pair is a genuine addition to the spec's `K2` (which names three).
Three things are wrong:

1. **The title generalises a property that holds for one keeper.** "the keeper role cannot
   be split off without a program change" is true of the *fill-log* keeper and false of the
   rest. Of the thirteen instructions the keepers call, only `record_pending_fill.rs:61`,
   `initialize_fill_log.rs:60` and `delegate_fill_log.rs:98` check `global.authority` — and
   `S10-01`'s body and remediation both name those three correctly, which is to its credit.
   What neither says is the other half: `crank_twap`, `compute_funding`, `settle_trades`,
   `mirror_fills` and `settle_from_log` take **no signer account at all**, and
   `liquidate_position.rs:57`, `execute_trigger.rs:40`, `cancel_order.rs:42`,
   `commit_fill_log.rs:60` and `commit_orderbook.rs:74` take any signer as a fee payer. Five
   of the six `docker-compose.yml` services and both bots can move to an unprivileged key
   today with no program change. As written, "the admin key is *structurally required* to be
   a hot key sitting on the keeper VM, mounted into six containers" reads as true of all six;
   it is true of one.
2. **A pasted output that its pasted command does not produce.** The record shows
   `grep -rn "global.authority != \*" programs/slipstream/src/instructions/ | wc -l` → `12`.
   It returns **11**, at this head and at the freeze.
3. **A severity the run contradicts.** `S7-04` files the operationally identical exposure
   at **P1** with explicit reasoning — "That is a P0 outcome one host compromise away; it is
   filed P1 because the compromise is a precondition, not a demonstrated path"
   (`docs/audit/audit-e2e/s7.md`). `S10-01` is **P0 `[reachable-now]`**. `[reachable-now]`
   is defined in the spec as "exploitable or wrong on the live devnet deployment as it
   stands", and no capability here is exercisable without first stealing the key. The P0/P1
   line is arguable under the spec's own "unbounded authority held by a
   compromised-in-practice key" clause, but the run must not grade one exposure two ways.

**Required:** fix the grep count, restate the title and `**What is wrong.**` to name the
three authority-gated instructions instead of the keeper role as a whole, and reconcile the
severity with `S7-04` — one grade, with the reasoning stated once.

### R-08 (P2) — one defect is filed at two severities in two slices

`S2-01` (P0, `docs/audit/audit-e2e/s2.md`) and `S4-X01` (P1,
`docs/audit/audit-e2e/s4.md`) are the same defect: `OrderBookHeader::push_fill_event`
overwriting an unmirrored entry. Same code
(`programs/slipstream/src/state/order_book.rs:206-221`), same contrast with
`programs/slipstream/src/state/fill_log.rs:83-89`, same live account state, same
remediation shape. Two independent auditors graded it P0 and P1. The merged deliverable
carries both.

**Required:** merge `S4-X01` into `S2-01` at P0 — `S4-X01` is a routed note whose target
slice already filed the defect — and record the merge so the severity counts do not carry
one defect at two grades.

### R-09 (P2) — the headline P0 count double-counts two defects

The run reports **10 P0**. Two pairs are two halves of one defect each, by the records' own
words:

- `S2-01` (P0) and `S2-X01` (P0) — `S2-X01`'s `**What is wrong.**` opens "This is the
  consumer half of `S2-01`" and its `**Blast radius.**` reads "Identical to `S2-01`".
- `S5-01` (P0) and `S5-X04` (P0) — `S5-X04`'s title is "(L1 half of `S5-01`)" and its
  `**Proof.**` is "See the exhaustive field grep pasted under S5-01".

Both splits are correct under §4's routing rule (the fix lands in another slice's file
set) and neither is padding. The defect is in the reporting: **eight** distinct P0 defects
are presented as ten, a 25% inflation of the run's most quoted number.

**Required:** state the distinct-defect P0 count alongside the record count wherever the
run's totals are published, and mark each of the four records with its pair.

### R-10 (P2) — `S4` grades two findings with the same precondition and the same consequence at different severities

`S4-06` (**P0**, `[mainnet-only]`) and `S4-07` (**P1**) both require exactly one thing — an
ER that authors the committed `FillLog`/`FillEvent` bytes — and both end in the same place:
`Position.collateral` credited with value nothing debited. `S4-07`'s mechanism is verified
here: `settle_from_log.rs:117-120` bounds `capacity` against the account's data length but
never bounds `count` by `capacity`, and the loop at `:129-131` indexes
`(head + processed) % capacity` while `last_settled` is read once at `:97-100` and never
updated inside the loop, so a committed `count > capacity` applies the same `FillEvent`
more than once in one call.

**Required:** regrade `S4-07` to P0 with a `[mainnet-only]` tag, or state in `S4-06` why the
same precondition yields a different severity. One of the two, not neither.

### R-11 (P2) — nine routed notes were cleared away by the slice they were routed to

A cross-slice note is the run's mechanism for a defect that lives in another slice's file
set. Nine landed in a class the receiving slice then declared sound, so the merged
deliverable contains a CONFIRMED finding and a clean verdict on the same class.

| Note | Sev | Target class | The clearing sentence |
|---|---|---|---|
| `S5-X04` | **P0** | `S1-C8` | "the cap is enforced and cannot be raised without the owner's signature … holds on the L1 side" — see R-02 |
| `S5-X03` | P1 | `S4-C8` | "Found sound at `settle_from_log.rs:104-121`" — S4's claim is memory safety, S5's P1 is field semantics; the class is named "Trust in ER-authored data" |
| `S1-X03` | P2 | `S9-C7` | "`closeLegacyCredit` … refuses on a delegated legacy credit client-side … mirroring the program-side guard". It mirrors one of two guards. Per `S1-01`, `close_trading_credit` cannot succeed on **any** 56-byte credit, delegated or not (`programs/slipstream/src/state/trading_credit.rs:53-55`), so the branch S9 clears as correct is the branch that always fails |
| `S6-X02` | P2 | `S13-C2` | S13 cites `status-panel.tsx:70-76` as proof the panel is honest; S6 files the same lines as the defect (a divergence heuristic standing in for `Market.mark_price_minute`) |
| `S5-X01` | P2 | `S12-C3` | "disclosed accurately and loudly in three places — … `README.md:242-244` — including the oracle-account-binding gap". `README.md:243` says binding is "Not validated"; `verify_feeds` (`programs/slipstream/src/oracle.rs:63-77`) is called on all three price paths, and `S5`'s own `S5-C3` says so "contrary to `README.md:243`" |
| `S3-X02` | P2 | `S1-C11` | "clean across the whole owned set … No unvalidated enum or flag byte exists". `funding_interval` is neither listed nor range-checked at `initialize_market.rs:85-93` |
| `S7-X04`, `S9-X01`, `S8-X04` | P2/P3 | `S10-C10` | "Posture checked and sound otherwise" — `restart: unless-stopped`, `next.config.ts` and `vercel.json` are all S10-owned and none is addressed |
| `S11-X01` | P3 | `S12-C1` | "**123 Rust tests, 25 unit + 98 Mollusk** (`PRODUCT.md:82`) **matches**". S12 counted files; `S11`, which owns `tests/unit/`, counted harnesses and says 38 of the 98 are not Mollusk |

Separately, `S10`'s `S10-C5` bullet deflects the routed `S11-X03` with "The integration
suite and the absence of any frontend test are K8/**K11** territory". **`K11` does not
exist** — `docs/spec/audit-e2e.md` defines `K1` through `K8` only.

**Required:** for each row, either reopen the class with a **not clear** verdict citing the
note, or state in the bullet why the note does not apply — a clearance that does not
mention an inbound CONFIRMED note is not a negative result. Replace the `K11` citation.

### R-12 (P2) — the closing test pass records a false green on both frontend legs

`docs/runs/audit-e2e/closing-tests.txt` at `9316020` records:

```
--- frontend tsc ---
                This is not the tsc command you are looking for
tsc_exit=0
--- frontend lint ---
--- frozen RUN items (all 13 slices) ---
```

That banner is the squatted `tsc` npm package, not `typescript`; no type-check ran. The
`--- frontend lint ---` section is empty; no lint ran. `frontend/node_modules` does not
exist in the checkout. The `tsc_exit=0` line was recorded as a pass and relayed downstream
as "tsc clean, lint 17 pre-existing warnings" — those are the **baseline's** numbers from
`docs/runs/audit-e2e/baseline-tests.txt` at `698dd4f`, which record a real
`tsc --noEmit : exit 0` and `eslint : 0 errors, 17 warnings`.

Consequence for this run is nil: run shape A changed no source, so nothing could have
broken. The defect is that a leg of the closing evidence is a no-op recorded as a pass, and
the next run that does change source inherits the same harness.

**Required:** make the frontend legs of the test-pass harness fail loudly when the
toolchain is absent — resolve `tsc` through `frontend/node_modules/.bin` and treat a
missing binary as a non-zero exit rather than a pass — and correct the closing-tests record
at `9316020` to say the frontend legs did not run.

### R-13 (P3) — a stale comment in the settlement money path contradicts the code 20 lines below it

`programs/slipstream/src/instructions/settle_from_log.rs:148-152` states the loop will
"SKIP this fill but STILL advance the cursor past it, so one orphan can never block the
whole queue forever." The code at `:171-186` states and implements the opposite ("STOP — do
not advance the cursor", then `break`). `S4` owns the file, cites `:171-187` in `S4-04` and
`:128-141` in `S4-01`, and files neither. This is the spec's own P3 bar — "a doc that
describes behaviour the code no longer has" — sitting inside the function two of the run's
P0s are about.

**Required:** file it as an `S4` P3 under class `S4-C1`, with the remediation being deletion
of the stale sentence.

### R-14 (P3) — three `## Cleared` enumerations are incomplete as written

No defect behind any of them; the exhaustiveness claim is what is wrong.

- `s13.md` **S13-C5**: "the only infinite CSS animation in the app is `.live-dot`". Also
  `frontend/src/components/trading/positions-table.tsx:271` (`animate-pulse`) and
  `frontend/src/components/trading/session-panel.tsx:154` (`animate-spin`), both in S13's
  own owned set. Harmless — `frontend/src/app/globals.css:305-313` has a universal
  `prefers-reduced-motion` reset — but the enumeration is wrong.
- `s3.md` **S3-C1**: "Enumerated every division in the slice". Misses
  `programs/slipstream/src/instructions/compute_funding.rs:41`
  (`let intervals = elapsed / interval_secs;`), an owned file. Cited under `S3-01`, so
  nothing is lost.
- `s5.md` **S5-C3**: "clear on every reachable path". `verify_feeds` reads
  `market.pyth_feed` out of a `Market` that `crank_twap` never pins to
  `[SEED_MARKET, market_index]` — `grep -c SEED_MARKET crank_twap.rs` returns 0, which is
  what `S1-X01` files. Constrained today (`market_count == 1`), which is why `S1-X01` is
  P2, but "clear on every reachable path" overstates it.

**Required:** scope each claim to what was actually enumerated.

## Out of scope for this review

- The frozen checks are purely structural — `docs/checks/audit-e2e/validate-findings.py`
  verifies existence, headings, the calibration string, record shape, the severity/tag/class
  enums, that evidence resolves, that a proof section is present, routed-record placement,
  class coverage, the minimum-finding rule, and the no-diff rule. It verifies no reasoning.
  17/17 green is therefore consistent with R-01 through R-03 and is not itself a defect.
