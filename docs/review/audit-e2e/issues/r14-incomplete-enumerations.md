# R-14 — scope three `## Cleared` exhaustiveness claims to what was actually enumerated

- **Severity:** P3
- **Blocked by:** `r05-s3-c9-intent-rollback` (the `S3-C1` row shares `s3.md`)
- **Owns:** `## Cleared` bullets `S13-C5` (`s13.md`), `S3-C1` (`s3.md`), `S5-C3` (`s5.md`)
- **Does not touch:** any `## Findings` record; product source; `docs/checks/`.

## What is wrong

No defect sits behind any of these. The exhaustiveness claim is what is wrong, and an
exhaustiveness claim is the load-bearing part of a negative result.

- `s13.md` **S13-C5**: "the only infinite CSS animation in the app is `.live-dot`". Also
  `frontend/src/components/trading/positions-table.tsx:271` (`animate-pulse`) and
  `frontend/src/components/trading/session-panel.tsx:154` (`animate-spin`), both in S13's own
  owned set, both `… infinite` in Tailwind. Harmless in practice — the universal
  `prefers-reduced-motion` reset at `frontend/src/app/globals.css:305-313` catches them.
- `s3.md` **S3-C1**: "Enumerated every division in the slice". Misses
  `programs/slipstream/src/instructions/compute_funding.rs:41`
  (`let intervals = elapsed / interval_secs;`), which is in an owned file and truncates by up
  to a whole interval. Cited under `S3-01`, so nothing is lost.
- `s5.md` **S5-C3**: "clear on every reachable path". `verify_feeds` reads `market.pyth_feed`
  out of a `Market` that `crank_twap` never pins to `[SEED_MARKET, market_index]` —
  `grep -c SEED_MARKET programs/slipstream/src/instructions/crank_twap.rs` returns `0`, which
  is what `S1-X01` files. Constrained today (`market_count == 1`), which is why `S1-X01` is
  P2, but "clear on every reachable path" overstates the evidence.

## Change skeleton

- `s13.md` `S13-C5`: name the three infinite animations, or drop "the only".
- `s3.md` `S3-C1`: add `compute_funding.rs:41` to the enumeration with its `S3-01` pointer.
- `s5.md` `S5-C3`: qualify to "clear on every reachable path, given a canonically-derived
  `Market`", citing `S1-X01`.

<!-- architect-run: audit-e2e -->
