# Spec: `audit-e2e` — end-to-end audit of the Slipstream program

- **Run slug:** `audit-e2e`
- **Factory branch:** `factory/audit-e2e`
- **Base commit:** `698dd4f`
- **Audit base:** `d047658` (branch tip). The only delta from `698dd4f` is `.gitignore`
  (one hunk adding `docs/runs/` + `docs/jobs/`; owned by S10) and this spec file. Every
  slice audits the tree at the branch tip, not at `698dd4f`.
- **Stage:** hardened (strategist, adversarial-review). Issue drafts at
  `docs/runs/audit-e2e/issues/`, frozen checks at `docs/checks/audit-e2e/`.

---

## Assumptions (orchestrator rulings, intake)

Recorded per the timed-ruling protocol. All six strategist questions resolved to
their recommended defaults; three carry amendments.

1. **Severity baseline: mainnet threat model.** Every P0/P1 carries a mandatory
   `[reachable-now]` or `[mainnet-only]` tag. PRODUCT.md makes "don't foreclose
   mainnet" binding, and grading against devnet-actual would demote every
   money-path defect to P3 and make the audit worthless.
2. **Devnet access: read-only RPC yes, signer no.** A signer means on-chain
   mutation, which is Hard-Stop territory in a run whose shape is audit-only.
   *Amendment:* the orchestrator has already CONFIRMED the frozen-mark condition
   this session over read-only RPC — see section 6 evidence block. Findings that
   rest on it are CONFIRMED, not SUSPECTED.
3. **Local builds: yes, read-only. No network mutation, no deploys.**
   *Amendment:* the full Rust suite is `cargo test --workspace` (123 tests). The
   per-manifest form runs only 25. `target/deploy/slipstream.so` must exist or
   the Mollusk tests fail with "Program file not found"; it was built at intake.
4. **Findings artifact: `docs/audit/audit-e2e/<slice-id>.md`, one per slice.**
   *Amendment:* this path is COMMITTED — it is the run's deliverable. Only
   `docs/runs/` and `docs/jobs/` are gitignored.
5. **Filing granularity: P0/P1 individually, P2/P3 batched thematically.**
6. **`DESIGN.md` untracked: flag only, do not commit it.** Run shape is
   audit-only; committing it is a code change. Note for the digest: the
   orchestrator surfaced this to the human twice earlier and received no ruling,
   so it remains genuinely open, not an oversight.

**Run shape (auto-applied, 5m silence): A — audit-only.** No program, keeper, or
frontend source is modified by this run. Confirmed findings are filed as
sub-issues of #2 and become the input for any follow-up fix run.

**Builder isolation:** the wave runs without per-slice worktrees — auditors are
read-only over source and write one findings file each at disjoint paths, so
worktrees buy no conflict protection. Recorded, not silently substituted.


## 1. What this run produces

This run's deliverable is **evidence, not code**.

A builder assigned a slice of this spec does **not** change product behaviour. It reads
its owned file set, reproduces or disproves defects, and writes exactly one findings
artifact. The orchestrator then converts confirmed findings into tracker issues, which a
*later* run fixes.

Per-slice deliverable — one file, path fixed:

```
docs/audit/audit-e2e/<slice-id>.md
```

`<slice-id>` is **lowercase**: `s1.md` … `s13.md`. Nothing else. Record identifiers
inside the file are **uppercase** (`S1-01`, `S1-X01`) — see §4. The frozen check
resolves the path literally; `S1.md`, `s01.md`, and `s1-authorization.md` all fail.

The only files a slice may create or modify are its own findings file and, where a
finding needs a reproduction, files under `docs/audit/audit-e2e/repro/<slice-id>/`.
**Any diff touching product code, tests, or docs outside those two paths fails the
slice.** A slice that believes a fix is trivial still does not apply it; it writes the
fix as a `Suggested remediation` line inside the finding.

Rationale (`codebase-design`: *interface*): the findings file is the slice's interface.
Thirteen auditors run in parallel and never read each other's work, so the record format
below is the entire contract that makes their output mergeable.

---

## 2. Calibration — reproduce verbatim in every slice

Every slice operates under this single calibration statement. It is quoted here once and
is binding on all thirteen:

> Flag only gaps that affect correctness, the stated requirements, or documented project invariants -- cite file:line evidence for every finding. Do not report stylistic preferences.

Consequences that are not negotiable:

- No findings about formatting, naming, import order, comment density, file length,
  `clippy`/`eslint` opinions already suppressed on purpose, or "this could be more
  idiomatic."
- No findings that restate a limitation the repo already documents as a known
  limitation, unless the audit shows the documented mitigation does not actually hold.
  See §6 (Known state) for the list that is already on the record.
