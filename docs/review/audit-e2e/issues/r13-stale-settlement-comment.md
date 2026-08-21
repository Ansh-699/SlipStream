# R-13 — file the stale settlement comment `S4` cites around but never reports

- **Severity:** P3
- **Blocked by:** `r08-dup-severity-fill-ring`, `r10-s4-06-07-severity` (same file)
- **Owns:** `docs/audit/audit-e2e/s4.md` (one new `## Findings` record)
- **Does not touch:** product source; `docs/checks/`.

## What is wrong

`programs/slipstream/src/instructions/settle_from_log.rs:148-152` states the loop will
"SKIP this fill but STILL advance the cursor past it, so one orphan can never block the
whole queue forever." The code twenty lines below states and implements the opposite:
`:172` "STOP — do not advance the cursor", followed by `break` at `:186`.

`S4` owns the file and cites both regions — `:171-187` in `S4-04` and `:128-141` in `S4-01` —
and files neither. This is the spec's own P3 bar ("a doc that describes behaviour the code no
longer has"), sitting inside the function two of the run's P0s are about, describing the
opposite of the exactly-once semantics `S4-01` turns on.

## Change skeleton

- `docs/audit/audit-e2e/s4.md`, `## Findings`: append one record at the next sequential id.
  - `**Severity:** P3`, no `**Tag:**`, `**Class:** S4-C1`, `**Status:** CONFIRMED`.
  - `**Evidence:**` `programs/slipstream/src/instructions/settle_from_log.rs:148-152` and
    `:171-186`.
  - `**Proof.**` the two comment blocks pasted side by side (a §4(d)-shaped contradiction).
  - `**Suggested remediation.**` delete the stale sentence.

<!-- architect-run: audit-e2e -->
