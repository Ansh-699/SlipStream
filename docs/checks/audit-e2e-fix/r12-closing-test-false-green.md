# Check: r12-closing-test-false-green — the closing test pass records a no-op as a pass

**Run:** `audit-e2e` (closing review) · **Issue draft:** `docs/review/audit-e2e/issues/r12-closing-test-false-green.md`
**Spec pointer:** `docs/review/audit-e2e/review-spec.md` `### R-12 (P2)`

## Purpose

Two legs of the closing test pass at `9316020` did not execute and were recorded as passing.
This check grades that the harness now fails loudly when the toolchain is absent, and that the
record says the legs did not run.

Every RUN item below is a single command that exits 0 or non-zero on its own; no reader
judgement is involved. Each item is falsifiable against the tree as it stands at `9316020`:
the "gone" items pass only once the defective text is removed and fail today, and the
"present" items pass only once the corrective text is written and fail today. Run from the
repository root.

What this check does **not** grade: whether the rewritten prose is *well written*. It grades
that the specific false or missing statement named in the review spec is no longer there and
that the frozen structural grader still passes on the edited file.

## Fix contract

A failure means the next run inherits a harness that greens on a missing binary. Installing
`frontend/node_modules` is an acceptable repair; silently resolving a global `tsc` is not, and
the check below is written to catch that.

The file(s) to edit are named in the issue draft and nowhere else. `docs/checks/**` stays
read-only; if a RUN item below is wrong *about the review spec*, that is a ruling for the
orchestrator, not a rewrite of this file.

## Graded items

- RUN: `test -f docs/runs/audit-e2e/closing-tests.txt` -> exit:0
  — the record exists. `docs/runs/` is gitignored, so this item also pins that the fix wave runs where the run artifacts live, not in a clean worktree.
- RUN: `test -f docs/runs/audit-e2e/closing-tests.txt && { ! grep -q 'This is not the tsc command you are looking for' docs/runs/audit-e2e/closing-tests.txt || grep -qi 'did not run\|did not execute' docs/runs/audit-e2e/closing-tests.txt; }` -> exit:0
  — the record either no longer contains the squatted-package banner, or states the legs did not execute.
- RUN: `test -f docs/runs/audit-e2e/closing-tests.txt && { ! grep -qE '^tsc_exit=0$' docs/runs/audit-e2e/closing-tests.txt || grep -qi 'did not run\|did not execute' docs/runs/audit-e2e/closing-tests.txt; }` -> exit:0
  — a recorded `exit=0` is no longer unqualified.
- RUN: `test -x frontend/node_modules/.bin/tsc || grep -qi 'did not run\|did not execute' docs/runs/audit-e2e/closing-tests.txt` -> exit:0
  — the toolchain is present, or its absence is on the record.
- RUN: `test -x frontend/node_modules/.bin/eslint || grep -qi 'did not run\|did not execute' docs/runs/audit-e2e/closing-tests.txt` -> exit:0
  — same for the lint leg.
- RUN: `test -z "$(git diff --name-only 698dd4f..HEAD -- programs keepers frontend client tests)"` -> exit:0
  — run shape A still holds, so the false green could not have masked a real regression.
