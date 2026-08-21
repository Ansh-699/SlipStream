# Check: r06-s9-c2-xss-clear — `S9-C2` clears the class its own `S9-05` sits in

**Run:** `audit-e2e` (closing review) · **Issue draft:** `docs/review/audit-e2e/issues/r06-s9-c2-xss-clear.md`
**Spec pointer:** `docs/review/audit-e2e/review-spec.md` `### R-06 (P1)`

## Purpose

`S9-C2` clears "XSS reachability of the session key" as Sound on a mechanism that an
`innerHTML` round-trip defeats, and on a sink enumeration that omits the sink the same slice
files as `S9-05`. This check grades both corrections.

Every RUN item below is a single command that exits 0 or non-zero on its own; no reader
judgement is involved. Each item is falsifiable against the tree as it stands at `9316020`:
the "gone" items pass only once the defective text is removed and fail today, and the
"present" items pass only once the corrective text is written and fail today. Run from the
repository root.

What this check does **not** grade: whether the rewritten prose is *well written*. It grades
that the specific false or missing statement named in the review spec is no longer there and
that the frozen structural grader still passes on the edited file.

## Fix contract

A failure means `s9.md` still tells a reader the docs origin is XSS-clean while carrying its
own P2 saying otherwise. The repair is a **not clear** verdict citing `S9-05` and one added
evidence line; `S9-05`'s severity is not this issue's to change.

The file(s) to edit are named in the issue draft and nowhere else. `docs/checks/**` stays
read-only; if a RUN item below is wrong *about the review spec*, that is a ruling for the
orchestrator, not a rewrite of this file.

## Graded items

- RUN: `! grep -q 'so graph source cannot break out' docs/audit/audit-e2e/s9.md` -> exit:0
  — the falsified escaping claim is gone.
- RUN: `grep -A8 '\*\*S9-C2\*\*' docs/audit/audit-e2e/s9.md | grep -q 'S9-05'` -> exit:0
  — the bullet now points at the slice's own finding in this class.
- RUN: `grep -A8 '\*\*S9-C2\*\*' docs/audit/audit-e2e/s9.md | grep -qi 'not clear'` -> exit:0
  — the verdict matches the run's standard shape.
- RUN: `awk '/^### S9-05 /,/^### S9-06 /' docs/audit/audit-e2e/s9.md | grep -q 'mermaid-runner.tsx:26-35'` -> exit:0
  — `S9-05` now cites the `innerHTML` round-trip lines, not only the `securityLevel` line at `:39` it already quotes in prose.
- RUN: `awk '/^### S9-05 /,/^### S9-06 /' docs/audit/audit-e2e/s9.md | grep -q 'dangerouslySetInnerHTML'` -> exit:0
  — the live sink is still named in the record that owns it.
- RUN: `awk '/^### S9-05 /,/^### S9-06 /' docs/audit/audit-e2e/s9.md | grep -oE '\`[A-Za-z0-9_./\[\]-]+\.(ts|tsx|rs|json|md):[0-9]+' | sed 's/^.//;s/:[0-9]*$//' | sort -u | while read f; do test -f "$f" || exit 1; done` -> exit:0
  — every path cited by the edited record resolves. Scoped to `S9-05` rather than the whole file: `S9-X03` cites `frontend/src/content/docs/**`, a build-time copy that the spec's R3 puts in scope but that a clean checkout does not contain, so the whole-file `evidence` item is environment-dependent.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S9 cleared` -> exit:0 match:"PASS S9 cleared"
  — the negative-results section still accounts for every threat class with a resolving citation.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S9 records` -> exit:0 match:"PASS S9 records"
  — record ids still parse and are still unique after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S9 tag` -> exit:0 match:"PASS S9 tag"
  — the P0/P1-carries-exactly-one-tag rule still holds after the edit.
