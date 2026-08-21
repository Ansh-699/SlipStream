# Check: r05-s3-c9-intent-rollback — the dead recovery branch `S3-C9` clears as sound

**Run:** `audit-e2e` (closing review) · **Issue draft:** `docs/review/audit-e2e/issues/r05-s3-c9-intent-rollback.md`
**Spec pointer:** `docs/review/audit-e2e/review-spec.md` `### R-05 (P1)`

## Purpose

`S3-C9` clears the `LiquidationIntent` lifecycle as "Sound" while quoting the very rollback
bug that is still live in the recovery branch. This check grades that the verdict is
retracted and the branch is filed.

Every RUN item below is a single command that exits 0 or non-zero on its own; no reader
judgement is involved. Each item is falsifiable against the tree as it stands at `9316020`:
the "gone" items pass only once the defective text is removed and fail today, and the
"present" items pass only once the corrective text is written and fail today. Run from the
repository root.

What this check does **not** grade: whether the rewritten prose is *well written*. It grades
that the specific false or missing statement named in the review spec is no longer there and
that the frozen structural grader still passes on the edited file.

## Fix contract

A failure means the run still reports a grace window that a stale intent collapses to zero.
The repair is a new `S3` record at P1 plus a corrected bullet, and a routed `S3-X` note to
`S11` for the missing test — the test itself is S11's file set and must not be written here.

The file(s) to edit are named in the issue draft and nowhere else. `docs/checks/**` stays
read-only; if a RUN item below is wrong *about the review spec*, that is a ruling for the
orchestrator, not a rewrite of this file.

## Graded items

- RUN: `! grep -qE '\*\*S3-C9\*\* .{0,40}lifecycle\. Sound\.' docs/audit/audit-e2e/s3.md` -> exit:0
  — the "Sound" verdict on the lifecycle is gone.
- RUN: `grep -q 'liquidate_position.rs:157-163' docs/audit/audit-e2e/s3.md` -> exit:0
  — the recovery branch is cited.
- RUN: `grep -q 'liquidate_position.rs:337-362' docs/audit/audit-e2e/s3.md` -> exit:0
  — `close_liquidation_intent`, whose write the `Err` at `:162` reverts, is cited by line, not just by name (the name already appears elsewhere in the file).
- RUN: `grep -A8 '\*\*S3-C9\*\*' docs/audit/audit-e2e/s3.md | grep -qi 'not clear'` -> exit:0
  — the bullet carries the run's standard verdict for a class covered by a finding.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S3 routed` -> exit:0 match:"PASS S3 routed"
  — the new `S3-X` note to S11 sits under `## Cross-slice notes` and names its target slice.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S3 evidence` -> exit:0 match:"PASS S3 evidence"
  — every citation in the edited file still resolves; the fix did not introduce a dead path:line.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S3 cleared` -> exit:0 match:"PASS S3 cleared"
  — the negative-results section still accounts for every threat class with a resolving citation.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S3 records` -> exit:0 match:"PASS S3 records"
  — record ids still parse and are still unique after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S3 tag` -> exit:0 match:"PASS S3 tag"
  — the P0/P1-carries-exactly-one-tag rule still holds after the edit.
