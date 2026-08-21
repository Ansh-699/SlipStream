# R-03 — `S2`'s `S2-C11` clears a hostile-sequencer class on the premise that the sequencer is honest

- **Severity:** P1
- **Blocked by:** none
- **Owns:** `docs/audit/audit-e2e/s2.md` (`## Cleared` bullet `S2-C11` only)
- **Does not touch:** any program source; any `S2` finding record; `docs/checks/`.

## Interface contract (published)

After this issue, the run's three ER-trust-boundary clearances agree. `S2-C11`,
`S5-C2` and `S4-C6` all say the same thing about ER-authored bytes: L1 re-validates none of
them, so no property that is only a property of those bytes is verified.

## What is wrong

`classes.tsv` names `S2-C11` "ER-side execution under a hostile sequencer". The
`## Cleared` bullet clears a list as **survives**: "price-level sortedness, intra-level
FIFO order, free-list integrity, index bounds, self-trade rejection and the POST_ONLY cross
test, because the sequencer runs the same verified program over the same delegated state."

The stated ground is the premise the class exists to test. A hostile sequencer is precisely
one that does not run the verified program, and the rest of the run establishes it can
write what it likes: `S5-01` and the `S5-C2` bullet in `docs/audit/audit-e2e/s5.md`
establish that the ER owns every byte of a delegated account with no L1 re-validation, and
`S4-06` and `S4-07` establish the same for the committed `FillLog`. The `OrderBook` is
delegated by the same mechanism
(`programs/slipstream/src/instructions/delegate_orderbook.rs:187-193`), and nothing in
`settle_trades` or `settle_from_log` re-derives sortedness, free-list integrity, or
self-trade absence from the committed bytes — both files read the committed queue
read-only (`programs/slipstream/src/instructions/settle_trades.rs:44-49`).

The bullet does correctly route `FillEvent` contents to S4/S5, so the slice half-saw the
boundary. The **survives** list is the defect, and it is the negative result a reader would
lean on hardest.

## Change skeleton

- `docs/audit/audit-e2e/s2.md`, `## Cleared`, bullet `S2-C11` only:
  - move the six listed properties out of **survives**;
  - state them as **assumed, not verified** — they hold if and only if the sequencer runs
    the deployed program, which is the assumption the class tests — citing
    `programs/slipstream/src/instructions/delegate_orderbook.rs:187-193` and the
    `S5-C2` finding;
  - keep the (a)/(b)/(c) **does not survive** list and the existing `S2-03` coverage
    unchanged.
- No other bullet, record, or file changes.

<!-- architect-run: audit-e2e -->
