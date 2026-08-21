# Check: r07-s10-01-overstated — `S10-01`'s blanket claim, its grep count, and its severity

**Run:** `audit-e2e` (closing review) · **Issue draft:** `docs/review/audit-e2e/issues/r07-s10-01-overstated.md`
**Spec pointer:** `docs/review/audit-e2e/review-spec.md` `### R-07 (P2)`

## Purpose

`S10-01`'s five roles are real. Its title claim is false for ten of thirteen keeper
instructions, its pasted grep output does not match its pasted command, and it grades the
same exposure `S7-04` grades P1. This check grades all three.

Every RUN item below is a single command that exits 0 or non-zero on its own; no reader
judgement is involved. Each item is falsifiable against the tree as it stands at `9316020`:
the "gone" items pass only once the defective text is removed and fail today, and the
"present" items pass only once the corrective text is written and fail today. Run from the
repository root.

What this check does **not** grade: whether the rewritten prose is *well written*. It grades
that the specific false or missing statement named in the review spec is no longer there and
that the frozen structural grader still passes on the edited file.

## Fix contract

A failure means the run still states a blanket property that its own remediation paragraph
contradicts, or publishes a number a reader can disprove in one command. Keeping P0 is an
acceptable outcome provided the record says why the spec's "compromised-in-practice" clause
applies here and not in `S7-04`.

The file(s) to edit are named in the issue draft and nowhere else. `docs/checks/**` stays
read-only; if a RUN item below is wrong *about the review spec*, that is a ruling for the
orchestrator, not a rewrite of this file.

## Graded items

- RUN: `! tr -s '[:space:]' ' ' < docs/audit/audit-e2e/s10.md | grep -q 'the signer gate on twelve instructions'` -> exit:0
  — the prose count now matches the eleven the grep returns; the pasted output must be corrected with it.
- RUN: `test "$(grep -rc 'global.authority != \*' programs/slipstream/src/instructions/*.rs | awk -F: '{s+=$2} END {print s}')" -eq 11` -> exit:0
  — the ground truth this item is graded against, restated so a future edit to the program is visible here.
- RUN: `awk '/^### S10-01 /,/^### S10-02 /' docs/audit/audit-e2e/s10.md | grep -qE 'crank_twap|compute_funding|mirror_fills'` -> exit:0
  — the record names at least one of the five keeper instructions that take no signer at all, so the title's scope is visible.
- RUN: `awk '/^### S10-01 /,/^### S10-02 /' docs/audit/audit-e2e/s10.md | grep -qE 'permissionless|fee payer|fee-payer'` -> exit:0
  — the record now states that most keeper instructions need no authority at all.
- RUN: `awk '/^### S10-01 /,/^### S10-02 /' docs/audit/audit-e2e/s10.md | grep -q 'S7-04'` -> exit:0
  — the record reconciles with the other slice that graded the same exposure.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S10 evidence` -> exit:0 match:"PASS S10 evidence"
  — every citation in the edited file still resolves; the fix did not introduce a dead path:line.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S10 cleared` -> exit:0 match:"PASS S10 cleared"
  — the negative-results section still accounts for every threat class with a resolving citation.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S10 records` -> exit:0 match:"PASS S10 records"
  — record ids still parse and are still unique after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S10 tag` -> exit:0 match:"PASS S10 tag"
  — the P0/P1-carries-exactly-one-tag rule still holds after the edit.