- No architectural preference findings ("this should have used Anchor", "this should be
  an AMM", "split this crate"). The architecture is a given.
- A finding with no `file:line` is not a finding. It is deleted before merge.

### The calibration example — what a genuine finding looks like

`Cargo.toml:8-13` records a real, already-fixed defect of exactly the class this run
hunts. `[profile.release]` sat in the non-root member manifest
`programs/slipstream/Cargo.toml`; Cargo silently ignores `[profile.*]` outside the
workspace root, so `overflow-checks` was **off** in the deployed program and arithmetic
wrapped instead of aborting. Nothing errored. Nothing was slow. Nothing looked wrong.

That is the bar. A finding of this class has all four properties, and a slice should ask
them of every candidate before filing it:

1. a written invariant it violates (here: "the program aborts on overflow"),
2. a mechanism explaining *why* nothing surfaced it,
3. a `file:line` that a reader can open and see the defect at, and
4. a consequence stated in money or in a wrong number, not in adjectives.

A candidate that fails (2) is usually a stylistic preference in disguise.

---

## 3. Severity scale

Four levels. Every finding carries exactly one.

| Sev | Name | Bar |
|---|---|---|
| **P0** | Exploitable / funds at risk | An actor who is not the account owner can move, mint, destroy, or permanently freeze value; or the program can be driven into a state where a user's collateral is unrecoverable. Includes: signer-check bypass, PDA substitution reaching the vault, arithmetic that mints value from nothing, unbounded authority held by a compromised-in-practice key. |
| **P1** | Correctness / availability | The system computes or displays a materially wrong number, or a required path stops working. Includes: wrong PnL/funding/health/liquidation price, byte-offset drift producing wrong displayed values, matching-engine priority violations, a keeper class that cannot recover from a foreseeable failure, a route that 500s on a normal input. |
| **P2** | Hardening | No known exploit path today, but a defence is missing or a bound is absent that a small change in the environment would make exploitable. Includes: missing account-ownership assertion where the value is currently constrained by another check, absent rate limit, unvalidated input that is currently always well-formed. |
| **P3** | Hygiene | Correct today and safe today, but carries real future risk or blocks verification. Includes: an untested money path, a doc that describes behaviour the code no longer has, a dependency advisory with no reachable path. |

### The devnet qualifier

Slipstream is deployed to devnet and the tokens are worthless. Severity is nevertheless
assessed **against the mainnet threat model**, because `PRODUCT.md` states "Don't
foreclose mainnet" as a binding product principle and lists a mainnet path as a success
definition. Assessing against devnet-only stakes would grade every money-path defect as
P3 and make the audit worthless.

To keep this honest, every P0 and P1 additionally carries one tag:

- `[reachable-now]` — the defect is exploitable or wrong on the live devnet deployment as
  it stands.
- `[mainnet-only]` — the defect is inert on devnet (worthless tokens, single trusted
  operator, no adversarial volume) but would be P0/P1 on a real-money deployment.

Do not downgrade severity to express this. Use the tag.

---

## 4. Findings document format

### 4.0 Document skeleton — four headings, exactly these strings

The frozen check greps for these four literal level-2 headings. All four are required
even when a section's body is `None.`:

```markdown
# S<n> — <slice title>

## Calibration
> <the §2 sentence, verbatim — the check compares it byte for byte>

## Findings
### S<n>-01 · ...        <- one record per finding, ids zero-padded and sequential

## Cross-slice notes
### S<n>-X01 · ...       <- records ROUTED ELSEWHERE. Note the `X`.

## Cleared
- **S<n>-C1** <what was checked, and a resolving `path:line`>
- ... one bullet per threat class in this slice's list, no exceptions
```

A cross-slice note carries the **authoring** slice's prefix with an `X` infix
(`S5-X01`, authored by S5), a `- **Routed to:** S3` line, and the **target** slice's
class id in its `Class` field. This is what lets the merge step distinguish a slice's
own findings from its routed notes mechanically. An `X` record placed above the
`## Cross-slice notes` heading fails the check.

### 4.1 Record shape

Every finding in every slice file is one record in exactly this shape. Anything
that does not parse as this shape is dropped at merge.

```markdown
### <SLICE-ID>-<NN> · <one-line title>

- **Status:** CONFIRMED | SUSPECTED
- **Severity:** P0 | P1 | P2 | P3
- **Tag:** [reachable-now] | [mainnet-only]     <!-- P0/P1 only; ABSENT for P2/P3 -->
- **Class:** <one class id from docs/checks/audit-e2e/classes.tsv>
- **Evidence:** `path/to/file.rs:120-134`  (one or more; repo-root-relative paths)

**What is wrong.** Two to five sentences. State the invariant that is violated and
where the invariant is written down (a doc line, a code comment, a test, or a
`PRODUCT.md`/`README.md` claim). If no invariant is written down anywhere, say so —
an unwritten invariant is itself a finding at P3.

**Proof.** For CONFIRMED: the reproduction. One of —
  (a) a runnable command plus its actual output, pasted;
  (b) a failing assertion added under `docs/audit/audit-e2e/repro/<slice-id>/` and its
      output (this is scratch code, never wired into the real test suites);
  (c) a live on-chain account read (address + fetched bytes/decoded values + timestamp);
  (d) a byte-for-byte layout table where the two sides disagree.
For SUSPECTED: state precisely what would settle it and why it could not be settled
here (needs a devnet signer this run does not hold, needs an ER validator, etc.).

**Blast radius.** Who is harmed, how much, and under what precondition.

**Suggested remediation.** One to three sentences. Do not implement it.
```

### CONFIRMED vs SUSPECTED

- **CONFIRMED** requires proof in the sense above. Reading the code and being sure is
  *not* proof. "The signer check is missing on line 44" is CONFIRMED only if you also
  show the guard is absent on every path into that function — a grep of all callers
  pasted into the record satisfies this for a static claim.
- **SUSPECTED** is a first-class outcome and is not a failure. A slice that returns six
  well-argued SUSPECTED findings with precise settlement criteria is more valuable than
  one that returns six CONFIRMED findings by lowering the bar for "confirmed."
- Guessing a severity you cannot defend is worse than filing at P2 with a note.

### Cross-slice notes

An auditor may **read the entire repository** — they must, to understand their own
slice. But a finding may only be *filed* against a file in that slice's owned set.

If auditor A finds a defect in a file owned by slice B, A appends it to a
`## Cross-slice notes` section at the end of their own file, in the same record format,
with a `**Routed to:** <slice-id>` line. The orchestrator forwards it. A is not graded
on it and B is not penalised for not having found it independently. This is what keeps
the file sets disjoint without blinding anyone.

### Negative results are required

Each slice's findings file ends with a `## Cleared` section listing, **per threat class
id in `docs/checks/audit-e2e/classes.tsv` for that slice**, what was checked and found
sound, with a `path:line` that resolves. An audit that reports only positives is
unfalsifiable. A slice with zero findings in a class must show it looked.

The check greps for each class id literally and then requires a resolving `path:line`
within the id's line or the two lines after it. A class covered by a filed finding still
needs its `## Cleared` bullet — write "covered by S5-01" plus the citation.

### The minimum-one-finding rule

§6 establishes defects that are already on the record. Six slices own the code half of
one of them, so a zero-finding return from any of them is a failure to look, not a clean
result. The frozen check enforces `>= 1` own finding (cross-slice notes do not count) for:

| Slice | Established state it owns |
|---|---|
| S5 | K5 — the half-delegated deadlock's root cause in program code |
| S6 | K7 — the twice-vendored SDK, byte half |
| S7 | K1 — why a 17-day keeper outage was possible |
| S8 | K3 — the faucet's mint authority in a server route |
| S10 | K2 — the operator key holding three capabilities at once |
| S12 | the pre-admitted stale onboarding flow, and the §6 doc/behaviour splits |

The other seven slices may legitimately return zero findings if their `## Cleared`
section is complete. Nothing in this rule licenses inventing a finding: a slice that
genuinely cannot produce one files a `P3` recording what it looked for and why the
established state does not reach its owned file set — that is a defensible answer and
the check accepts it.

---

## 5. File partition

The partition is **total and disjoint over all 251 audited tracked files**. Every audited
tracked file has exactly one owner.

`git ls-files | wc -l` returns **252** at the branch tip, not 251 — the run's own spec
file is tracked and is not audited, and the frozen checks add more under
`docs/checks/audit-e2e/`. The stable verification command excludes run artifacts:

```bash
git ls-files | grep -vE '^docs/(spec|checks|audit|runs|jobs)/' | wc -l    # 251
```

One clause of "exactly one owner" is qualified: S11 owns test code wherever it lives, so
the inline `#[cfg(test)]` modules inside `programs/slipstream/src/**` are S11's to assess
while the production code in those same files stays with S1–S5. That is an ownership
split *within* files, not a second writer of them — no slice writes source at all, so it
creates no collision. It is the only such split.

Two global rules resolve the boring cases:

- **R1 — build and dependency manifests belong to S10.** Every `package.json`,
  `package-lock.json`, `tsconfig.json`, `Cargo.toml`, `Cargo.lock`, `Anchor.toml`,
  `rustfmt.toml`, `eslint.config.mjs`, `postcss.config.mjs`, `components.json`,
  `next.config.ts`, `vercel.json`, `.gitignore`, `.dockerignore`, `Dockerfile`,
  `docker-compose.yml`, `deploy.json`, `LICENSE`, `.github/**`, and
  `frontend/scripts/*.mjs` — wherever it lives — is owned by S10, not by the slice whose
  directory it sits in.
- **R2 — all prose belongs to S12.** Every `*.md` outside `docs/audit/` and
  `docs/spec/` is owned by S12, including every `README.md` in every subdirectory.

Binary assets (`frontend/assets/*.png`, `frontend/public/*.png`,
`frontend/src/app/*.png`) are **out of scope for defect findings**; S10 owns them for
licensing/provenance only.

`docs/spec/audit-e2e.md` (this file) and everything under `docs/audit/` are run
artifacts and are not audited.

### R3 — three in-scope artifacts are not tracked files

Verified at `698dd4f`. Each is in scope for its named slice, and each carries a finding
obligation about its untracked status:

| Path | State | Slice | Obligation |
|---|---|---|---|
| `DESIGN.md` | untracked working-tree file | S12 | `PRODUCT.md` names `brand.md` the binding identity record; `DESIGN.md` restates the design system and is **not committed**. Audit its content, and file the uncommitted status as its own finding. |
| `frontend/src/content/docs/**` (10 `.md`) | generated by `frontend/scripts/copy-docs.mjs` | S12 | Not a tracked mirror — a build-time copy. The drift risk is in the generator and in whether the deployed site's docs match `docs/`. Audit the generator's behaviour, not the checked-in bytes (there are none). |
| `frontend/src/lib/deploy-manifest.generated.json` | generated by `frontend/scripts/copy-manifest.mjs` | S8 (consumption), S10 (generation) | The entire frontend's program/market/mint addresses come from a file no one reviews. Audit what happens when the copy step is stale, absent, or silently no-ops. |

Everything else untracked or generated is out of scope: `node_modules/`, `target/`,
`.next/`, `.playwright-mcp/`, `.impeccable/`, `keepers/data/`, `docs/runs/`,
`docs/jobs/`, `frontend/tsconfig.tsbuildinfo`, `frontend/.env.local` (its *handling* is
audited by S10; its contents are never published into a findings file).

### Verification

The partition was re-checked mechanically at harden against `git ls-tree -r 698dd4f`:
251 tracked files, **zero overlaps, zero unassigned**. Confirmed.

Slice sizes after the S9 split (below): S1 22, S2 6, S3 14, S4 7, S5 11, S6 11, S7 32,
S8 6, S9 22, S10 44, S11 30, S12 18 (+2 untracked per R3), S13 28. Total 251.

**S9 was split.** At draft, S9 was 50 files / 8,342 lines and carried an obligation to
source-trace *every number rendered by the trading components* — the largest single
reading load in the run, on the slice whose deliverable is the most skimmable. It is now
two slices with disjoint file sets:

- **S9** — session-key custody and transaction integrity: `components/wallet/**`,
  `app/auth/callback/`, the docs renderer (`app/docs/**`, `lib/docs.ts`),
  `lib/confirm.ts`, `lib/utils.ts`, and all 11 `hooks/*.ts`. 22 files.
- **S13** — rendered-data honesty and the accessibility floor: `app/layout.tsx`,
  `app/page.tsx`, `app/globals.css`, `app/trade/page.tsx`, `app/landing/page.tsx`,
  `components/landing/`, `components/theme-toggle.tsx`, `components/trading/*.tsx` (14),
  `components/ui/*.tsx` (7). 28 files.

The seam is real: S9 owns where a value *comes from* and what the client is able to
sign; S13 owns what the screen *says about it*. S13 reads the hooks to build its
per-number source table — cross-slice reading is unrestricted (§4) — and routes any
defect it finds *in* a hook to S9 as a cross-slice note.

The draft's `frontend/src/components/ui/*.tsx (6 files)` was wrong: there are **7**
(`badge`, `button`, `card`, `liquid-glass-button`, `liquid-weather-glass`, `separator`,
`table`). The draft's 50-file S9 total was right; only the parenthetical was wrong.

---

## 6. Known state — given inputs, not discoveries

Every auditor reads this section before starting. These facts are **established**. Do
not spend the slice re-deriving them and do not file them as novel findings. Each slice's
§7 says what it must *add* to the corresponding fact.

**K1 — the keepers have been down since 2026-08-05.** `market.last_mark_price` is frozen
at `$74.11` while the Pyth feed the market is configured with reads `$91.85` fresh.
`crank_twap` is the only writer of `last_mark_price`. The apparent root-cause chain:
public devnet RPC quota exhausted → keepers crash-looped → pm2 gave up at
`max_restarts: 50` (`keepers/ecosystem.config.js:33`).

**K2 — operator key concentration.** `A5sV4Pkk…` is simultaneously the program upgrade
authority, the USDC mint authority, and the faucet signer. `PRODUCT.md` lists splitting
it as an open, undecided question.

**K3 — the faucet holds mint authority in a server route.**
`frontend/src/app/api/faucet/route.ts` mints devnet USDC from that key.

**K4 — the devnet order book holds 16-day-old resting orders**, consistent with K1.

**K5 — half-delegated TradingCredits.** The `mm-0`/`mm-1`/`taker-0`/`taker-1` bot
credits are stuck: L1 reports them delegated so `fund_trading_credit` refuses, while the
ER never took ownership so the delegation program refuses to undelegate. The workaround
in tree is fresh wallet prefixes (`mm-v2`, `taker-v2`) — see `BOT_MM_PREFIX`
at `keepers/ecosystem.config.js:59` and `BOT_TAKER_PREFIX` at
`keepers/ecosystem.config.js:73`, plus `keepers/.env.example`.

**K6 — already-mitigated surfaces.** Do not report these as missing; report only
residual gaps in them, with the existing mitigation quoted:
- `/api/rpc/[layer]` has a JSON-RPC method allowlist, a 100 KB body cap, a 20-call batch
  cap, `Object.hasOwn` layer lookup, and deliberately logs upstream errors server-side
  only.
- `/api/faucet` has a per-wallet cooldown, a global hourly cap, a SOL top-up floor, and a
  fixed mint amount.
- CI runs `cargo audit` and does *not* run `npm audit`; `.github/workflows/ci.yml:47-52`
  states this is deliberate and why.
- The two `clippy -A` suppressions are documented in `README.md` as intentional.

**K7 — the SDK is vendored twice.** `frontend/src/lib/slipstream/` is a hand-copied
vendor of `client/src/`, with a header comment saying "Keep in sync with the SDK." The
copies have already diverged in surface area (the frontend copy lacks the FillLog
decoders and constants the SDK exports; it adds `orderbook.ts` the SDK does not have).
Divergence in *surface* is established. Divergence in *byte offsets* is not, and is S6's
primary job.

**K8 — self-reported test baseline.** 98 `#[test]` functions under `tests/unit/src/` and
25 inline in `programs/slipstream/src/`, totalling the "123 passing Rust tests" claimed
in `PRODUCT.md`. The integration suite under `tests/integration/` is not run by CI.

---

## 7. The thirteen slices

Each slice below gives: the **module** under audit and its **interface** (the seam its
correctness is judged at), the **exact owned file set**, the **threat/defect classes**
that must be covered, and **done**.

### Class ids are normative

Every numbered threat class in the lists below has the stable id `<SID>-C<n>` — the
first class under S3 is `S3-C1`, the eleventh under S7 is `S7-C11`. The complete
enumeration lives at **`docs/checks/audit-e2e/classes.tsv`** and that file, not this
prose, is what the frozen check reads. If the two ever disagree, the TSV wins and the
disagreement is itself a defect to raise as a ruling.

Those ids are what make `## Cleared` gradeable: without them "names every threat class"
is unfalsifiable prose, and a check cannot tell a complete negative-results section from
an empty gesture.

`Done` is the same skeleton everywhere and is stated once, then specialised:

> **Done (all slices):** `docs/audit/audit-e2e/s<n>.md` exists (lowercase); it carries
> the four §4.0 headings; the §2 calibration sentence is reproduced verbatim; every
> record parses as §4.1; every record's `Class` is one of this slice's ids in
> `classes.tsv`; every record's `Evidence` carries at least one `path:line` that
> resolves to a real file at a line that exists; every CONFIRMED carries proof of a §4
> type; every P0/P1 carries exactly one tag and every P2/P3 carries none; the
> `## Cleared` section accounts for every class id with a resolving citation; the six
> slices under the minimum-one-finding rule have at least one own finding; and the
> working tree contains no diff outside `docs/audit/audit-e2e/`, `docs/runs/`, and
> `docs/jobs/`.

---

### S1 — Program authorization and the L1 money path

**Module.** The instruction dispatcher plus every instruction that creates an account,
moves collateral into or out of the L1 vault, or changes who is allowed to act.
**Interface.** "Only the owner moves money; a session key trades and nothing else"
(`PRODUCT.md`, Operating Context; `docs/06-session-keys.md`). S1 owns the *definition* of
this boundary; S2 checks that `place_order`/`cancel_order` honour it.

**Owned files (22).**
```
programs/slipstream/src/lib.rs
programs/slipstream/src/error.rs
programs/slipstream/src/instructions/mod.rs
programs/slipstream/src/instructions/initialize_global.rs
programs/slipstream/src/instructions/initialize_market.rs
programs/slipstream/src/instructions/initialize_user.rs
programs/slipstream/src/instructions/initialize_position.rs
programs/slipstream/src/instructions/initialize_trading_credit.rs
programs/slipstream/src/instructions/deposit_collateral.rs
programs/slipstream/src/instructions/withdraw_collateral.rs
programs/slipstream/src/instructions/fund_trading_credit.rs
programs/slipstream/src/instructions/withdraw_trading_credit.rs
programs/slipstream/src/instructions/close_trading_credit.rs
programs/slipstream/src/instructions/close_user_account.rs
programs/slipstream/src/instructions/authorize_session.rs
programs/slipstream/src/instructions/propose_authority.rs
programs/slipstream/src/instructions/accept_authority.rs
programs/slipstream/src/instructions/set_market_oracle.rs
programs/slipstream/src/state/mod.rs
programs/slipstream/src/state/global_state.rs
programs/slipstream/src/state/user_account.rs
programs/slipstream/src/state/trading_credit.rs
```

**Threat / defect classes.**
1. **Missing or bypassable signer check.** For each owned instruction, enumerate every
   account and state which of `is_signer`, owner-equality, and PDA-derivation is
   asserted. Produce the table even where nothing is wrong — it is the `## Cleared`
   evidence.
2. **Account-ownership validation.** Does every account read as program state assert
   `account.owner() == program_id`? A missing check is P2 minimum, P0 where the account
   determines a transfer amount or destination.
3. **Discriminator validation.** Can an account of type X be passed where type Y is
   expected? Pinocchio does no automatic type checking; `state/mod.rs` defines the
   `DISC_*` constants — verify each load site checks one.
4. **PDA seed correctness and substitution.** Can a caller supply a PDA derived from a
   *different* owner, market, or bump and have it accepted? Check bump handling
   specifically (canonical vs. supplied bump).
5. **The owner-vs-session-key boundary.** `authorize_session.rs` defines it. Confirm no
   owned instruction accepts a session key in place of `owner`. Publish the boundary as a
   contract in the findings file so S2's result can be read against it.
6. **Vault accounting.** `deposit_collateral` / `withdraw_collateral`: does the token
   transfer amount always equal the `free_collateral` delta? Any path where one succeeds
   and the other does not, or where they disagree, is P0.
7. **Account-closing safety.** `close_user_account` / `close_trading_credit`: lamport
   drain, rent refund destination, re-initialisation after close (the classic revival
   attack), and whether closing can strand value.
8. **`fund_trading_credit` capping.** `PRODUCT.md` positions the cap as the safety
   property of the whole system. Verify the cap is enforced on-chain and cannot be
   raised without the owner's signature. This is the product's central claim; treat a
   gap here as P0.
9. **Authority rotation.** `propose_authority`/`accept_authority` two-step: can the
   proposed authority be set to a key that can never accept (bricking rotation), can a
   stale proposal be accepted later, is the current authority checked on both legs.
10. **Global pause.** `ensure_not_globally_paused` is defined in `instructions/mod.rs`
    with a comment claiming "non-trivial trading instructions" call it. Verify which
    instructions actually call it across the whole program (a repo-wide grep is in
    scope; findings against non-owned files go to Cross-slice notes).
11. **Instruction-data parsing.** Every `process` in the owned set: short-buffer panics,
    unchecked slice indexing, unvalidated enum/flag bytes.
12. **CPI target validation and duplicate-account aliasing.** *(added at harden — this
    class fell between S1 and S5 and was owned by nobody.)* Two sub-questions, both
    classic Solana defect classes that no draft slice named:
    - **CPI target.** The token program account is bound but discarded:
      `deposit_collateral.rs:23` and `withdraw_collateral.rs:34` both destructure it as
      `_token_program`, so nothing in the owned set asserts it is the real SPL Token
      program. Determine whether the `pinocchio-token` CPI hardcodes the program id (in
      which case this is `## Cleared` evidence, and say so with the `file:line` in the
      dependency that does it) or whether it forwards the supplied account (P0). Do the
      same for every other CPI the owned set makes, system program included. Extend to
      the mint: does anything assert the deposited mint equals the market's collateral
      mint, and would a Token-2022 transfer-fee mint break the deposit/withdraw equality
      of class 6?
    - **Duplicate-account aliasing.** For every instruction that takes two or more
      accounts of the same type — vault and user token account, owner and destination,
      `from` and `to` on a close — can the *same* account be passed for both? Pinocchio
      does no distinctness checking. Where aliasing lets a balance be double-counted or a
      rent refund be paid to the drained account, that is P0.

**Adds to known state.** K2 is the operational half of authority concentration; S1 owns
the *on-chain* half — what `GlobalState.authority` can actually do, and whether
`set_market_oracle` under that authority can point the market at a hostile feed.

---

### S2 — Matching engine and order book

**Module.** The 612 KB zero-copy order book and the two instructions that mutate it.
**Interface.** Price-time priority, a free list that never double-allocates or leaks, and
bounds that hold for every `u16` index into a caller-grown account.

**Owned files (6).**
```
programs/slipstream/src/instructions/place_order.rs
programs/slipstream/src/instructions/cancel_order.rs
programs/slipstream/src/instructions/grow_orderbook.rs
programs/slipstream/src/state/order_book.rs
programs/slipstream/src/state/order_slot.rs
programs/slipstream/src/state/price_level.rs
```

**Threat / defect classes.**
1. **Zero-copy slice safety.** `OrderBookHeader::compute_account_size` and every
   `bytemuck` cast: can a shorter-than-expected account, or one grown to a size that is
   not a multiple of the element stride, produce an out-of-bounds or misaligned cast?
   `grow_orderbook` grows in 10 KB chunks, so *partially grown* is a reachable state —
   check every read path against it explicitly.
2. **Free-list integrity.** Double-free (cancel twice, or cancel a slot already consumed
   by a fill), use-after-free, leak (a slot removed from a level but never returned),
   and cycle (a `next` pointer into an already-linked slot). `free_slot_count` vs. the
   actual list length is a checkable invariant.
3. **Index bounds.** Every `u16` index — order slot, price level, fill event, free-list
   entry — against the *header's declared* capacity **and** the account's actual length.
   `SENTINEL` handling at every list terminus.
4. **Arithmetic overflow.** `u16` counters (`active_order_count`, `bid_level_count`,
   `ask_level_count`, `fill_event_count`) at capacity; `u64` `next_order_id` /
   `next_fill_sequence` wraparound; notional (`price × size`) overflow in `place_order`.
5. **Price-time priority.** Does matching walk levels best-price-first and, within a
   level, oldest-first? Construct the ordering argument from the linked-list insertion
   code. A violation is P1 — the CLOB claim is the product's headline.
6. **Self-trade.** Can a user match their own resting order? What happens to their
   credit and position if so?
7. **POST_ONLY crossing.** Is a POST_ONLY order that would cross rejected, or silently
   converted, or accepted as a taker?
8. **Fill-event ring buffer.** `fill_event_head`/`tail`/`count`: overflow behaviour when
   producers outrun `mirror_fills`. Are fills dropped silently? Dropped fills are lost
   money — P0 if so.
9. **Order expiry and `orders_per_user`.** Per-user order cap enforcement and its
   interaction with cancel/expiry.
10. **Session-key boundary, consumer side.** Read S1's published boundary contract and
    verify `place_order`/`cancel_order` accept a session key *only* for these two
    actions and only for the session's own owner.
11. **ER-side execution.** These two instructions execute inside the ER, where the
    validator controls ordering and clock. State which of the above properties survive a
    hostile sequencer and which do not — cross-reference S5.

---

### S3 — Margin, funding, liquidation, triggers

**Module.** All value math that is not settlement bookkeeping.
**Interface.** Fixed-point precision and rounding direction, i128 funding-index packing,
health factor, liquidation price.

**Owned files (14).**
```
programs/slipstream/src/math/mod.rs
programs/slipstream/src/math/fixed_point.rs
programs/slipstream/src/math/funding.rs
programs/slipstream/src/instructions/liquidate_position.rs
programs/slipstream/src/instructions/compute_funding.rs
programs/slipstream/src/instructions/claim_funding.rs
programs/slipstream/src/instructions/close_position.rs
programs/slipstream/src/instructions/place_trigger.rs
programs/slipstream/src/instructions/cancel_trigger.rs
programs/slipstream/src/instructions/execute_trigger.rs
programs/slipstream/src/state/market.rs
programs/slipstream/src/state/position.rs
programs/slipstream/src/state/liquidation_intent.rs
programs/slipstream/src/state/trigger_order.rs
```

**Threat / defect classes.**
1. **Rounding direction.** Every division and every fixed-point rescale: does rounding
   favour the protocol or the user? Inconsistent direction across the deposit/withdraw
   round trip is a value leak. Enumerate every rounding site with its direction — this
   is the `## Cleared` evidence.
2. **Precision loss.** 6-decimal price × size at 20× leverage: where does the product
   lose significant digits, and is the loss bounded?
3. **Overflow and underflow.** Every arithmetic op in `fixed_point.rs` and `funding.rs`
   at the extremes of the declared input domains. Distinguish `checked_*`/`saturating_*`
   from bare operators; a bare operator on a caller-influenced value is P1 minimum.
   Saturation that silently caps a user's PnL is a *different* defect from a panic and
   must be reported as such.
4. **i128 funding-index packing.** How the cumulative funding index is stored, scaled,
   and diffed. Sign handling across the zero crossing; wraparound over long horizons;
   whether a position that missed N funding periods settles correctly.
5. **Funding sign convention.** Longs pay shorts when the mark is above the index, and
   the reverse. Verify the sign end-to-end from `compute_funding` through `claim_funding`
   to the position balance. There is an existing regression test file for this class
   (`tests/unit/src/test_funding_sign_regressions.rs`) — read it, then check what it does
   *not* cover.
6. **Health factor.** Formula, its inputs, and every branch. Which price feeds it —
   `last_mark_price` (frozen per K1) or a live oracle read? If a stale mark can suppress
   or trigger a liquidation, that is P1 `[reachable-now]`.
7. **Liquidation price.** Is the displayed/stored liquidation price the price at which
   the health formula actually crosses its threshold? A mismatch is P1 — users size
   positions against this number.
8. **Liquidation economics.** Partial vs. full liquidation, liquidator reward, whether a
   liquidation can leave a position with negative equity that no one absorbs (bad debt),
   and whether the liquidator can profit by liquidating a healthy position.
9. **`liquidation_intent` lifecycle.** Two-phase liquidation: can an intent be created
   and executed at different prices, and can a third party execute someone else's intent?
10. **Trigger orders.** `place_trigger`/`execute_trigger`: who may execute, is the
    trigger condition re-checked at execution against a fresh price, can a keeper execute
    a trigger that has not fired, and can a trigger be replayed.
11. **`close_position` slippage bound.** Is the caller-supplied bound enforced against
    the actual execution price, and can it be set to a value that disables the check?
12. **`Market` parameter sanity.** `taker_fee_bps`, leverage cap, maintenance margin:
    are values that would break the math rejected at `initialize_market` (owned by S1 —
    route the *check* there, keep the *math consequence* here)?
13. **`mark_price_for_close` and its three callers.** *(moved here from S5 at harden.)*
    The draft gave this to S5, but S5 owns none of the files it lives in: the function is
    defined at `state/market.rs:173` and every caller is an S3 file —
    `close_position.rs:124`, `claim_funding.rs:62`, `execute_trigger.rs:82`. Under S5 the
    whole class would have been filed as cross-slice notes while S3's own class 6
    overlapped it; that is a class two slices half-own, which in practice means neither
    does. It is S3's. Determine which price it returns, whether the minute-quantised
    staleness stamp written by `crank_twap` (`crank_twap.rs:72-76`) actually rejects a
    frozen mark, and what a close, a funding claim, or a trigger execution does when it
    returns `None`. K1 makes this `[reachable-now]` if the gate does not hold. S5 hands
    over the oracle-side staleness contract as `S5-C7`; S3 does not block on it.

---

### S4 — Settlement and the FillLog pipeline

**Module.** The ER→L1 path that turns matched fills into real `Position` accounts.
**Interface.** Exactly-once settlement: every fill lands on L1 once, in order, with the
same numbers it had in the ER.

**Owned files (7).**
```
programs/slipstream/src/instructions/record_pending_fill.rs
programs/slipstream/src/instructions/mirror_fills.rs
programs/slipstream/src/instructions/initialize_fill_log.rs
programs/slipstream/src/instructions/settle_trades.rs
programs/slipstream/src/instructions/settle_from_log.rs
programs/slipstream/src/state/fill_event.rs
programs/slipstream/src/state/fill_log.rs
```

**Threat / defect classes.**
1. **Exactly-once.** The core property. Can a fill be settled twice (double-credited), or
   zero times (lost)? Check `last_mirrored_sequence`, the FillLog `head`/`count`, and the
   epoch rotation for every interleaving of the three stages.
2. **Ordering.** Must fills settle in sequence order for the position math to be right?
   If yes, is that enforced or assumed? If assumed, P1.
3. **Epoch rotation.** What happens to fills in flight when the FillLog rotates epoch?
   Can a rotation drop the tail, or can a stale-epoch log be settled against the new one?
4. **Replay and authorization.** Who may call each of the three stages? Can a
   non-keeper call `settle_from_log` with a hand-crafted log, or replay a previously
   committed log account?
5. **Capacity and backpressure.** `FILL_LOG_CAPACITY` vs. ER fill production rate. What
   happens when the log is full and `mirror_fills` runs — reject, overwrite, or wrap?
   Overwrite is lost money, P0.
6. **Value conservation across the boundary.** Sum of credited position deltas vs. sum of
   fill notionals, including the taker fee. `PRODUCT.md` states the fee is snapshotted
   onto each fill event — verify the snapshot is what settlement actually charges, not a
   re-read of the (mutable) current `Market.taker_fee_bps`.
7. **The `settle_trades` / `settle_from_log` duality.** Two settlement entry points
   exist. Determine whether both are live, whether they can both settle the same fill,
   and whether the older one is a reachable bypass of the newer one's checks. If
   `settle_trades` is dead code that still dispatches, that is P2 at minimum.
8. **Trust in ER-authored data.** `mirror_fills` runs in the ER; `settle_from_log` runs
   on L1 and consumes what the ER produced. Enumerate exactly which fields L1
   re-validates and which it takes on faith. This list is the deliverable that S5 reads.
9. **Arithmetic.** Position averaging on add, realised PnL on reduce, side flips through
   zero, and the overflow behaviour of accumulated size/notional.
10. **Partial-failure atomicity.** If `settle_from_log` fails partway through a batch, is
    the log's consumed-marker advanced for the successful prefix only, or for all/none?

---

### S5 — Oracle and the ER trust boundary

**Module.** Price ingestion, and the entire delegation lifecycle.
**Interface.** The one claim the product is sold on: *"a misbehaving ER can at worst
scramble order ordering or misuse an already-capped credit allowance. It can never reach
the vault or an undelegated balance."* (`PRODUCT.md`, Positioning.) S5's central job is
to test that sentence.

**Owned files (11).**
```
programs/slipstream/src/oracle.rs
programs/slipstream/src/instructions/crank_twap.rs
programs/slipstream/src/instructions/delegate_orderbook_prepare.rs
programs/slipstream/src/instructions/delegate_orderbook.rs
programs/slipstream/src/instructions/undelegate_orderbook.rs
programs/slipstream/src/instructions/commit_orderbook.rs
programs/slipstream/src/instructions/delegate_trading_credit.rs
programs/slipstream/src/instructions/undelegate_trading_credit.rs
programs/slipstream/src/instructions/delegate_fill_log.rs
programs/slipstream/src/instructions/commit_fill_log.rs
programs/slipstream/src/instructions/emergency_undelegate.rs
```

**Threat / defect classes.**
1. **The delegation inventory.** Enumerate *every* account this program can delegate, and
   prove the set is exactly `{OrderBook, TradingCredit, FillLog}`. A repo-wide grep for
   delegation CPIs is required evidence. If any path can delegate a `Position`,
   `UserAccount`, `Market`, or the vault, that is P0 and it falsifies the product claim.
2. **The malicious-ER capability list.** Produce an explicit two-column table: *what a
   hostile ER validator can do* / *what stops it*. Cover at least: reorder or censor
   orders; forge fills in the FillLog; inflate a `TradingCredit` beyond its cap; commit
   arbitrary bytes into the OrderBook; refuse to undelegate; roll back committed state.
   For each, name the on-chain check that bounds it or state that none exists.
3. **Oracle account binding.** `README.md` lists "Oracle account binding: Not validated
   against market feeds" as a known mainnet gap (K6 does *not* cover this — it is
   documented as unfixed, not as mitigated). Determine the *actual* exploitability today:
   which instructions read an oracle account, whether any asserts it equals
   `Market.pyth_feed`, and what an attacker who supplies their own account achieves.
   Expect P0 `[reachable-now]` unless something else constrains it — find out which.
