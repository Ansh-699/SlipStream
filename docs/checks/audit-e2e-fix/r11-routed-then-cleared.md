# Check: r11-routed-then-cleared — nine routed notes cleared away by their target slice

**Run:** `audit-e2e` (closing review) · **Issue draft:** `docs/review/audit-e2e/issues/r11-routed-then-cleared.md`
**Spec pointer:** `docs/review/audit-e2e/review-spec.md` `### R-11 (P2)`

## Purpose

Nine CONFIRMED cross-slice notes landed in a class the receiving slice then declared sound.
This check grades that each named bullet now mentions its inbound note, and that the
non-existent `K11` citation is gone.

Every RUN item below is a single command that exits 0 or non-zero on its own; no reader
judgement is involved. Each item is falsifiable against the tree as it stands at `9316020`:
the "gone" items pass only once the defective text is removed and fail today, and the
"present" items pass only once the corrective text is written and fail today. Run from the
repository root.

What this check does **not** grade: whether the rewritten prose is *well written*. It grades
that the specific false or missing statement named in the review spec is no longer there and
that the frozen structural grader still passes on the edited file.

## Fix contract

A failure means a `## Cleared` bullet still declares a class sound without addressing a
CONFIRMED note routed into it. Both answers are acceptable per bullet — reopen, or state the
scope reason — but the note id must appear in the bullet either way.

The file(s) to edit are named in the issue draft and nowhere else. `docs/checks/**` stays
read-only; if a RUN item below is wrong *about the review spec*, that is a ruling for the
orchestrator, not a rewrite of this file.

## Graded items

- RUN: `grep -A6 '\*\*S4-C8\*\*' docs/audit/audit-e2e/s4.md | grep -q 'S5-X03'` -> exit:0
  — `S4-C8` addresses the P1 routed into it.
- RUN: `grep -A8 '\*\*S9-C7\*\*' docs/audit/audit-e2e/s9.md | grep -q 'S1-X03'` -> exit:0
  — `S9-C7` addresses the legacy-credit button note.
- RUN: `grep -A8 '\*\*S12-C3\*\*' docs/audit/audit-e2e/s12.md | grep -q 'S5-X01'` -> exit:0
  — `S12-C3` stops clearing `README.md:242-244` as accurate without naming the note that falsifies it.
- RUN: `grep -A8 '\*\*S10-C10\*\*' docs/audit/audit-e2e/s10.md | grep -qE 'S7-X04|S9-X01|S8-X04'` -> exit:0
  — `S10-C10` addresses at least one of the three notes routed into it.
- RUN: `! grep -q 'K11' docs/audit/audit-e2e/s10.md` -> exit:0
  — the deflection to a known-state id the spec never defines is gone.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S10 evidence` -> exit:0 match:"PASS S10 evidence"
  — every citation in the edited file still resolves; the fix did not introduce a dead path:line.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S10 cleared` -> exit:0 match:"PASS S10 cleared"
  — the negative-results section still accounts for every threat class with a resolving citation.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S10 records` -> exit:0 match:"PASS S10 records"
  — record ids still parse and are still unique after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S10 tag` -> exit:0 match:"PASS S10 tag"
  — the P0/P1-carries-exactly-one-tag rule still holds after the edit.
