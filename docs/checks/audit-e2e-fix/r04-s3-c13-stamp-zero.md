# Check: r04-s3-c13-stamp-zero — the reachable `stamp == 0` window `S3-C13` calls unreachable

**Run:** `audit-e2e` (closing review) · **Issue draft:** `docs/review/audit-e2e/issues/r04-s3-c13-stamp-zero.md`
**Spec pointer:** `docs/review/audit-e2e/review-spec.md` `### R-04 (P1)`

## Purpose

`S3-C13` asserts the `stamp == 0` escape is "not reachable with a non-zero price". The cited
writer produces it one minute every 45.5 days. This check grades that the claim is retracted
and the defect is filed.

Every RUN item below is a single command that exits 0 or non-zero on its own; no reader
judgement is involved. Each item is falsifiable against the tree as it stands at `9316020`:
the "gone" items pass only once the defective text is removed and fail today, and the
"present" items pass only once the corrective text is written and fail today. Run from the
repository root.

What this check does **not** grade: whether the rewritten prose is *well written*. It grades
that the specific false or missing statement named in the review spec is no longer there and
that the frozen structural grader still passes on the edited file.

## Fix contract

A failure means the run still asserts a gate holds that a permissionless instruction can
switch off permanently. The repair is a new `S3` record plus a corrected bullet; downgrading
the new record below P1 is not a repair, because the gate stopping is a required path
stopping.

The file(s) to edit are named in the issue draft and nowhere else. `docs/checks/**` stays
read-only; if a RUN item below is wrong *about the review spec*, that is a ruling for the
orchestrator, not a rewrite of this file.

## Graded items

- RUN: `! tr -s '[:space:]' ' ' < docs/audit/audit-e2e/s3.md | grep -q 'escape at .:157-158. is not reachable with a non-zero price'` -> exit:0
  — the falsified unreachability claim is gone from the `## Cleared` bullet. (The file soft-wraps, so the text is normalised before matching.)
- RUN: `! tr -s '[:space:]' ' ' < docs/audit/audit-e2e/s3.md | grep -q 'unreachable with a non-zero price'` -> exit:0
  — and from the producer-contract block at the top of the file that restates it.
- RUN: `grep -q 'crank_twap.rs:75-76' docs/audit/audit-e2e/s3.md` -> exit:0
  — the line that writes a zero stamp beside a non-zero price is cited.
- RUN: `grep -q '65536' docs/audit/audit-e2e/s3.md` -> exit:0
  — the modulus that produces the window is stated, so a reader can re-derive it.
- RUN: `test "$(grep -cE '^\*\*Class:\*\* S3-C13|^- \*\*Class:\*\* S3-C13' docs/audit/audit-e2e/s3.md)" -ge 2` -> exit:0
  — `S3-C13` now carries at least two records: the existing `S3-02` and the new stamp-window finding.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S3 evidence` -> exit:0 match:"PASS S3 evidence"
  — every citation in the edited file still resolves; the fix did not introduce a dead path:line.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S3 cleared` -> exit:0 match:"PASS S3 cleared"
  — the negative-results section still accounts for every threat class with a resolving citation.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S3 records` -> exit:0 match:"PASS S3 records"
  — record ids still parse and are still unique after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S3 tag` -> exit:0 match:"PASS S3 tag"
  — the P0/P1-carries-exactly-one-tag rule still holds after the edit.