4. **Staleness gates.** `MAX_STALENESS_SECS = 60`. Which price-consuming instructions
   actually enforce it, and against which clock (the ER clock is validator-controlled)?
5. **Dual-oracle disagreement.** `oracle.rs` documents Pyth + Switchboard,
   `MAX_DIVERGENCE_BPS = 200`, restricted mode, and 3-reading hysteresis. `README.md`
   says the real model is "Pyth-only fallback (Switchboard dead)." Determine what the
   code does *now*: is the divergence check dead, always-pass, or actively bypassed? If
   the documented dual-oracle safety property is not in force, that is a P1 doc/behaviour
   split — and route the doc half to S12.
6. **Pyth parse correctness.** The hand-rolled `PriceUpdateV2` parser assumes
   `VerificationLevel::Full` (declared `oracle.rs:33-36`, enforced `oracle.rs:130`) and hardcodes offsets. Verify the offset
   table against the real account layout, verify the exponent handling normalising to 6
   decimals, and verify the `MAX_CONFIDENCE_BPS = 100` gate. A wrong offset is silently
   wrong prices — P0.
7. **Mark-price staleness contract (producer for `S3-C13`).** *(rescoped at harden: the
   `mark_price_for_close` analysis itself moved to S3, which owns all four files it
   touches.)* S5 owns the *oracle-side* half and publishes it as a contract in its
   findings file: what `crank_twap` writes into `last_mark_price` and the minute stamp
   (`crank_twap.rs:72-76`), the clock it reads, the width of the staleness window that
   stamp can express, and what an ER-controlled clock does to it. State it as a contract
   S3 can read against. Do not analyse the callers — those are S3's, and a defect found
   in them goes in Cross-slice notes.
