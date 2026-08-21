# R-12 — the closing test pass records a false green on both frontend legs

- **Severity:** P2
- **Blocked by:** none
- **Owns:** the run's test-pass harness and `docs/runs/audit-e2e/closing-tests.txt`
- **Does not touch:** `docs/audit/audit-e2e/`; product source; `docs/checks/`.

## Interface contract (published)

After this issue, a test-pass leg whose toolchain is absent exits non-zero and is recorded as
"did not run", never as a pass. The next run that does change source inherits a harness that
cannot green on a no-op.

## What is wrong

`docs/runs/audit-e2e/closing-tests.txt` at `9316020`:

```
--- frontend tsc ---
                This is not the tsc command you are looking for
tsc_exit=0
--- frontend lint ---
--- frozen RUN items (all 13 slices) ---
```

That banner is the squatted `tsc` npm package, not `typescript`; no type-check ran. The
`--- frontend lint ---` section is empty; no lint ran. `frontend/node_modules` does not exist
in the checkout, and `frontend/package.json:46` declares `typescript: ^5` as a devDependency
that was never installed at this head. `tsc_exit=0` was recorded as a pass and relayed
downstream as "tsc clean, lint 17 pre-existing warnings" — those are the **baseline's**
numbers from `docs/runs/audit-e2e/baseline-tests.txt` at `698dd4f`, which record a real
`tsc --noEmit : exit 0` and `eslint : 0 errors, 17 warnings`.

Consequence for this run is nil. Run shape A is confirmed: `git diff 698dd4f..9316020`
touches `.gitignore` and `docs/{spec,checks,audit}/` only, so no frontend source changed and
nothing could have broken. The defect is that a leg of the closing evidence is a no-op
recorded as a pass.

## Change skeleton

- Test-pass harness: resolve `tsc` and `eslint` through `frontend/node_modules/.bin`; treat a
  missing binary as a non-zero exit; fail the leg rather than recording `exit=0`. Do not fall
  back to a globally-resolved binary of either name.
- `docs/runs/audit-e2e/closing-tests.txt`: append a correction stating the frontend legs did
  not execute at `9316020`, and that the frontend numbers on the record are the baseline's.
- No findings file changes.

<!-- architect-run: audit-e2e -->
