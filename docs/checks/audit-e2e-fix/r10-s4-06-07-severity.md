# Check: r10-s4-06-07-severity — `S4-06` and `S4-07` share a precondition and a consequence

**Run:** `audit-e2e` (closing review) · **Issue draft:** `docs/review/audit-e2e/issues/r10-s4-06-07-severity.md`
**Spec pointer:** `docs/review/audit-e2e/review-spec.md` `### R-10 (P2)`

## Purpose

Two S4 findings need only "the ER authored the committed bytes" and both end in
`Position.collateral` credited with unbacked value, graded P0 and P1. This check grades that
the run answers the discrepancy one way or the other.

Every RUN item below is a single command that exits 0 or non-zero on its own; no reader
judgement is involved. Each item is falsifiable against the tree as it stands at `9316020`:
the "gone" items pass only once the defective text is removed and fail today, and the
"present" items pass only once the corrective text is written and fail today. Run from the
repository root.

What this check does **not** grade: whether the rewritten prose is *well written*. It grades
that the specific false or missing statement named in the review spec is no longer there and
that the frozen structural grader still passes on the edited file.

## Fix contract

A failure means the discrepancy stands unexplained. Either regrade `S4-07` to P0 with
`[mainnet-only]`, or add the sentence to `S4-06` explaining the difference. Silence fails.

The file(s) to edit are named in the issue draft and nowhere else. `docs/checks/**` stays
read-only; if a RUN item below is wrong *about the review spec*, that is a ruling for the
orchestrator, not a rewrite of this file.

## Graded items

- RUN: `awk '/^### S4-07 /,/^### S4-08 /' docs/audit/audit-e2e/s4.md | grep -qE '\*\*Severity:\*\* P0' || awk '/^### S4-06 /,/^### S4-07 /' docs/audit/audit-e2e/s4.md | grep -v '^### S4-07 ' | grep -q 'S4-07'` -> exit:0
  — `S4-07` is regraded, or `S4-06` explains why it is not.
- RUN: `awk '/^### S4-06 /,/^### S4-07 /' docs/audit/audit-e2e/s4.md | grep -q 'Pairs with:'` -> exit:0
  — `S4-06` points a reader at the sibling finding.
- RUN: `awk '/^### S4-07 /,/^### S4-08 /' docs/audit/audit-e2e/s4.md | grep -q 'settle_from_log.rs:117-120'` -> exit:0
  — the unbounded-`count` line is cited explicitly, not only the loop.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 severity` -> exit:0 match:"PASS S4 severity"
  — every record still carries exactly one severity from the four-level scale.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 proof` -> exit:0 match:"PASS S4 proof"
  — the CONFIRMED records still carry proof after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 evidence` -> exit:0 match:"PASS S4 evidence"
  — every citation in the edited file still resolves; the fix did not introduce a dead path:line.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 cleared` -> exit:0 match:"PASS S4 cleared"
  — the negative-results section still accounts for every threat class with a resolving citation.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 records` -> exit:0 match:"PASS S4 records"
  — record ids still parse and are still unique after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S4 tag` -> exit:0 match:"PASS S4 tag"
  — the P0/P1-carries-exactly-one-tag rule still holds after the edit.
