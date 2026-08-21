# Check: r02-s1-c8-false-clear — `S1-C8` clears the product's central safety claim

**Run:** `audit-e2e` (closing review) · **Issue draft:** `docs/review/audit-e2e/issues/r02-s1-c8-false-clear.md`
**Spec pointer:** `docs/review/audit-e2e/review-spec.md` `### R-02 (P1)`

## Purpose

The spec singles out `S1-C8` as "the product's central claim; treat a gap here as P0". The
run contains a P0 in that class (`S5-X04`) and a `## Cleared` bullet declaring it sound. This
check grades that the bullet no longer does.

Every RUN item below is a single command that exits 0 or non-zero on its own; no reader
judgement is involved. Each item is falsifiable against the tree as it stands at `9316020`:
the "gone" items pass only once the defective text is removed and fail today, and the
"present" items pass only once the corrective text is written and fail today. Run from the
repository root.

What this check does **not** grade: whether the rewritten prose is *well written*. It grades
that the specific false or missing statement named in the review spec is no longer there and
that the frozen structural grader still passes on the edited file.

## Fix contract

A failure means `s1.md` still tells a reader the credit cap holds. The repair is a
**not clear** verdict citing `S5-X04`, in the shape `S5-C2` / `S4-C6` already use — not a
deletion of the three-writer enumeration, which is correct as far as it goes.

The file(s) to edit are named in the issue draft and nowhere else. `docs/checks/**` stays
read-only; if a RUN item below is wrong *about the review spec*, that is a ruling for the
orchestrator, not a rewrite of this file.

## Graded items

- RUN: `! grep -q 'the cap is enforced and cannot be raised without the owner' docs/audit/audit-e2e/s1.md` -> exit:0
  — the unqualified clean verdict is gone.
- RUN: `! grep -q 'Whether the ER honours .credit.available().* is .S2-C11' docs/audit/audit-e2e/s1.md` -> exit:0
  — the deflection to a class that does not answer the question is gone.
- RUN: `grep -A6 '\*\*S1-C8\*\*' docs/audit/audit-e2e/s1.md | grep -q 'S5-X04'` -> exit:0
  — the bullet now names the routed P0.
- RUN: `grep -A6 '\*\*S1-C8\*\*' docs/audit/audit-e2e/s1.md | grep -q 'delegate_trading_credit.rs:227-231'` -> exit:0
  — the bullet now cites the fourth writer's origin.
- RUN: `grep -A6 '\*\*S1-C8\*\*' docs/audit/audit-e2e/s1.md | grep -qi 'not clear'` -> exit:0
  — the verdict word matches the shape the rest of the run uses for a class covered by a finding.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S1 evidence` -> exit:0 match:"PASS S1 evidence"
  — every citation in the edited file still resolves; the fix did not introduce a dead path:line.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S1 cleared` -> exit:0 match:"PASS S1 cleared"
  — the negative-results section still accounts for every threat class with a resolving citation.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S1 records` -> exit:0 match:"PASS S1 records"
  — record ids still parse and are still unique after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S1 tag` -> exit:0 match:"PASS S1 tag"
  — the P0/P1-carries-exactly-one-tag rule still holds after the edit.
