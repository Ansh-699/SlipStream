# Check: r08-dup-severity-fill-ring — one defect at two severities across four records

**Run:** `audit-e2e` (closing review) · **Issue draft:** `docs/review/audit-e2e/issues/r08-dup-severity-fill-ring.md`
**Spec pointer:** `docs/review/audit-e2e/review-spec.md` `### R-08 (P2)`

## Purpose

The fill-ring overwrite is filed four times at two severities. This check grades that the
duplicate routed note is retired and that the remaining records cross-reference.

Every RUN item below is a single command that exits 0 or non-zero on its own; no reader
judgement is involved. Each item is falsifiable against the tree as it stands at `9316020`:
the "gone" items pass only once the defective text is removed and fail today, and the
"present" items pass only once the corrective text is written and fail today. Run from the
repository root.

What this check does **not** grade: whether the rewritten prose is *well written*. It grades
that the specific false or missing statement named in the review spec is no longer there and
that the frozen structural grader still passes on the edited file.

## Fix contract

A failure means the merged deliverable still carries one defect at both P0 and P1. Retiring
`S4-X01` is the intended repair; regrading it to P0 is also acceptable, but leaving two grades
is not.

The file(s) to edit are named in the issue draft and nowhere else. `docs/checks/**` stays
read-only; if a RUN item below is wrong *about the review spec*, that is a ruling for the
orchestrator, not a rewrite of this file.

## Graded items

- RUN: `awk '/^### S4-X01 /,/^### S4-X02 /' docs/audit/audit-e2e/s4.md | grep -qEi 'superseded by .S2-01.|duplicate of .S2-01.' || ! grep -q '^### S4-X01 ' docs/audit/audit-e2e/s4.md` -> exit:0
  — `S4-X01` is either marked superseded by `S2-01` or removed.
- RUN: `awk '/^### S4-03 /,/^### S4-04 /' docs/audit/audit-e2e/s4.md | grep -q 'S2-X01'` -> exit:0
  — `S4-03` now names the routed note it duplicates.
- RUN: `grep -A6 '\*\*S2-C8\*\*' docs/audit/audit-e2e/s2.md | grep -q 'S4-X01'` -> exit:0
  — `S2`'s `S2-C8` bullet acknowledges the inbound note it currently ignores.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 routed` -> exit:0 match:"PASS S4 routed"
  — the cross-slice section still parses after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S2 cleared` -> exit:0 match:"PASS S2 cleared"
  — `S2`'s class coverage survives the `S2-C8` rewrite.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 evidence` -> exit:0 match:"PASS S4 evidence"
  — every citation in the edited file still resolves; the fix did not introduce a dead path:line.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 cleared` -> exit:0 match:"PASS S4 cleared"
  — the negative-results section still accounts for every threat class with a resolving citation.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 records` -> exit:0 match:"PASS S4 records"
  — record ids still parse and are still unique after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 tag` -> exit:0 match:"PASS S4 tag"
  — the P0/P1-carries-exactly-one-tag rule still holds after the edit.
