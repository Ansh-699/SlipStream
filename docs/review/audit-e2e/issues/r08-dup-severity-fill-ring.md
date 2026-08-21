# R-08 — one defect carries two severities across four records; merge to one

- **Severity:** P2
- **Blocked by:** none
- **Owns:** `docs/audit/audit-e2e/s4.md` (records `S4-X01`, `S4-03`), `docs/audit/audit-e2e/s2.md` (`## Cleared` bullet `S2-C8` only)
- **Does not touch:** product source; records `S2-01` / `S2-X01`; `docs/checks/`.

## Interface contract (published)

After this issue, the fill-ring overwrite defect appears once per side (producer, consumer)
at one severity each, and the run's severity counts stop carrying one defect at two grades.

## What is wrong

Four records describe one physical loss — the ER `OrderBook` ring overwriting an entry the
FillLog never mirrored:

- `S2-01` (**P0**, `S2-C8`) — producer side. Evidence
  `programs/slipstream/src/state/order_book.rs:206-222`,
  `programs/slipstream/src/instructions/mirror_fills.rs:125-134`.
- `S4-X01` (**P1**, `S2-C8`, routed to S2) — producer side. Evidence
  `programs/slipstream/src/state/order_book.rs:195-222`. Same function, same lines, same
  contrast with `programs/slipstream/src/state/fill_log.rs:83-89`, same remediation.
- `S2-X01` (**P0**, `S4-C1`, routed to S4) — consumer side. Its own text: "This is the
  consumer half of `S2-01`… **Blast radius.** Identical to `S2-01`."
- `S4-03` (**P1**, `S4-C5`) — same consumer/producer seam, same live account state
  (`head == tail == 3229`, `next_fill_sequence = 44190`), same repro.

Two independent auditors graded the producer side P0 and P1, and the consumer side P0 and
P1. `S2`'s `S2-C8` `## Cleared` bullet names "S2-01 (P0) and the routed S2-X01" — S2's own
outbound note — and never mentions the inbound `S4-X01`.

Note the class bookkeeping hid it: `S2-X01` is filed against `S4-C1` (settlement cursor),
but the S4 finding it duplicates lives in `S4-C5`, so `s4.md`'s `S4-C1` bullet ("Covered by
S4-01") reads as if it answered the note.

## Change skeleton

- `docs/audit/audit-e2e/s4.md`, record `S4-X01`: mark as superseded by `S2-01`, or delete it —
  a routed note whose target slice already filed the defect at a higher severity carries no
  information.
- `docs/audit/audit-e2e/s4.md`, record `S4-03`: add a `**Duplicate of:**` line naming
  `S2-X01`, and reconcile the two severities.
- `docs/audit/audit-e2e/s2.md`, `## Cleared` bullet `S2-C8`: acknowledge the inbound
  `S4-X01`.
- No product source and no other record changes.

<!-- architect-run: audit-e2e -->
