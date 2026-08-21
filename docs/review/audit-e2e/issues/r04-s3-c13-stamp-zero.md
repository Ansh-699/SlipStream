# R-04 — `S3-C13` clears the stale-mark gate with a claim `crank_twap` falsifies; file the reachable `stamp == 0` window

- **Severity:** P1
- **Blocked by:** `r01-s3-01-proof-path` (same file, `docs/audit/audit-e2e/s3.md`)
- **Owns:** `docs/audit/audit-e2e/s3.md` (`## Cleared` bullet `S3-C13`, the producer-contract block's mark-staleness paragraph, and one new `## Findings` record)
- **Does not touch:** product source; `docs/checks/`.

## Interface contract (published)

After this issue the run holds one story about the stale-mark gate. `S3-03`, `S5-C7`,
`S13-02` and `S13-04` all lean on `mark_price_for_close` returning `None` while the crank
is dead; this issue records the one input that makes it return `Some` forever instead.

## What is wrong

The `S3-C13` bullet claims "the `stamp == 0` escape at `:157-158` is not reachable with a
non-zero price, because `crank_twap` is the only writer of `last_mark_price` and it stamps
on the adjacent line (`crank_twap.rs:71-76`)". The producer-contract block at the top of
`s3.md` restates it as "unreachable with a non-zero price".

The cited writer produces it. `programs/slipstream/src/instructions/crank_twap.rs:75-76`:

```rust
let now_min = ((now_ts / 60) as u64 % 65536) as u16;
market.set_mark_price_minute(now_min);
```

`now_min` is `0` for one 60-second window every 65,536 minutes (45.51 days). In that window
line `:72` writes a non-zero oracle price to `last_mark_price` and line `:76` writes a stamp
of `0`. `programs/slipstream/src/state/market.rs:156-158` then returns `true` for any age,
so `mark_price_for_close` (`programs/slipstream/src/state/market.rs:173-182`) serves that
price forever. The function's own doc comment at
`programs/slipstream/src/state/market.rs:139-140` names the case — "the ~1-in-45-days minute
that hashes to 0" — so the clearance contradicts the comment on the function it clears.

`crank_twap` is permissionless (`programs/slipstream/src/instructions/crank_twap.rs:19-29`,
no signer in the account list), so a caller can choose to crank inside the window. Afterwards
the gate is off for `close_position.rs:119-125`, `claim_funding.rs:61-63` and
`execute_trigger.rs:78-86`.

## Change skeleton

- `docs/audit/audit-e2e/s3.md`, `## Findings`: append one record at the next sequential id.
  - `**Severity:** P1`, `**Tag:** [reachable-now]`, `**Class:** S3-C13`, `**Status:** CONFIRMED`.
  - `**Evidence:**` `programs/slipstream/src/instructions/crank_twap.rs:75-76`,
    `programs/slipstream/src/state/market.rs:156-158`,
    `programs/slipstream/src/state/market.rs:139-140`,
    `programs/slipstream/src/state/market.rs:173-182`.
  - `**Proof.**` a §4(b) repro under `docs/audit/audit-e2e/repro/s3/` that asserts
    `is_mark_price_fresh` returns `true` for an arbitrarily old mark once the stamp is 0, plus
    the next two wall-clock windows computed from the formula.
- `docs/audit/audit-e2e/s3.md`, `## Cleared`, bullet `S3-C13`: replace the unreachability
  sentence with a **not clear** verdict pointing at the new record.
- `docs/audit/audit-e2e/s3.md`, producer-contract block: strike "unreachable with a non-zero
  price".

<!-- architect-run: audit-e2e -->
