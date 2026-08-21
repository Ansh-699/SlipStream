# R-07 — `S10-01`: fix the grep count, narrow the "cannot be split" claim, reconcile the severity with `S7-04`

- **Severity:** P2
- **Blocked by:** none
- **Owns:** `docs/audit/audit-e2e/s10.md` (record `S10-01` only)
- **Does not touch:** product source; `docs/audit/audit-e2e/s7.md`; `docs/checks/`.

## Interface contract (published)

After this issue, the run states the operator-key exposure once, at one severity, with a
split plan that says which instructions actually need a program change. `S7-04` and
`S10-01` stop disagreeing.

## What is wrong

The five roles are real; I re-derived all five, and `GlobalState.authority` /
`GlobalState.treasury` are a genuine addition to `K2`, which names three. Three defects:

1. **The headline claim generalises a property that holds for one keeper.** Of the thirteen
   instructions the keepers call, only three check `global.authority`:
   `record_pending_fill.rs:61`, `initialize_fill_log.rs:60`, `delegate_fill_log.rs:98`.
   Five take **no signer account at all** — `crank_twap`, `compute_funding`,
   `settle_trades`, `mirror_fills`, `settle_from_log`. Five take any signer as a fee payer —
   `liquidate_position.rs:57`, `execute_trigger.rs:40`, `cancel_order.rs:42`,
   `commit_fill_log.rs:60`, `commit_orderbook.rs:74`. Five of the six `docker-compose.yml`
   services and both bots can move to an unprivileged key today with no program change.
   The record's body and remediation both name those three correctly, which is to its
   credit. What neither states is the other half. As written, "the admin key is
   *structurally required* to be a hot key sitting on the keeper VM, mounted into six
   containers" reads as true of all six; it is true of one, and the title generalises
   with it.
2. **A pasted output its pasted command does not produce.** The record shows
   `grep -rn "global.authority != \*" programs/slipstream/src/instructions/ | wc -l` → `12`.
   It returns `11`, at this head and at the freeze `b98f050`.
3. **A severity the run contradicts.** `S7-04` files the operationally identical exposure at
   **P1**, with reasoning stated in the record: "That is a P0 outcome one host compromise
   away; it is filed P1 because the compromise is a precondition, not a demonstrated path."
   `S10-01` is **P0 `[reachable-now]`**, and the spec defines `[reachable-now]` as
   "exploitable or wrong on the live devnet deployment as it stands" — no capability here is
   exercisable without first stealing the key. The P0/P1 line is arguable under the spec's
   own "unbounded authority held by a compromised-in-practice key" clause; grading it two
   ways in one run is not.

## Change skeleton

- `docs/audit/audit-e2e/s10.md`, record `S10-01` only:
  - `**Proof.**` — correct `12` to `11` in both the pasted output and the prose, or change the
    pasted command to one that returns 12 (e.g. including `accept_authority.rs:52`'s
    pending-authority gate) and say so.
  - Prose — correct "the signer gate on twelve instructions" to eleven.
  - Title and `**What is wrong.**` — scope "the keeper role cannot be split off" to the
    fill-log keeper, and add the permissionless / fee-payer-only half as a table so a reader
    sees that ten of thirteen keeper instructions need no authority.
  - `**Severity:**` / `**Tag:**` — carry one grade with `S7-04`. If P0 is kept, state why the
    spec's "compromised-in-practice" clause applies here and not in `S7-04`, and drop
    `[reachable-now]` for `[mainnet-only]`.

<!-- architect-run: audit-e2e -->