8. **`crank_twap`.** Sole writer of `last_mark_price` (K1). Who may call it, is the
   accumulator manipulable by call timing or frequency, can it be called repeatedly in
   one slot to skew the TWAP, and what bounds a single update's jump?
9. **Undelegation asymmetry.** `PRODUCT.md`: undelegation is asynchronous. Model every
   intermediate state of `delegate_*`/`undelegate_*`, and identify the state machine that
   produces K5's half-delegated deadlock. K5 is given; **the root cause in program code
   is not** — that is S5's deliverable. Is there any in-program path out of it, and if
   not, is the absence a design gap or a missing instruction? Expect P1.
10. **`emergency_undelegate`.** Who may call it, what does it bypass, and can it be used
    offensively (force-undelegate someone mid-trade, or grief the book)?
11. **`commit_orderbook` reachability.** `README.md` says the 612 KB book "stays delegated
    forever, never committed," yet a `commit_orderbook` instruction exists and is
    dispatched. Reconcile. Either the doc is wrong (route to S12) or a dispatchable
    instruction violates a stated invariant (P2 here).

---

### S6 — SDK layout parity: TS decoders vs. the Rust `#[repr(C)]` layouts

**Module.** The TypeScript decoders and instruction builders, in both copies.
**Interface.** A byte-for-byte contract with twelve `#[repr(C)]` Rust structs. This is
mechanically checkable and it is the highest value-per-hour slice in the run: an offset
drift produces confidently wrong numbers on screen with no error anywhere.

