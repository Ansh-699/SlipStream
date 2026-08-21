# Check: r03-s2-c11-false-clear — `S2-C11` clears a hostile-sequencer class by assuming an honest sequencer

**Run:** `audit-e2e` (closing review) · **Issue draft:** `docs/review/audit-e2e/issues/r03-s2-c11-false-clear.md`
**Spec pointer:** `docs/review/audit-e2e/review-spec.md` `### R-03 (P1)`

## Purpose

`S2-C11` is named "ER-side execution under a hostile sequencer" and clears six properties as
surviving *because the sequencer runs the same verified program*. This check grades that the
circular premise is gone and that the delegated-writer fact is stated.

Every RUN item below is a single command that exits 0 or non-zero on its own; no reader
judgement is involved. Each item is falsifiable against the tree as it stands at `9316020`:
the "gone" items pass only once the defective text is removed and fail today, and the
"present" items pass only once the corrective text is written and fail today. Run from the
repository root.

What this check does **not** grade: whether the rewritten prose is *well written*. It grades
that the specific false or missing statement named in the review spec is no longer there and
that the frozen structural grader still passes on the edited file.

## Fix contract

A failure means the run still claims order-book invariants survive an adversary that authors
the account bytes. Either verdict is acceptable — "does not survive" or "assumed, not
verified" — but the stated ground must not be the premise under test.

The file(s) to edit are named in the issue draft and nowhere else. `docs/checks/**` stays
read-only; if a RUN item below is wrong *about the review spec*, that is a ruling for the
orchestrator, not a rewrite of this file.

## Graded items

- RUN: `! grep -q 'because the sequencer runs the same verified program over the same delegated state' docs/audit/audit-e2e/s2.md` -> exit:0
  — the circular justification is gone.
- RUN: `grep -A10 '\*\*S2-C11\*\*' docs/audit/audit-e2e/s2.md | grep -qE 'assumed, not verified|does not survive'` -> exit:0
  — the six properties now carry a verdict the class premise supports.
- RUN: `grep -A10 '\*\*S2-C11\*\*' docs/audit/audit-e2e/s2.md | grep -qE 'S5-C2|S5-01'` -> exit:0
  — the bullet cites the finding that establishes the ER owns every byte.
- RUN: `! grep -q 'Every .u16. index is bounded by construction' docs/audit/audit-e2e/s2.md` -> exit:0
  — `S2-C3`'s matching claim, which `alloc_slot` reads straight out of an unvalidated header, is corrected too.
- RUN: `grep -A8 '\*\*S2-C3\*\*' docs/audit/audit-e2e/s2.md | grep -q 'free_list_head'` -> exit:0
  — `S2-C3` now names the header field its bound depends on.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S2 evidence` -> exit:0 match:"PASS S2 evidence"
  — every citation in the edited file still resolves; the fix did not introduce a dead path:line.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S2 cleared` -> exit:0 match:"PASS S2 cleared"
  — the negative-results section still accounts for every threat class with a resolving citation.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S2 records` -> exit:0 match:"PASS S2 records"
  — record ids still parse and are still unique after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S2 tag` -> exit:0 match:"PASS S2 tag"
  — the P0/P1-carries-exactly-one-tag rule still holds after the edit.
