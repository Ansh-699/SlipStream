# R-10 — `S4-06` (P0) and `S4-07` (P1) share a precondition and a consequence

- **Severity:** P2
- **Blocked by:** none
- **Owns:** `docs/audit/audit-e2e/s4.md` (records `S4-06` and `S4-07` only)
- **Does not touch:** product source; `docs/checks/`.

## Interface contract (published)

After this issue, every S4 finding whose only precondition is "the ER authored the committed
bytes" carries the same severity and the same tag, or states why it does not.

## What is wrong

`S4-06` (**P0**, `[mainnet-only]`) and `S4-07` (**P1**) both need exactly one thing — an ER
that authors the committed `FillLog` / `FillEvent` bytes — and both end in the same place:
`Position.collateral` credited with value nothing debited.

`S4-07`'s mechanism is verified: `programs/slipstream/src/instructions/settle_from_log.rs:117-120`
bounds `capacity` against the account's data length and never bounds `count` by `capacity`;
the loop at `:129-131` indexes `(head + processed) % capacity`; and `last_settled` is read
once at `:97-100` and never updated inside the loop, so the `fill.sequence <= last_settled`
skip at `:139` cannot catch the second pass. A committed `count > capacity` therefore applies
the same `FillEvent` more than once in one call, each application adding `fill.filled_margin`
at `programs/slipstream/src/instructions/settle_trades.rs:331`.

## Change skeleton

- `docs/audit/audit-e2e/s4.md`, record `S4-07`: either regrade to `**Severity:** P0` with
  `**Tag:** [mainnet-only]`, or keep P1 and add one sentence to `**Blast radius.**` stating
  why the same precondition yields a lower grade than `S4-06`.
- `docs/audit/audit-e2e/s4.md`, record `S4-06`: add a `- **Pairs with:** S4-07` line.
- One of the two, not neither.

<!-- architect-run: audit-e2e -->