**Owned files (11).**
```
client/src/index.ts
client/src/constants.ts
client/src/pda.ts
client/src/accounts.ts
client/src/instructions.ts
frontend/src/lib/slipstream/index.ts
frontend/src/lib/slipstream/constants.ts
frontend/src/lib/slipstream/pda.ts
frontend/src/lib/slipstream/accounts.ts
frontend/src/lib/slipstream/instructions.ts
frontend/src/lib/slipstream/orderbook.ts
```

**Method — required, not optional.** Produce, for each of the twelve `#[repr(C)]`
structs, a three-column table: *field* / *Rust offset+size (computed from the declaration
order and C layout rules, including padding and alignment)* / *TS decoder offset+size*.
Both TS copies are compared against Rust independently. The tables go in the findings
file and are the `## Cleared` evidence. The twelve structs:

```
state/user_account.rs      state/global_state.rs     state/trading_credit.rs
state/market.rs            state/position.rs         state/order_book.rs
state/order_slot.rs        state/price_level.rs      state/fill_event.rs
state/fill_log.rs          state/liquidation_intent.rs  state/trigger_order.rs
```

A generated cross-check (a scratch script under
`docs/audit/audit-e2e/repro/s6/`) that reads sizes from the Rust source and asserts them
against the TS constants counts as proof of type (b) and is encouraged.

**Threat / defect classes.**
1. **Byte-offset drift** — any field whose TS offset differs from its Rust offset.
   Every instance is P1 `[reachable-now]` by default: it produces a wrong number with no
   error. Upgrade to P0 if the drifted field feeds a transaction the user signs.
2. **Padding and alignment.** `#[repr(C)]` inserts padding the TS side must skip.
   `order_book.rs` has explicit `_pad1`/`_pad2` fields; others may rely on implicit
   padding. Implicit padding is the likeliest silent bug — check it first.
3. **Endianness and signedness.** Little-endian throughout; `i64`/`i128` read as signed;
   the funding index specifically (S3's packing, decoded here).
4. **Struct size constants.** Every `*_SIZE` / `LEN` constant in TS against
   `core::mem::size_of` in Rust, including the computed OrderBook account size.
5. **Discriminator constants.** Every `DISC_*` in TS against `state/mod.rs`.
6. **PDA seeds.** Every derivation in `pda.ts` (both copies) against the Rust seed
   arrays — seed strings, order, and encoding of numeric seeds.
7. **Instruction encoding.** Every builder in `instructions.ts` (both copies): the
   discriminator byte against `instructions/mod.rs`'s `IX_*` constants, argument encoding
   and order, and the **account order and signer/writable flags** against what the Rust
   `process` reads positionally. A wrong account index is P0 — it can make a user sign a
   transaction that does something other than what the UI said.
8. **Divergence between the two copies.** K7 establishes surface divergence. Enumerate
   every semantic difference and, for each, decide which copy is right. The frontend copy
   is what users actually run; a bug there outranks the same bug in `client/`.
9. **Coverage gaps.** Rust accounts and instructions with no TS decoder or builder at
   all, and TS builders for instructions that no longer exist.

---

### S7 — Keepers

**Module.** The off-chain bots that are the protocol's liveness.
**Interface.** They must be idempotent, restartable, and must not hold more authority
than their job needs. K1 is a liveness failure; this slice finds why it was *possible*,
not merely that it happened.

**Owned files (32).**
```
keepers/ecosystem.config.js
keepers/.env.example
keepers/src/fill-log-keeper.ts        keepers/src/funding-keeper.ts
keepers/src/liquidation-keeper.ts     keepers/src/twap-keeper.ts
keepers/src/expiry-keeper.ts          keepers/src/settlement-keeper.ts
keepers/src/market-maker-bot.ts       keepers/src/taker-bot.ts
keepers/src/bot-setup.ts              keepers/src/fill-log-setup.ts
keepers/src/provision-fresh-bots.ts   keepers/src/set-market-oracle.ts
keepers/src/fund-user-usdc.ts         keepers/src/topup-takers.ts
keepers/src/check-fills.ts            keepers/src/check-funding.ts
keepers/src/check-settlement-state.ts keepers/src/inspect-book.ts
keepers/src/inspect-credits.ts        keepers/src/inspect-user.ts
keepers/src/verify-close.ts           keepers/src/verify-session.ts
keepers/src/shared/accounts.ts        keepers/src/shared/bot-wallets.ts
keepers/src/shared/connection.ts      keepers/src/shared/ertx.ts
keepers/src/shared/fill-db.ts         keepers/src/shared/manifest.ts
keepers/src/shared/pyth.ts            keepers/src/shared/subscriber.ts
```
(`keepers/Dockerfile`, `keepers/package.json`, `keepers/package-lock.json`,
`keepers/tsconfig.json`, `keepers/.gitignore` → S10 by R1. `keepers/README.md` → S12 by R2.)

**Threat / defect classes.**
1. **Key handling.** `KEEPER_KEYPAIR` and `shared/bot-wallets.ts`: how are keys loaded,
   where do bot wallets come from (derived? generated? written to disk? in what mode?),
   is any key logged, and does any keeper hold authority beyond cranking. Cross-reference
   K2 — determine whether the keeper key *is* the operator key.
2. **Idempotence.** For each of the five production keepers: if it crashes mid-action and
   restarts, does it double-act? Settlement and funding are the dangerous ones —
   double-settling a fill or double-applying a funding period is P0 money.
3. **Crash-loop and restart behaviour.** The direct root-cause slice for K1. Establish
   the full chain in code: what error kills the process, is it caught, is there backoff,
   and does `max_restarts: 50` (`ecosystem.config.js:33`) mean a boot-time failure is
   permanently fatal with no alert. The finding must state what would have to change for
   the same failure to self-heal.
4. **RPC usage and quota.** Per-keeper request rate: polling intervals, whether
   subscriptions (`shared/subscriber.ts`) or polling are used, whether
   `getProgramAccounts` is called in a loop, and whether any retry path is unbounded.
   The `ecosystem.config.js` comments claim the 2 s market-maker cadence halved base-RPC
   usage — check the claim against the code.
5. **No liveness monitoring.** There is no alerting in tree. K1 ran for 17 days
   undetected. Establish whether *anything* in the repo would have surfaced it, and file
   the absence at the severity the impact justifies.
6. **The half-delegated deadlock, operational half.** K5's workaround is fresh wallet
   prefixes set in *two* places (`ecosystem.config.js`, `docker-compose.yml`) with a
   warning in `.env.example` that any third launch path silently fails every bot order.
   Assess: is the prefix defaulted in code, or only in config? A default that lives only
   in config is a footgun — grade it.
7. **Error handling and silent failure.** Swallowed exceptions, `catch {}` blocks,
   transactions sent without confirmation checks, and paths where a failed crank is
   indistinguishable from a successful one in the logs.
8. **`shared/fill-db.ts`.** SQLite writes: unbounded growth (`INDEXER_RETENTION_DAYS`
   defaults to off), concurrent access from multiple keepers, SQL construction, and
   whether the frontend's `/api/trades` reads it consistently (route the frontend half to
   S8).
