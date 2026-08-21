# R-01 — Rewrite `S3-01`'s proof: it monetises a path that returns `OracleStale`

- **Severity:** P1
- **Blocked by:** none
- **Owns:** `docs/audit/audit-e2e/s3.md` (record `S3-01` only), `docs/audit/audit-e2e/repro/s3/funding_catchup.py`, `docs/audit/audit-e2e/repro/s3/live_positions.py`
- **Does not touch:** any program, keeper, or frontend source; any other record in `s3.md`; `docs/checks/`.

## Interface contract (published)

After this issue, `S3-01` states: the defect is unbounded premium x unbounded catch-up
intervals on a permissionless instruction (unchanged, P0, `[reachable-now]`); the money
path is `liquidate_position`, not `claim_funding`; and any figure denominated through
`claim_funding`/`close_position` is marked latched-until-crank. Downstream consumers of
this record (the orchestrator's filing step) can quote the money figure without it being
falsified by `S3-03`.

## What is wrong

`S3-01`'s defect and severity are correct and were re-derived in this review:
`compute_funding` has no signer check (`programs/slipstream/src/instructions/compute_funding.rs:19-25`),
`compute_funding_rate` applies no clamp to `(mark - index) / index`
(`programs/slipstream/src/math/funding.rs:22-26`), and `intervals` is an unclamped
`elapsed / interval_secs` (`programs/slipstream/src/instructions/compute_funding.rs:41`).

Its `**Proof.**` block is what fails. The block converts the poisoned index into money
under the heading "what each side then claims (claim_funding.rs:66-104)" and prices the
payment at "the fresh mark: \$91.32". Both halves are wrong:

1. `claim_funding` never reads the oracle. It reads
   `market.mark_price_for_close(now_ts)` at
   `programs/slipstream/src/instructions/claim_funding.rs:61-63`, which returns
   `last_mark_price` — the frozen \$74.11 — not the \$91.317865 the repro uses
   (`docs/audit/audit-e2e/repro/s3/live_positions.py:22`).
2. On the reviewed deployment that call returns `None`:
   `programs/slipstream/src/state/market.rs:173-182` returns `None` when the mark is
   stale, and `MARK_PRICE_MAX_STALENESS_MINS = 30`
   (`programs/slipstream/src/state/market.rs:16`) against a mark 16 days old. So
   `claim_funding` errors `OracleStale` and pays nothing.

`S3-03`, in the same file, already says this: "Every path by which the *owner* can act on
the same position — `close_position`, `claim_funding`, `execute_trigger`'s stop-loss — is
gated on `mark_price_for_close`, which is `None` whenever the crank is dead."
`live_positions.py:102-103` prints the same sentence for `close_position` and then uses
the oracle price for the funding claim anyway. The record contradicts its own slice.

The live money path exists and S3 owns it but never wired it to `S3-01`:
`liquidate_position` is permissionless, prices off `apply_dual_oracle`, realises funding
(`programs/slipstream/src/instructions/liquidate_position.rs:138-142`), folds it into
`total_settlement` (`:203-206`) and credits `UserAccount.free_collateral` (`:220-225`),
with no `mark_price_for_close` dependency anywhere in the file. Under a poisoned index
every short's `total_settlement` goes negative and drains `insurance_fund_balance` to zero
as bad debt (`:227-237`), while the long side's minted claim latches until the crank
resumes.

## Change skeleton

- `docs/audit/audit-e2e/s3.md`, record `S3-01` only:
  - `**Evidence:**` — add `programs/slipstream/src/instructions/liquidate_position.rs:203-237`.
  - `**Proof.**` — replace the "what each side then claims (claim_funding.rs:66-104)"
    block. Keep the catch-up arithmetic block (it is correct). Monetise through
    `liquidate_position`.
  - `**Blast radius.**` — split into the reachable-today consequence (index poisoning,
    shorts forced liquidatable, insurance fund to zero) and the latched consequence (the
    long side's claim, payable once `crank_twap` resumes), and restate any
    `claim_funding`-denominated figure at `last_mark_price`.
- `docs/audit/audit-e2e/repro/s3/funding_catchup.py` — drop or relabel the
  `claim_funding` section so its pasted output matches what the cited instruction computes.
- `docs/audit/audit-e2e/repro/s3/live_positions.py` — same for the credit/owed sums at
  `:110-112`.
- Severity, status, tag, and class are unchanged: P0 / CONFIRMED / `[reachable-now]` / `S3-C4`.

<!-- architect-run: audit-e2e -->
