# Check: r14-incomplete-enumerations — three incomplete `## Cleared` enumerations

**Run:** `audit-e2e` (closing review) · **Issue draft:** `docs/review/audit-e2e/issues/r14-incomplete-enumerations.md`
**Spec pointer:** `docs/review/audit-e2e/review-spec.md` `### R-14 (P3)`

## Purpose

Three `## Cleared` bullets make exhaustiveness claims that are false as written. No defect
sits behind any of them; the claim is the defect, because an exhaustiveness claim is the
load-bearing part of a negative result.

Every RUN item below is a single command that exits 0 or non-zero on its own; no reader
judgement is involved. Each item is falsifiable against the tree as it stands at `9316020`:
the "gone" items pass only once the defective text is removed and fail today, and the
"present" items pass only once the corrective text is written and fail today. Run from the
repository root.

What this check does **not** grade: whether the rewritten prose is *well written*. It grades
that the specific false or missing statement named in the review spec is no longer there and
that the frozen structural grader still passes on the edited file.

## Fix contract

A failure means a negative result still overstates what was enumerated. The repair is to
scope the claim, not to delete the bullet.

The file(s) to edit are named in the issue draft and nowhere else. `docs/checks/**` stays
read-only; if a RUN item below is wrong *about the review spec*, that is a ruling for the
orchestrator, not a rewrite of this file.

## Graded items

- RUN: `! tr -s '[:space:]' ' ' < docs/audit/audit-e2e/s13.md | grep -q 'only infinite CSS animation in the app is'` -> exit:0
  — `S13-C5` no longer claims a single infinite animation. (Normalised: the file soft-wraps mid-claim.)
- RUN: `grep -A6 '\*\*S13-C5\*\*' docs/audit/audit-e2e/s13.md | grep -qE 'animate-pulse|animate-spin'` -> exit:0
  — the two it missed, both in S13's own owned set, are named.
- RUN: `grep -A6 '\*\*S3-C1\*\*' docs/audit/audit-e2e/s3.md | grep -q 'compute_funding.rs:41'` -> exit:0
  — `S3-C1`'s division enumeration includes the one it missed.
- RUN: `grep -A6 '\*\*S5-C3\*\*' docs/audit/audit-e2e/s5.md | grep -q 'S1-X01'` -> exit:0
  — `S5-C3` qualifies its reachability claim and cites the unpinned-`Market` note.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S13 cleared` -> exit:0 match:"PASS S13 cleared"
  — `S13`'s class coverage survives the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S13 evidence` -> exit:0 match:"PASS S13 evidence"
  — every citation in the edited file still resolves; the fix did not introduce a dead path:line.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S13 cleared` -> exit:0 match:"PASS S13 cleared"
  — the negative-results section still accounts for every threat class with a resolving citation.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S13 records` -> exit:0 match:"PASS S13 records"
  — record ids still parse and are still unique after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S13 tag` -> exit:0 match:"PASS S13 tag"
  — the P0/P1-carries-exactly-one-tag rule still holds after the edit.
