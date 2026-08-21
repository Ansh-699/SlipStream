# R-09 — publish the distinct-defect P0 count alongside the record count

- **Severity:** P2
- **Blocked by:** `r08-dup-severity-fill-ring`
- **Owns:** the run's published totals; a `**Pairs with:**` line in records `S2-01`, `S2-X01`, `S5-01`, `S5-X04`
- **Does not touch:** any `**Severity:**` field; product source; `docs/checks/`.

## Interface contract (published)

After this issue the run publishes both numbers — record count and distinct-defect count —
so the P0 total cannot be read as ten separate defects.

## What is wrong

The run reports **10 P0**. Two pairs are two halves of one defect each, by the records' own
words:

- `S2-01` (P0) and `S2-X01` (P0). `S2-X01`'s `**What is wrong.**` opens "This is the
  consumer half of `S2-01`" and its `**Blast radius.**` reads "Identical to `S2-01`".
- `S5-01` (P0) and `S5-X04` (P0). `S5-X04`'s title is "(L1 half of `S5-01`)" and its
  `**Proof.**` is "See the exhaustive field grep pasted under S5-01".

Both splits are correct under §4's routing rule — the fix lands in another slice's file set —
and neither is padding. The defect is in the reporting: **eight** distinct P0 defects are
presented as ten, a 25% inflation of the run's most-quoted number. The eight are `S1-01`,
`S2-01`(+`S2-X01`), `S3-01`, `S4-01`, `S4-04`, `S4-06`, `S5-01`(+`S5-X04`), `S10-01`.

## Change skeleton

- Wherever the run's totals are published (the orchestrator's digest and the tracking issue
  #2 body), state "10 P0 records / 8 distinct P0 defects" rather than "10 P0".
- Add a `- **Pairs with:** <id>` line to each of the four records, immediately below
  `**Class:**`, so a reader of one half finds the other.
- No severity changes. No record is deleted.

<!-- architect-run: audit-e2e -->
