# R-05 — `S3-C9` clears a lifecycle whose recovery branch is reverted by its own `Err`

- **Severity:** P1
- **Blocked by:** `r04-s3-c13-stamp-zero` (same file, `docs/audit/audit-e2e/s3.md`)
- **Owns:** `docs/audit/audit-e2e/s3.md` (`## Cleared` bullet `S3-C9`, and one new `## Findings` record)
- **Does not touch:** product source; `docs/checks/`.

## Interface contract (published)

After this issue, `S3-C9` reports the state of the whole `LiquidationIntent` lifecycle, not
only the two branches that were already fixed.

## What is wrong

`S3-C9` reads "`liquidation_intent` lifecycle. Sound." and states it understood the hazard:
"The `Ok(false)` returns at `:306` and `:315` are correct and the comment at `:253-259`
documents the rollback bug that made them necessary."

The same bug is live one branch away.
`programs/slipstream/src/instructions/liquidate_position.rs:157-163`:

```rust
if !liquidation_intent_acc.data_is_empty() {
    close_liquidation_intent(program_id, liquidation_intent_acc, position_acc, liquidator)?;
}
return Err(SlipstreamError::HealthFactorAboveThreshold.into());
```

`close_liquidation_intent` (`:337-362`) zeroes the data and moves the lamports; line `:162`
returns `Err`, which reverts every mutation in the transaction. The clear never persists.
The comment at `:252-259` documents this exact pattern for the creation branch and explains
why `Ok(false)` was mandatory there.

Consequence: an intent written during a dip survives the position's recovery. On the next
dip with `pending_fills > 0`, `handle_grace_window` (`:307-317`) reads the stale intent,
`is_expired(now)` is true because `deadline_ts = created_ts + GRACE_WINDOW_SECS` is long
past, and returns `Ok(true)` — liquidation proceeds in that same call with no grace window.
The grace window is the protection `record_pending_fill.rs:26-32` describes as gating
liquidation and that `S4-04` relies on.

No test covers the recovery-clear path; `tests/unit/src/test_liquidate_position_regressions.rs:154-176`
asserts only the forged-account rejection on this branch. That test gap is S11's file set
and should be routed as an `S3-X` note, not filed here.

## Change skeleton

- `docs/audit/audit-e2e/s3.md`, `## Findings`: append one record at the next sequential id.
  - `**Severity:** P1`, `**Tag:** [reachable-now]`, `**Class:** S3-C9`, `**Status:** CONFIRMED`.
  - `**Evidence:**` `programs/slipstream/src/instructions/liquidate_position.rs:157-163`,
    `:252-259`, `:307-317`, `:337-362`.
  - `**Proof.**` a §4(b) repro asserting the intent account still carries `DISC_LIQUIDATION_INTENT`
    after a recovery call returns `Err`, or the equivalent static demonstration that the
    `Err` at `:162` reverts the write at `:359`.
- `docs/audit/audit-e2e/s3.md`, `## Cleared`, bullet `S3-C9`: replace "Sound" with a
  **not clear** verdict pointing at the new record; keep the `Ok(false)` analysis.
- `docs/audit/audit-e2e/s3.md`, `## Cross-slice notes`: append an `S3-X` note routed to `S11`
  for the missing recovery-clear test.

<!-- architect-run: audit-e2e -->