9. **`shared/manifest.ts` and address trust.** Where do addresses come from, and can a
   keeper be pointed at a wrong program or market by an env var with no validation?
10. **The bots are not neutral.** `market-maker-bot.ts` and `taker-bot.ts` create the
    liquidity users trade against. Assess whether the taker bot can lose real user money,
    whether the MM can be picked off systematically, and whether either can be induced by
    an outside trader to drain its credit.
11. **Operational scripts.** The `check-*`, `inspect-*`, `verify-*`, `fund-user-usdc`,
    `provision-fresh-bots`, `set-market-oracle` scripts: any that mutate on-chain state
    is a privileged tool — assess what it can do if run with wrong arguments.
12. **`settlement-keeper.ts` is launched by no supervisor.** *(added at harden.)* The
    draft said "each of the five production keepers", but the owned set has six
    keeper-named files. `keepers/ecosystem.config.js:43-47` launches exactly five —
    `fill-log`, `funding`, `liquidation`, `twap`, `expiry` — plus the two bots at `:54`
    and `:71`. `docker-compose.yml` launches the same five plus the bots.
    `settlement-keeper.ts` appears only as an npm script
    (`keepers/package.json:7`) and a README row (`keepers/README.md:12`), which
    describes it as the thing that "turns fills into positions". Establish which it is:
    dead code superseded by `fill-log-keeper` + `settle_from_log` (then S4's
    `settle_trades`/`settle_from_log` duality question has an operational answer, route
    it), or a live requirement that nothing supervises (then it is a liveness gap of the
    same shape as K1, and the "five production keepers" framing in `keepers/README.md`
    is a doc finding — route to S12). Resolve it either way; do not leave it open.

    Classes 2 and 3 read "the five production keepers" as exactly the five at
    `ecosystem.config.js:43-47`. The two bots are covered by class 10.

---

### S8 — Frontend server surface: API routes

**Module.** The five Next.js route handlers and the manifest they trust.
**Interface.** Everything reachable by an unauthenticated HTTP request to the deployed
origin. Small file set, highest external attack surface in the repo.

**Owned files (6 tracked, + 1 generated per R3).**
```
frontend/src/app/api/faucet/route.ts
frontend/src/app/api/rpc/[layer]/route.ts
frontend/src/app/api/pyth/history/route.ts
frontend/src/app/api/status/route.ts
frontend/src/app/api/trades/route.ts
frontend/src/lib/manifest.ts
frontend/src/lib/deploy-manifest.generated.json    # untracked, generated — R3
```

**Threat / defect classes.**
1. **The faucet holds mint authority (K3).** Given the mitigations in K6, find the
   *residual* gap. Specifically: the per-wallet cooldown is an in-memory `Map` that
   resets on restart and is per-instance; the global hourly cap has the same property;
   Vercel/serverless would run many instances. Establish the real bound on mint volume
   and on operator SOL drain. Assess whether the operator key file is read from disk on
   every request and what happens if it is absent or malformed.
2. **Error text leakage.** `PRODUCT.md` states the faucet "must never echo raw RPC error
   text to clients — upstream URLs can carry private keys." Verify every error path in
   all five routes against that rule, not just the faucet's happy path.
3. **RPC proxy as an SSRF pivot.** `[layer]` is a path parameter mapped through a fixed
   two-key object with `Object.hasOwn` (K6). Confirm no other path reaches `fetch` with
   caller-influenced host, including via the upstream env vars. Then assess the *other*
   direction: the proxy is an unauthenticated free relay onto a paid quota, the route's
   own comment says so, and K1 is a quota-exhaustion outage. Is the method allowlist plus
   body cap actually sufficient, given `getProgramAccounts` is allowlisted against a
   612 KB-account program? Expect a finding.
4. **Rate limiting generally.** Which of the five routes has any limit at all, and is any
   limit durable across instances?
5. **Input validation.** Every parsed body and query parameter in all five routes:
   unvalidated pubkeys, unbounded numeric ranges, `pyth/history` time ranges, `trades`
   pagination.
6. **Injection into the fills DB.** `/api/trades` and `/api/status` read
   `keepers/data/fills.db`. Check the query construction and whether user input reaches
   it. Also: what do these routes return when the DB is missing, empty, or stale —
   K1 means stale is the live condition.
7. **Data honesty, server half.** Does `/api/status` report keeper liveness truthfully?
   A status endpoint that reported "healthy" through 17 days of K1 is a P1 correctness
   defect in its own right. Determine what it actually measures.
8. **Manifest trust.** `deploy-manifest.generated.json` is generated at build time and
   defines the program, market, and mint the entire frontend talks to. What validates it,
   and what happens if the copy step (S10) silently no-ops?
9. **Caching and headers.** `dynamic = "force-dynamic"` is set on the routes that need
   it — confirm for all five, and check for missing security headers on responses.

---

### S9 — Browser session-key custody and transaction integrity

**Module.** The client-side seam where a key is held and a transaction is built:
wallet plumbing, the auth callback, the docs renderer that shares the origin with them,
and the eleven hooks every trading component reads from.
**Interface.** `README.md`'s claim: *"the app never holds a key that can move funds on
its own."* S1 and S2 prove the on-chain half; S9 proves the client never *builds* a
money-moving transaction with the session key, and that nothing on the origin can read
it.

**Owned files (22).**
```
frontend/src/components/wallet/connect-button.tsx
frontend/src/components/wallet/wallet-provider.tsx
frontend/src/app/auth/callback/page.tsx
frontend/src/app/docs/page.tsx           frontend/src/app/docs/layout.tsx
frontend/src/app/docs/[slug]/page.tsx    frontend/src/app/docs/docs-shell.tsx
frontend/src/app/docs/mermaid-runner.tsx
frontend/src/lib/confirm.ts   frontend/src/lib/docs.ts   frontend/src/lib/utils.ts
frontend/src/hooks/use-er-position.ts    frontend/src/hooks/use-live-price.ts
frontend/src/hooks/use-market.ts         frontend/src/hooks/use-open-orders.ts
frontend/src/hooks/use-orderbook.ts      frontend/src/hooks/use-positions.ts
frontend/src/hooks/use-price-history.ts  frontend/src/hooks/use-pyth-candles.ts
frontend/src/hooks/use-session.ts        frontend/src/hooks/use-triggers.ts
frontend/src/hooks/use-wallet-compat.ts
```
(`frontend/src/lib/slipstream/**` → S6. `frontend/src/app/api/**` and
`frontend/src/lib/manifest.ts` → S8. `frontend/src/content/docs/**` → S12. Every
rendering component → S13.)

**Threat / defect classes.**
1. **Session-key custody.** Where is the session key generated, where is it stored
   (`localStorage`? memory? IndexedDB?), is it ever transmitted, what is its lifetime,
   is it scoped to an origin and an owner, and is it revocable. Then verify the
   `README.md` claim: prove the client never constructs an instruction other than
   `place_order`/`cancel_order` signed by it. Enumerate every call site that reaches an
   instruction builder with the session keypair; that enumeration is the `## Cleared`
   evidence. Read S1's published owner-vs-session boundary contract if it has landed;
   re-derive it from `authorize_session.rs` if it has not. Do not block on it.
2. **XSS reachability of the session key.** If a script runs on the origin, does it get
   the key? Check `dangerouslySetInnerHTML`, the markdown and mermaid docs renderer
   (`mermaid-runner.tsx`, `docs.ts`, `docs-shell.tsx`), and any `eval`-adjacent path.
   The docs renderer sits on the same origin as the key store, which is why it is in
   this slice and not with the rest of the UI. A stored session key plus a
   docs-renderer XSS is a P1 chain even on devnet.
3. **The auth callback.** `auth/callback/page.tsx`: open-redirect, token and parameter
   handling, and origin validation for the Phantom Connect flow.
4. **Transaction construction and signing UX.** Does what the user sees on the confirm
   screen match what is being signed? Blind-signing prompts, unvalidated amounts,
   decimal handling between the form and the instruction builder. `lib/confirm.ts` is
   the seam; the form itself is S13's, so route presentation defects there.
5. **Async correctness.** Race conditions between hooks, stale closures over polled
   data, missing cleanup on unmount, and unbounded polling that contributes to K1's
   quota problem. Per hook, state the poll interval and whether it backs off.
