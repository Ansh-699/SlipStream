# Check: r13-stale-settlement-comment — the stale settlement comment `S4` cites around

**Run:** `audit-e2e` (closing review) · **Issue draft:** `docs/review/audit-e2e/issues/r13-stale-settlement-comment.md`
**Spec pointer:** `docs/review/audit-e2e/review-spec.md` `### R-13 (P3)`

## Purpose

`settle_from_log.rs:148-152` describes the opposite of what `:171-186` implements, inside the
function two of the run's P0s are about. This check grades that `S4` files it.

Every RUN item below is a single command that exits 0 or non-zero on its own; no reader
judgement is involved. Each item is falsifiable against the tree as it stands at `9316020`:
the "gone" items pass only once the defective text is removed and fail today, and the
"present" items pass only once the corrective text is written and fail today. Run from the
repository root.

What this check does **not** grade: whether the rewritten prose is *well written*. It grades
that the specific false or missing statement named in the review spec is no longer there and
that the frozen structural grader still passes on the edited file.

## Fix contract

A failure means the run still leaves a comment on the settlement money path that contradicts
the exactly-once semantics `S4-01` turns on. The repair is a P3 record; do not edit the
program source.

The file(s) to edit are named in the issue draft and nowhere else. `docs/checks/**` stays
read-only; if a RUN item below is wrong *about the review spec*, that is a ruling for the
orchestrator, not a rewrite of this file.

## Graded items

- RUN: `grep -q 'settle_from_log.rs:148-152' docs/audit/audit-e2e/s4.md` -> exit:0
  — the stale comment is cited in the findings file.
- RUN: `grep -q 'SKIP this fill but STILL advance the cursor' docs/audit/audit-e2e/s4.md` -> exit:0
  — the contradicting sentence is quoted, so a reader can see the split without opening the source.
- RUN: `grep -q 'STOP — do not advance the cursor' docs/audit/audit-e2e/s4.md` -> exit:0
  — and the sentence it contradicts.
- RUN: `test -z "$(git diff --name-only -- programs/slipstream/src/instructions/settle_from_log.rs)"` -> exit:0
  — the run shape held: the comment was filed, not fixed.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 impact` -> exit:0 match:"PASS S4 impact"
  — the new record carries What is wrong / Blast radius / Suggested remediation.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 evidence` -> exit:0 match:"PASS S4 evidence"
  — every citation in the edited file still resolves; the fix did not introduce a dead path:line.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 cleared` -> exit:0 match:"PASS S4 cleared"
  — the negative-results section still accounts for every threat class with a resolving citation.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 records` -> exit:0 match:"PASS S4 records"
  — record ids still parse and are still unique after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 tag` -> exit:0 match:"PASS S4 tag"
  — the P0/P1-carries-exactly-one-tag rule still holds after the edit.
