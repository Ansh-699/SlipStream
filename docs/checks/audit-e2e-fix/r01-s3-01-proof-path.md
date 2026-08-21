# Check: r01-s3-01-proof-path — `S3-01`'s proof monetises a path that returns `OracleStale`

**Run:** `audit-e2e` (closing review) · **Issue draft:** `docs/review/audit-e2e/issues/r01-s3-01-proof-path.md`
**Spec pointer:** `docs/review/audit-e2e/review-spec.md` `### R-01 (P1)`

## Purpose

`S3-01` is a correct P0 with an unreproducible proof. This check grades that the proof no
longer routes the payout through `claim_funding`, that the `$91.32` oracle price is gone from
the claim arithmetic, and that `liquidate_position` — the path that does execute — is cited.

Every RUN item below is a single command that exits 0 or non-zero on its own; no reader
judgement is involved. Each item is falsifiable against the tree as it stands at `9316020`:
the "gone" items pass only once the defective text is removed and fail today, and the
"present" items pass only once the corrective text is written and fail today. Run from the
repository root.

What this check does **not** grade: whether the rewritten prose is *well written*. It grades
that the specific false or missing statement named in the review spec is no longer there and
that the frozen structural grader still passes on the edited file.

## Fix contract

A failure means the record still monetises through an instruction that errors `OracleStale`
on the reviewed deployment. The repair is to re-derive the figure through
`liquidate_position`, not to delete the money figure: the spec's calibration requires a
consequence stated in money.

The file(s) to edit are named in the issue draft and nowhere else. `docs/checks/**` stays
read-only; if a RUN item below is wrong *about the review spec*, that is a ruling for the
orchestrator, not a rewrite of this file.

## Graded items

- RUN: `! grep -q 'what each side then claims (claim_funding' docs/audit/audit-e2e/s3.md` -> exit:0
  — the `claim_funding`-denominated payout block is gone from `S3-01`.
- RUN: `! grep -q '1 SOL notional at the fresh mark' docs/audit/audit-e2e/s3.md` -> exit:0
  — the oracle-priced notional line, which `claim_funding` never computes, is gone.
- RUN: `awk '/^### S3-01 /,/^### S3-02 /' docs/audit/audit-e2e/s3.md | grep -q 'liquidate_position'` -> exit:0
  — `S3-01` now names the instruction that actually converts the poisoned index into `free_collateral`.
- RUN: `awk '/^### S3-01 /,/^### S3-02 /' docs/audit/audit-e2e/s3.md | grep -qE '\*\*Severity:\*\* P0'` -> exit:0
  — the severity is unchanged; this issue corrects a proof, it does not downgrade a finding.
- RUN: `! grep -qn 'MARK = 91_317_865' docs/audit/audit-e2e/repro/s3/live_positions.py` -> exit:0
  — the repro no longer prices a `claim_funding` computation at the oracle reading.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S3 evidence` -> exit:0 match:"PASS S3 evidence"
  — every citation in the edited file still resolves; the fix did not introduce a dead path:line.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S3 cleared` -> exit:0 match:"PASS S3 cleared"
  — the negative-results section still accounts for every threat class with a resolving citation.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S3 records` -> exit:0 match:"PASS S3 records"
  — record ids still parse and are still unique after the edit.
- RUN: `python3 docs/checks/audit-e2e/validate-findings.py S3 tag` -> exit:0 match:"PASS S3 tag"
  — the P0/P1-carries-exactly-one-tag rule still holds after the edit.