6. **Undelegation polling.** `PRODUCT.md`: undelegation is asynchronous and any UI
   waiting on it must poll, not assume. Verify the withdraw flow actually polls and
   handles the poll never succeeding (K5's deadlock state).
7. **Withdrawal precondition gating.** `PRODUCT.md` requires the UI to block withdrawal
   on a non-idle account "with a clear instruction rather than silently failing."
   Verify the gating *logic* — the hook-level predicate that decides. Whether the
   resulting message is clear on screen is S13's half; route it.

---

### S13 — Rendered-data honesty and the accessibility floor

*(S13 is S9's other half — see §5. It is placed here, out of numeric order, to keep the
split pair together.)*

**Module.** Every pixel that asserts a fact: the trading terminal, the landing page,
and the seven shared `ui/` primitives they are built from.
**Interface.** `PRODUCT.md` Principle 1: *"every claim on screen traces to something a
reader can check."* With the keepers down since 2026-08-05 (K1), this is not a
hypothetical standard — it is a live test the deployed UI is currently taking.

**Owned files (28).**
```
frontend/src/app/layout.tsx    frontend/src/app/page.tsx    frontend/src/app/globals.css
frontend/src/app/trade/page.tsx    frontend/src/app/landing/page.tsx
frontend/src/components/landing/landing-view.tsx
frontend/src/components/theme-toggle.tsx
frontend/src/components/trading/activity-drawer.tsx    .../dashboard.tsx
frontend/src/components/trading/fill-toasts.tsx        .../market-bar.tsx
frontend/src/components/trading/open-orders.tsx        .../order-book-display.tsx
frontend/src/components/trading/order-form.tsx         .../positions-table.tsx
frontend/src/components/trading/price-chart.tsx        .../session-panel.tsx
frontend/src/components/trading/status-panel.tsx       .../status-strip.tsx
frontend/src/components/trading/terminal-nav.tsx       .../trade-history.tsx
frontend/src/components/ui/badge.tsx      frontend/src/components/ui/button.tsx
frontend/src/components/ui/card.tsx       frontend/src/components/ui/separator.tsx
frontend/src/components/ui/table.tsx      frontend/src/components/ui/liquid-glass-button.tsx
frontend/src/components/ui/liquid-weather-glass.tsx
```
(14 under `trading/`, 7 under `ui/`. The hooks these components read → S9;
`frontend/src/app/*.png` → S10.)

**Threat / defect classes.**
1. **Data honesty — the per-number source table.** The primary deliverable. For
   **every** number rendered by the components above, name its source: an on-chain read,
   an API route, a client-side computation, or a constant. Then flag every one that:
   - is derived from `last_mark_price` (frozen per K1) but presented as live;
   - is a client-side estimate presented with the same visual weight as a settled
     on-chain value;
   - has no source at all (hardcoded, placeholder, or mock);
   - is stale without any staleness indicator.

   `PRODUCT.md` Principle 1 makes an unverifiable number on screen worse than no number.
   Grade accordingly. The table is the `## Cleared` evidence and it is expected to be
   long; a table with fewer rows than the terminal has visible figures is not done.
2. **Stale and error states.** With the keepers down — the live condition — what does
   each panel show? Does the UI distinguish "no data" from "zero" from "loading"?
   `brand.md`'s load-bearing colour rule makes a wrong emerald a correctness defect, not
   a style one. `status-strip.tsx` and `status-panel.tsx` render what `/api/status`
   reports (S8 audits the route's honesty; S13 audits whether the UI faithfully shows
   what it got, including when it got nothing).
3. **Number formatting.** Rounding and truncation in display, unit confusion (lots vs.
   SOL vs. USD, 6-decimal vs. 9-decimal), and `bigint`→`number` precision loss on any
   value that can exceed 2^53.
4. **Accessibility floor.** `PRODUCT.md` establishes WCAG AA contrast on interactive
   elements, `prefers-reduced-motion` removing motion outright, and live values never
   signalling direction by colour alone. These are documented project invariants, so
   violations are in scope — this is the one place a visual finding is not a stylistic
   preference. Everything else visual is out of scope. `globals.css` is where the
   reduced-motion and contrast tokens live; check it against what the components use.
5. **The custom `ui/` primitives.** Five of the seven are stock shadcn shapes;
   `liquid-glass-button.tsx` and `liquid-weather-glass.tsx` are not. Assess those two
   for unbounded or always-running animation, `prefers-reduced-motion` compliance, and
   whether either wraps an interactive element in a way that loses its accessible name
   or focus ring. This class exists because a custom primitive is where an
   accessibility floor silently stops applying.

---

### S10 — Ops, secrets, supply chain, build and deploy

**Module.** Everything that gets code and keys onto a machine.
**Interface.** The blast radius of one compromised credential, and the reproducibility of
a deploy.

**Owned files (44).** All of R1's manifests and configs — the complete list:
```
.github/workflows/ci.yml     docker-compose.yml       keepers/Dockerfile
.dockerignore                .gitignore               deploy.json
Cargo.toml  Cargo.lock  Anchor.toml  rustfmt.toml  LICENSE
programs/slipstream/Cargo.toml
client/package.json  client/package-lock.json  client/tsconfig.json
keepers/package.json  keepers/package-lock.json  keepers/tsconfig.json  keepers/.gitignore
frontend/package.json  frontend/package-lock.json  frontend/tsconfig.json
frontend/next.config.ts  frontend/vercel.json  frontend/eslint.config.mjs
frontend/postcss.config.mjs  frontend/components.json  frontend/.gitignore
frontend/scripts/copy-manifest.mjs  frontend/scripts/copy-docs.mjs  frontend/scripts/gen-assets.mjs
tests/unit/Cargo.toml  tests/integration/package.json
tests/integration/package-lock.json  tests/integration/tsconfig.json  tests/integration/.gitignore
frontend/assets/*.png  frontend/public/*.png  frontend/src/app/*.png   (licensing only)
```

**Threat / defect classes.**
1. **Operator key concentration (K2).** Enumerate every capability that single key holds,
   and for each, what an attacker who obtains it can do. Produce the split plan as a
   remediation: which capabilities can be separated today with no code change. This is
   the headline finding of the slice; `PRODUCT.md` lists it as explicitly undecided, so
   file it as a decision-forcing record, not a re-opened debate.
2. **Secret handling.** Every place a secret is named, defaulted, or read:
   `keepers/.env.example`, `frontend/.env.local`, `docker-compose.yml`, the Dockerfile,
   `ecosystem.config.js`'s `--env-file`. Are any secrets baked into images, passed as
   build args, or visible in `docker inspect` / `ps`? Verify `.gitignore` and
   `.dockerignore` actually exclude what they claim (`*keypair*.json`, `secrets/`,
   `id.json`, `.env`).
3. **Committed-secret scan.** Scan the full git history, not just the working tree, for
   private keys, keypair JSON arrays, and API keys in RPC URLs. A secret in history is
   still leaked. State the method used.
4. **`NEXT_PUBLIC_` inlining.** Anything prefixed `NEXT_PUBLIC_` ships to the browser.
   Enumerate them and confirm none is actually a secret. `frontend/.env.local` documents
   `NEXT_PUBLIC_PHANTOM_APP_ID` as public by design — verify the reasoning and check
   nothing else has crept in.
5. **CI gate quality.** What can merge to `master` broken? `ci.yml` runs clippy,
   `cargo audit`, SBF build, both Rust test binaries, and frontend/keepers `tsc`. It does
   **not** run: the integration suite, any frontend test, `npm audit`, or anything for
   `client/` beyond an install. Assess each absence. K6 records the `npm audit` omission
   as deliberate with a stated reason — evaluate whether the reason still holds, and if
   the advisory count is the blocker, quantify it.
6. **Supply chain.** Run the dependency audits the CI does not, and report reachable
   advisories only (an advisory in a dev-only or unreachable path is P3, not P1). Check
   lockfile integrity: is every dependency pinned, are the three npm trees consistent,
   does `client/package-lock.json` match what keepers actually resolve.
7. **CI supply chain.** Unpinned actions (`@v4` is a moving tag), the
   `curl | sh`-adjacent Solana install (the file's own comment explains why it is
   two-step — verify the reasoning holds), and `cargo install cargo-audit` unpinned on
   every run.
8. **Deploy reproducibility.** `deploy.json` is the stated source of truth. Is the
   deployed program verifiably built from this source? Is there a build-hash record? Can
   `copy-manifest.mjs` fail silently and ship a stale manifest (route the consumption
   half to S8)?
9. **Upgrade authority.** The program is upgradeable and the upgrade authority is K2's
   key. State plainly what that means for the trust model, and whether any doc claims
   immutability it does not have (route to S12).
10. **Container and host posture.** `docker-compose.yml` and `keepers/Dockerfile`: root
    user, mounted secrets, exposed ports, base image pinning, and whether the compose
    file duplicates config that `ecosystem.config.js` also owns (K5's two-places problem
    — route the keeper half to S7).
11. **Asset licensing.** The `.png` files: provenance and licence compatibility with the
    repo's MIT licence. This is the only defect class the binary assets carry.

---

### S11 — Tests and verification

**Module.** The test suites, as evidence.
**Interface.** The gap between "123 passing Rust tests" as a `PRODUCT.md` credibility
claim and what those tests actually constrain in the money path.

**Owned files (30).**
```
tests/unit/src/lib.rs
tests/unit/src/test_*.rs                     (20 files)
tests/integration/setup.ts
tests/integration/crank_twap_harness.ts
tests/integration/*.test.ts                  (7 files)
```
(`tests/unit/Cargo.toml`, `tests/integration/package.json`, its lockfile, `tsconfig.json`,
and `.gitignore` → S10 by R1. `tests/integration/README.md` → S12 by R2.)
Plus one carve-out: **S11 owns test code wherever it lives.** The inline
`#[cfg(test)]` modules inside `programs/slipstream/src/**` are S11's to assess; the
production code in those same files belongs to S1–S5. This is the only file-level split
in the partition, and the key is the `#[cfg(test)]` attribute. S11 files coverage
findings; it does not file findings about the production code it reads.

**Threat / defect classes.**
1. **Money-path coverage map.** The primary deliverable. Build a table: for every
   instruction that moves value (S1's, S3's, and S4's owned sets), list the tests that
   exercise it and classify each as *happy path only* / *rejects one bad input* /
   *exercises the adversarial case*. Every row with no test at all is a P3 finding
   (P2 if the instruction is on the withdraw or settle path).
2. **Assertion quality.** Tests that call an instruction and assert only that it did not
   error are near-worthless for money math. Identify them. A test named
   `test_*_regressions` that does not assert the regressed value is a finding.
3. **Adversarial coverage.** Cross-reference S1–S5's threat class lists. For each class,
   does *any* test attempt the attack? Specifically: wrong signer, wrong PDA, wrong
   account type, arithmetic extremes, replay, and double-settle.
4. **The two Rust test binaries.** `ci.yml:64-70` notes the program crate's inline tests
   are a separate binary from `tests/unit/` and "were never run by CI at all" before the
   step was added. Verify the step now genuinely runs them (a `--locked` test invocation
   that compiles zero tests exits 0). Confirm the count: 25 inline + 98 in `tests/unit/`.
5. **The unrun integration suite.** Seven `.test.ts` files that CI never executes.
   Determine for each: does it still compile against the current program, does it need a
   live devnet or ER, and is it stale enough to be misleading. `PRODUCT.md` cites the
   suite as evidence on hand — if it does not run, that citation is a doc finding (route
   to S12) and the suite's state is a finding here.
6. **Flakiness and determinism.** Tests depending on wall-clock time, network, ordering,
   or shared mutable state.
7. **Mollusk fidelity.** Mollusk executes the real compiled program in-SVM but does not
   reproduce the ER, cross-program invocation to the delegation program, or real token
   accounts. State plainly which of the audited threat classes Mollusk *structurally
   cannot* cover — this bounds what the whole test suite can ever prove and is the most
   useful single paragraph S11 produces.
8. **Coverage of the ER boundary.** S5's central claim (nothing but three account types
   is ever delegated) — is it asserted anywhere in a test? If not, that is the highest
   priority test gap in the repo.

---

### S12 — Documentation accuracy vs. shipped behaviour

**Module.** Every prose artifact in the repo, judged only against what the code does.
**Interface.** `PRODUCT.md` Principle 1: "Every claim on screen traces to something a
reader can check." A doc that describes behaviour the system does not have is a
correctness defect in a project whose primary audience is reviewers.

**Owned files (18 tracked, + 2 in-scope-untracked per R3).**
```
README.md  PRODUCT.md  brand.md
docs/README.md  docs/00-architecture-diagrams.md  docs/01-architecture-overview.md
docs/02-orderbook-and-pda-storage.md  docs/03-ephemeral-rollups-and-delegation.md
docs/04-settlement-and-the-fill-log.md  docs/05-margin-funding-liquidation.md
docs/06-session-keys.md  docs/07-problems-and-solutions.md  docs/08-glossary.md
docs/research/magicblock-price-feed.md  docs/research/repo-quality-checkup.md
frontend/README.md  keepers/README.md  tests/integration/README.md
--- in scope, not tracked (R3) ---
DESIGN.md                               # uncommitted working-tree file
frontend/src/content/docs/*.md          # generated by scripts/copy-docs.mjs
```

**Threat / defect classes.**
1. **Claim verification.** Extract every falsifiable factual claim from `README.md` and
   `PRODUCT.md` — instruction count, account sizes, test counts, addresses, capability
   table rows, the "live" status markers — and verify each against the code or the chain.
   The claim/verdict table is the deliverable and the `## Cleared` evidence.
2. **The capability table.** `README.md`'s "What it does" table marks nine capabilities
   "live" and five "keeper-cranked." Given K1, every keeper-cranked row has been *not*
   live for 17 days. Assess whether the table's framing is defensible and what wording
   would be true.
3. **Doc/behaviour splits routed from other slices.** S5 (dual-oracle vs. Pyth-only;
   `commit_orderbook` vs. "never committed"), S10 (upgrade authority vs. any immutability
   claim), S11 (integration suite cited as evidence but unrun). S12 owns the doc half of
   each. Do not duplicate the code-side finding; reference it.
4. **The known-stale onboarding flow.** `PRODUCT.md` states outright: "`docs/` and
   `README.md` currently describe a three-step onboarding flow the UI no longer has; they
   are stale, not authoritative." Locate every instance and enumerate it. This one is
   pre-admitted — file it once, comprehensively, at P3, not as a discovery.
5. **Mirror drift.** `frontend/src/content/docs/` is **not** a checked-in mirror — it is
   generated at build time by `frontend/scripts/copy-docs.mjs` (R3). Audit the generator:
   which files it copies, whether it can partially fail, whether it rewrites content, and
   whether a doc added to `docs/` reaches the site automatically. Then diff the current
   generated tree against `docs/` and report any difference, noting that a stale
   generated tree in a working copy is not itself evidence of a shipped defect. The
   generator file belongs to S10 — route implementation findings there and keep the
   published-content consequence here.

   **`DESIGN.md` is uncommitted (R3).** `PRODUCT.md` names `brand.md` the binding
   identity record and says it "must not be contradicted or duplicated." `DESIGN.md` is a
   16 KB design-system document that restates palette, typography, spacing, and component
   tokens — and it is not in git, so it is invisible to CI, to reviewers, and to anyone
   cloning the repo. Determine whether it contradicts `brand.md`, and file its untracked
   status as a finding in its own right.
6. **Address and constant accuracy.** Every address, PDA seed, size, and numeric constant
   quoted in prose against `deploy.json` and the code. `docs/02` quotes storage layout,
   `docs/05` quotes margin math — these are the ones most likely to have drifted.
7. **Architecture diagrams.** `docs/00` and the `README.md` mermaid flowchart against the
   real instruction set and data flow. A diagram showing an edge that does not exist, or
   omitting one that does, is a finding.
8. **Glossary conformance.** `PRODUCT.md` fixes terminology to `docs/08-glossary.md`.
   Check the other docs use the terms as defined; check the glossary defines the terms the
   other docs actually use.
9. **Overstatement.** `PRODUCT.md` lists absences future work must not fabricate: no
   users, testimonials, case studies, press, security audit, mainnet, or volume/TVL
   figures, and the market-maker liquidity must be described as a bot the project runs
   itself. Verify no doc violates this — including this run's own eventual output.
10. **Missing docs.** Behaviour that exists and is documented nowhere: the trigger-order
    system, authority rotation, `set_market_oracle`, the faucet, and the API routes are
    candidates. An undocumented instruction that moves value is P3; a documented
    invariant that exists only in a code comment is P3.

---

## 8. Dependency and ordering

The thirteen slices are **fully parallel**. There are no blocking edges: every slice can
be dispatched at once and none needs another's output to start. The frontier is total —
thirteen disjoint file sets, thirteen disjoint output paths, no shared mutable state.

**Ruling: S6 is not ordered after S1–S5.** It was proposed at harden that S6 (SDK layout
parity) should wait for S1–S5 "to establish the true on-chain layouts." Rejected, with a
reason. S6's Rust side comes from `programs/slipstream/src/state/*.rs` — twelve
`#[repr(C)]` declarations it reads directly, which §4 explicitly permits — and **no
S1–S5 deliverable publishes a layout table**. Their findings files carry threat-class
records, not offsets. The edge would serialise five slices in front of the highest
value-per-hour slice in the run and hand it nothing it does not already have. If S6
finds a layout defect it files it; if S1–S5 stumble on one they route it to S6 as a
cross-slice note. That is the whole coordination requirement.

Six soft producer/consumer contracts exist. The consumer must not block on the
producer; it re-derives what it needs and the orchestrator reconciles at merge:

| Producer | Artifact | Consumer |
|---|---|---|
| S1 | The owner-vs-session-key boundary contract (`S1-C5`) | S2 (`S2-C10`, on-chain), S9 (`S9-C1`, client-side) |
| S4 | The list of fill fields L1 re-validates vs. takes on faith (`S4-C8`) | S5 (`S5-C2`, ER capability table) |
| S5 | The delegation inventory (`S5-C1`) | S11 (`S11-C8`, is it tested?) |
| S5 | The mark-price staleness contract (`S5-C7`) | S3 (`S3-C13`) |
| S9 | Per-hook poll interval and data-source map (`S9-C5`) | S13 (`S13-C1`, per-number source table) |
| S8 | What `/api/status` actually measures (`S8-C7`) | S13 (`S13-C2`, stale and error states) |

S12 receives routed doc-halves from S5, S7, S10, and S11 via Cross-slice notes.

Each producer publishes its contract as a clearly headed block inside its own findings
file so a consumer that *does* run later can read it. A consumer that runs concurrently
re-derives it from source and notes that it did; the orchestrator reconciles any
disagreement at merge, and a disagreement between a producer's contract and a consumer's
re-derivation is itself a finding worth surfacing.

---

## 9. Run-level done

The run is complete when:

1. All thirteen findings files exist at `docs/audit/audit-e2e/s1.md` … `s13.md` and each
   satisfies its slice's Done.
2. Every Cross-slice note has been routed and either merged into the target slice's file
   or recorded as unresolved with a reason.
3. The orchestrator has produced a consolidated report — every finding across all
   thirteen slices, sorted by severity then tag, with the CONFIRMED/SUSPECTED split
   stated per severity band.
4. Every CONFIRMED P0 and P1 has a tracker issue. P2 and P3 are batched into thematic
   issues rather than filed individually.
5. **No product code, test, or doc file has been modified by this run.** The run diff
   touches only `docs/spec/audit-e2e.md`, `docs/checks/audit-e2e/**`, `docs/audit/**`,
   and the tracker.

   The draft omitted `docs/checks/audit-e2e/**`, which contradicted the freeze protocol:
   the frozen checks are committed to the factory branch before any auditor is
   dispatched, so they are necessarily in the run diff. `docs/runs/` and `docs/jobs/` are
   gitignored and never appear in it.

An audit that finds nothing is a valid outcome **only** if every slice's `## Cleared`
section demonstrates it looked. Given K1, K2, K3, K5, and K7 are established before the
run starts, a slice covering any of them that returns zero findings has not done the
work — §4's minimum-one-finding rule makes that mechanical for S5, S6, S7, S8, S10, S12.
