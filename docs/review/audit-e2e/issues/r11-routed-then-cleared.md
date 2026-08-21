# R-11 — nine routed notes were cleared away by the slice they were routed to

- **Severity:** P2
- **Blocked by:** `r02-s1-c8-false-clear` (the `S1-C8` row), `r06-s9-c2-xss-clear` (same file as the `S9-C7` row)
- **Owns:** `## Cleared` bullets `S1-C11` (`s1.md`), `S4-C8` (`s4.md`), `S9-C7` (`s9.md`), `S10-C5` and `S10-C10` (`s10.md`), `S12-C1` and `S12-C3` (`s12.md`), `S13-C2` (`s13.md`)
- **Does not touch:** any `## Findings` record; product source; `docs/checks/`.

## Interface contract (published)

After this issue, no `## Cleared` bullet in the run declares a class sound without
addressing the CONFIRMED cross-slice notes routed into it. A clearance that does not
mention an inbound note is not a negative result.

## What is wrong

| Note | Sev | Target class | The clearing sentence, and why it does not hold |
|---|---|---|---|
| `S5-X04` | **P0** | `S1-C8` | "the cap is enforced and cannot be raised without the owner's signature … holds on the L1 side" — see R-02 |
| `S5-X03` | P1 | `S4-C8` | "Found sound at `settle_from_log.rs:104-121`". S4's claim is memory safety; S5's P1 is field semantics (price, qty, margin applied unchecked). The class is named "Trust in ER-authored data" and the line ranges overlap |
| `S1-X03` | P2 | `S9-C7` | "`closeLegacyCredit` … refuses on a delegated legacy credit client-side … mirroring the program-side guard". It mirrors one of two guards. Per `S1-01`, `close_trading_credit` cannot succeed on **any** 56-byte credit (`programs/slipstream/src/state/trading_credit.rs:53-55`), so the branch S9 clears as correct — the undelegated one at `frontend/src/hooks/use-session.ts:961-977` — is the branch that always fails |
| `S6-X02` | P2 | `S13-C2` | S13 cites `frontend/src/components/trading/status-panel.tsx:70-76` as proof the panel is honest; S6 files those same lines as the defect — a divergence heuristic standing in for `Market.mark_price_minute` |
| `S5-X01` | P2 | `S12-C3` | "disclosed accurately and loudly in three places — … `README.md:242-244` — including the oracle-account-binding gap". `README.md:243` says binding is "Not validated"; `verify_feeds` (`programs/slipstream/src/oracle.rs:63-77`) is called on all three price paths (`oracle.rs:327`, `crank_twap.rs:37`), and `S5`'s own `S5-C3` says so "contrary to `README.md:243`" |
| `S3-X02` | P2 | `S1-C11` | "clean across the whole owned set … No unvalidated enum or flag byte exists". `funding_interval` is neither in the list nor range-checked at `initialize_market.rs:85-93`. A scope defence exists (the class is "Instruction-data parsing") — take it explicitly or reopen |
| `S7-X04`, `S9-X01`, `S8-X04` | P2/P3 | `S10-C10` | "Posture checked and sound otherwise". `docker-compose.yml`'s `restart: unless-stopped`, `next.config.ts` and `vercel.json` are all S10-owned and none is addressed |
| `S11-X01` | P3 | `S12-C1` | "**123 Rust tests, 25 unit + 98 Mollusk** (`PRODUCT.md:82`) **matches**". S12 counted files; `S11`, which owns `tests/unit/`, counted harnesses and says 38 of the 98 are not Mollusk |

Separately, `s10.md`'s `S10-C5` bullet deflects the routed `S11-X03` with "The integration
suite and the absence of any frontend test are K8/**K11** territory". **`K11` does not
exist** — `docs/spec/audit-e2e.md` §6 defines `K1` through `K8` only.

## Change skeleton

- For each row: rewrite the named `## Cleared` bullet to either a **not clear** verdict
  citing the note, or an explicit scope statement saying why the note falls outside the
  class. Both are acceptable answers; silence is not.
- `docs/audit/audit-e2e/s10.md`, bullet `S10-C5`: replace the `K11` citation with a real
  reference or delete the deflection and address `S11-X03`.
- No `## Findings` record is added, deleted, or regraded by this issue.

<!-- architect-run: audit-e2e -->
