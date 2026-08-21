# Check: r09-p0-count — the distinct-defect P0 count

**Run:** `audit-e2e` (closing review) · **Issue draft:** `docs/review/audit-e2e/issues/r09-p0-count.md`
**Spec pointer:** `docs/review/audit-e2e/review-spec.md` `### R-09 (P2)`

## Purpose

The run's most-quoted number is "10 P0". Eight distinct defects produce those ten records.
This check grades that both numbers are published and that each paired record points at its
other half.

Every RUN item below is a single command that exits 0 or non-zero on its own; no reader
judgement is involved. Each item is falsifiable against the tree as it stands at `9316020`:
the "gone" items pass only once the defective text is removed and fail today, and the
"present" items pass only once the corrective text is written and fail today. Run from the
repository root.

What this check does **not** grade: whether the rewritten prose is *well written*. It grades
that the specific false or missing statement named in the review spec is no longer there and
that the frozen structural grader still passes on the edited file.

## Fix contract

A failure means a reader still counts ten separate P0 defects. No severity changes and no
record is deleted; this is a labelling repair only.

The file(s) to edit are named in the issue draft and nowhere else. `docs/checks/**` stays
read-only; if a RUN item below is wrong *about the review spec*, that is a ruling for the
orchestrator, not a rewrite of this file.

## Graded items

- RUN: `awk '/^### S2-01 /,/^### S2-02 /' docs/audit/audit-e2e/s2.md | grep -q 'Pairs with:'` -> exit:0
  — the producer half names its consumer half.
- RUN: `awk '/^### S2-X01 /,/^### S2-X02 /' docs/audit/audit-e2e/s2.md | grep -q 'Pairs with:'` -> exit:0
  — and the reverse.
- RUN: `awk '/^### S5-01 /,/^### S5-02 /' docs/audit/audit-e2e/s5.md | grep -q 'Pairs with:'` -> exit:0
  — the ER half names its L1 half.
- RUN: `awk '/^### S5-X04 /,0' docs/audit/audit-e2e/s5.md | grep -q 'Pairs with:'` -> exit:0
  — and the reverse.
- RUN: `test "$(grep -h '^- \*\*Severity:\*\* P0' docs/audit/audit-e2e/s*.md | wc -l)" -eq 10` -> exit:0
  — the record count is still ten; this issue relabels, it does not merge records away.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S2 evidence` -> exit:0 match:"PASS S2 evidence"
  — every citation in the edited file still resolves; the fix did not introduce a dead path:line.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S2 cleared` -> exit:0 match:"PASS S2 cleared"
  — the negative-results section still accounts for every threat class with a resolving citation.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S2 records` -> exit:0 match:"PASS S2 records"
  — record ids still parse and are still unique after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S2 tag` -> exit:0 match:"PASS S2 tag"
  — the P0/P1-carries-exactly-one-tag rule still holds after the edit.
