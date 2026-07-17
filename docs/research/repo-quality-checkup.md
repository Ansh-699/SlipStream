# SlipStream repo quality checkup — 2026-07-17

**Brief:** full-repo health check against `origin/master`, plus a prioritized list of
meaningful improvements (program, keepers, frontend, tests, ops) and worthwhile additions.
Verified locally at commit `638c4fe`; all findings below cite file:line.

## Sync + gate status (verified this session)

| Check | Result |
|---|---|
| `master` vs `origin/master` | **In sync** at `638c4fe` — nothing to pull/push |
| Rust unit tests (`tests/unit`) | **54/54 pass** |
| `cargo clippy -p slipstream` | **FAILS** — 10 deny-level errors, 20 warnings |
| Devnet program | Live at slot 475696012, matches HEAD (redeployed 2026-07-12) |
| CI workflows | **None** (`.github/workflows` absent) |
| LICENSE | **Missing** |
| TODO/FIXME markers | None (clean) |

Frontend tsc/eslint and keepers tsc were verified green (modulo the 4 pre-existing keeper
errors below) on 2026-07-11/12 at the same code; no source has changed since, so those
results stand. `node_modules` are currently uninstalled in both packages.

## P1 — money-path & operational correctness

### 1. `last_mark_price` has no freshness gate
`Market.last_mark_price` (state/market.rs:36) is written by `crank_twap`
(instructions/crank_twap.rs:61) and by fills, and `close_position` now settles off it
(instructions/close_position.rs:43). But nothing records *when* it was last updated —
if the TWAP keeper dies, closes silently settle at an arbitrarily stale price with no
on-chain error. The struct has only 2 spare padding bytes (`_padding2` bytes 4–5; bytes
0–3 hold the settlement cursor), so an `i64 last_mark_ts` needs either a truncated
timestamp scheme (e.g. u16 "minutes since last_funding_ts") or a layout append + market
re-init. Interim mitigation: off-chain keeper liveness alerting (see #4).

### 2. Keeper deploy-manifest resolution is broken under `tsx`
Defaults were written for the compiled `dist/` layout but keepers run via `npx tsx src/...`,
so `__dirname` is the source dir and every default resolves **one directory above the repo**
(observed live: `Deploy manifest not found at ".../slip-grant/deploy.json"`). Two
inconsistent conventions exist:
- `keepers/src/shared/manifest.ts:34` and `shared/bot-wallets.ts:408` — `../../../../deploy.json`
- `keepers/src/fund-user-usdc.ts:22`, `topup-takers.ts:33`, `verify-session.ts:60,65,70` — `../../../deploy.json` (also wrong from `src/`)

Fix once: a single shared resolver that walks up from `__dirname` until it finds
`deploy.json` (or honors `DEPLOY_MANIFEST`), used by all five files.

### 3. No CI
Tests, clippy, and typechecks only run when someone remembers. One GitHub Actions
workflow (cargo test + clippy + frontend/keepers `tsc --noEmit` + eslint) closes this —
and would have caught the keeper regressions in #6 at the PR that introduced them.

### 4. No keeper liveness monitoring
Keepers `console.log` crash-and-exit; nothing alerts when `crank_twap` stops (which is
what makes #1 dangerous). Minimal version: a heartbeat check comparing `last_mark_price`
drift/staleness on-chain and pinging (or just exiting non-zero under a process supervisor
with restart + alert).

## P2 — quality debt worth paying

### 5. `cargo clippy` is red (10 errors)
- 6× `clippy::mut_from_ref` at every `from_account_info_mut` (state/*.rs — market.rs:75,
  position.rs:48, user_account.rs:32, global_state.rs:33, trading_credit.rs:62,
  liquidation_intent.rs:39). Inherent to the Pinocchio unchecked-borrow pattern —
  annotate with `#[allow(clippy::mut_from_ref)]` + a safety comment.
- 4× `clippy::absurd_extreme_comparisons` — dead `data.len() < IX_DATA_LEN` checks where
  `IX_DATA_LEN == 0` (liquidate_position.rs:61, delegate_trading_credit.rs:106,
  close_user_account.rs:37, close_trading_credit.rs:49). Delete or fix the constants.
- 20 warnings (doc indentation, `map_or`, `abs_diff` in crank_twap.rs:45, manual range
  check in oracle.rs:41, 9-arg function). Then keep it green via CI (#3).

### 6. Pre-existing keeper tsc errors (4)
`check-funding.ts` property-name mismatch; missing `bs58` type declarations hit
`shared/accounts.ts` and `check-settlement-state.ts` (`npm i -D @types/bs58` or switch to
its typed export). Verified these predate all recent work.

### 7. No slippage protection on `close_position`
The close settles at whatever `mark_price_for_close()` returns at execution time; the
signer cannot bound it. A `min_acceptable_price`/`max_acceptable_price` (by side) in
instruction data is a small, non-breaking add (currently `_data` is unused —
close_position.rs:16).

### 8. Money-path instructions have no unit coverage
`mollusk-svm` is already a test dependency, but `tests/unit/src/test_instructions_simple.rs`
only asserts constants; close/liquidate/settle logic is exercised only by live-devnet
integration tests. Mollusk tests for `close_position` (profit, loss-exceeds-collateral,
insurance-fund drain) and `liquidate_position` would make regressions catchable offline.

## P3 — smaller / hygiene

- **Insurance-fund deficit is silent** — close_position.rs:90-96 zeroes the fund with no
  log/event; socialized losses are unauditable. Add a `pinocchio::log` line at minimum.
- **No LICENSE** — repo is legally all-rights-reserved; grant reviewers check this. MIT/Apache-2.0.
- **Frontend**: 2 pre-existing `as any` in `order-form.tsx`; docs have ~15 untagged code
  fences (no syntax highlighting on GitHub).
- **No partial close** — close_position is all-or-nothing; a `size` param (defaulting to
  full) is the natural UX add.

## Worthwhile additions (in rough value order)

1. **CI workflow** (also P1 #3) — highest leverage per line.
2. **Mollusk money-path tests** (P2 #8).
3. **Stop-loss / take-profit** — keeper-executed trigger orders; the LiquidationIntent
   two-step pattern already models keeper-executed actions to copy.
4. **Second market** — `market_index` plumbing exists end-to-end; a BTC-PERP proves the
   multi-market design isn't vestigial.
5. **Position/PnL history** — settle pipeline already emits FillEvents; an indexer table +
   frontend equity curve is mostly off-chain work.

## Open questions
- `last_mark_ts` layout: truncated-timestamp-in-padding vs. append+re-init — needs a
  decision before implementing P1 #1 on-chain.
- Whether keepers should be run compiled (`dist/`) in production; if yes, #2's resolver
  must handle both layouts (the walk-up approach does).
