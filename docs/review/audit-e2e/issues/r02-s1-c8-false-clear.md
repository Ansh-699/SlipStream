# R-02 — `S1`'s `S1-C8` clears the product's central safety claim by an argument delegation invalidates

- **Severity:** P1
- **Blocked by:** none
- **Owns:** `docs/audit/audit-e2e/s1.md` (`## Cleared` bullet `S1-C8` only)
- **Does not touch:** any program source; any `S1` finding record; `docs/checks/`.

## Interface contract (published)

After this issue, no `## Cleared` bullet in the run declares a class clean that another
slice has filed a P0 against. `S1-C8` reads as a **not clear** verdict citing `S5-X04`,
matching the shape `S5-C2`, `S5-C8`, `S5-C9`, `S5-C11` and `S4-C6` already use.

## What is wrong

The `S1-C8` bullet reads: "the cap is enforced and cannot be raised without the owner's
signature. `TradingCredit.credit` has exactly three writers in the program —
`fund_trading_credit.rs:70-74` … `withdraw_trading_credit.rs:57-58` … and
`reconcile_credit` … `README.md:44-50`'s 'capped, not unlimited' claim holds on the L1
side."

The enumeration is over program source. It is complete for the program and incomplete for
the account. `delegate_trading_credit` assigns the whole `TradingCredit` to the
delegation program (`programs/slipstream/src/instructions/delegate_trading_credit.rs:227-231`),
after which the ER owns every byte and writes them back on commit. The ER is a fourth
writer the enumeration does not contain, and L1 re-validates nothing:
`programs/slipstream/src/instructions/withdraw_trading_credit.rs:53-58` checks
`credit.credit >= amount` against the field itself, then
`:60-64` adds `amount` to `UserAccount.free_collateral`, which
`withdraw_collateral` pays out of the vault. `programs/slipstream/src/state/trading_credit.rs:27-46`
carries no `funded` high-water mark to compare against.

`S5` files exactly this against class `S1-C8`, at **P0**, as `S5-X04`
(`docs/audit/audit-e2e/s5.md`). The deliverable therefore contains a P0 in a class its
owning slice marks clean. `S1-C8` is the class the spec singles out as "the product's
central claim; treat a gap here as P0" (`docs/spec/audit-e2e.md`, S1 threat class 8), so
this is the worst place in the run for a false negative.

The bullet's closing sentence — "Whether the ER honours `credit.available()` is `S2-C11`,
not S1" — routes the question to a class that does not answer it. See R-03.

## Change skeleton

- `docs/audit/audit-e2e/s1.md`, `## Cleared`, bullet `S1-C8` only:
  - open with **not clear** — covered by `S5-X04`;
  - keep the three-writer enumeration but scope it explicitly to "writers in the program,
    while the account is undelegated";
  - state the fourth writer with the `delegate_trading_credit.rs:227-231` citation and the
    missing high-water mark at `state/trading_credit.rs:27-46`;
  - delete the `S2-C11` routing sentence.
- No other bullet, record, or file changes.

<!-- architect-run: audit-e2e -->
