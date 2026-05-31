# 3 · Ephemeral Rollups & Delegation

> What a MagicBlock Ephemeral Rollup actually is, what "delegation", "commit",
> and "undelegate" mean, the hard limits that shaped Slipstream's design, and
> why **only the OrderBook** is delegated.

---

## 3.1 The problem an ER solves

Solana L1 is secure and decentralized but slow (~400 ms blocks) and costs
lamports per transaction. A CLOB matching engine needs thousands of cheap,
sub-second writes. These goals conflict.

A **MagicBlock Ephemeral Rollup (ER)** resolves the conflict by being a temporary,
high-speed execution environment that runs **the same Solana program** against a
**delegated subset** of accounts, at ~10 ms block times and sponsored
(negligible) cost. It's "ephemeral" because it's spun up for a session and its
authoritative results are periodically folded back into L1.

Think of it as: *L1 is the bank vault; the ER is a fast trading floor that's
allowed to shuffle a few specific ledgers, and every so often it photocopies
those ledgers back into the vault.*

---

## 3.2 The three verbs: delegate, commit, undelegate

These are the only ER operations that matter for understanding Slipstream.

**Delegate.** An L1 account is handed to the ER. After delegation, the ER (not
L1) is the authority that may mutate that account. On L1 the account is marked as
delegated to MagicBlock's delegation program (`DELeGGvXpWV2fqJUEqsQa…`). In
Slipstream this happens for the OrderBook at deploy time and for each
`TradingCredit` at session start.

**Commit.** The ER writes the account's current state back to L1 — a snapshot.
The account *stays delegated*; commit is just "save progress to the base layer."
This is triggered on-chain via MagicBlock's magic program (`Magic11111…`) using a
**ScheduleCommit** CPI. In Slipstream, the small FillLog is committed; the giant
OrderBook is **never** committed.

**Undelegate.** The ER hands the account *back* to L1 and L1 resumes as the
authority. Typically a commit-then-undelegate. For Slipstream, undelegating the
OrderBook is **impossible in practice** (§3.4), so the book stays delegated for
its entire life.

```
   L1 account ──delegate──▶ ER is authority
        ▲                        │
        │                    (mutations at ~10 ms)
        │                        │
        └────commit (snapshot)◀──┤   account STAYS delegated
        │                        │
        └────undelegate──────────┘   L1 resumes authority
```

---

## 3.3 The sponsored-commit cap (the limit that broke settlement)

This is the constraint that defined the whole settlement design, and it was
**verified live**, not assumed.

> A delegated account on the public MagicBlock devnet node can be **commit-ed at
> most 10 times** ("sponsored commit cap"). After 10 commits the account is
> capped and further `ScheduleCommit`s fail.

Findings from live testing (recorded in `.superstack/fill-log-settlement-SOLVED.md`):

- The cap is a **hard 10 commits per delegated account** — *not* per payer.
- **Funding an ephemeral-balance escrow did NOT lift it.** Trying to pay for
  commits from a funded delegated account still failed at the 10th commit on the
  public devnet node.
- The cap is **per account**, proven by rotation: a fresh account (new epoch PDA)
  gets its own fresh budget of 10. epoch 0 committed exactly 10 then capped;
  epoch 1 (a brand-new PDA) got another full 10.

That last point is the escape hatch — see doc 4's **epoch rotation**. The fix
isn't to lift the cap, it's to keep minting fresh small accounts, each with its
own budget.

---

## 3.4 Why the OrderBook can never be undelegated

You might think: "if commits are capped, just undelegate and re-delegate to
reset." For the 612 KB OrderBook this is **impossible**, for several compounding
reasons:

1. **The 10,240-byte growth cap (doc 2).** Undelegation/redelegation paths
   involve account-data operations bounded by `MAX_PERMITTED_DATA_INCREASE`
   (10,240 bytes). A 626,736-byte account blows through that cap by ~61×.
2. **No clean callback / stale ABI.** The undelegate path for an account this
   size doesn't complete cleanly on the deployed devnet stack.
3. **It defeats the point.** Undelegating the book moves it fully to L1 — which
   is exactly the slow, expensive place we delegated it *away from*. The whole
   premise is "the book lives in the fast ER." (This was the user's explicit
   reasoning: keep it in the ER, never drag the whole thing back to L1.)

**Conclusion:** the OrderBook is delegated **once, at deploy, forever.** It is
never committed and never undelegated. That decision is *why* settlement can't
ride on the book and needs the FillLog (doc 4).

---

## 3.5 Why only the OrderBook is delegated (the safety boundary)

This is the heart of Slipstream's trust model. Delegation hands mutation
authority to the ER, which on devnet means trusting the MagicBlock operator. So
the rule is: **delegate only what is safe to lose.**

- **Delegated:** the `OrderBook` (order ordering — non-financial) and, during a
  session, each `TradingCredit` (a *scoped* margin allowance, not the user's
  whole balance).
- **Never delegated:** `Position`, `UserAccount.free_collateral`, the
  `insurance_fund`, and the **token vault** holding everyone's USDC. These live
  on L1 and only L1 instructions move them.

> **The entire safety guarantee in one sentence:** because funds never leave L1,
> a buggy or malicious ER can at worst corrupt order *ordering* — it can never
> move a single token of anyone's money.

The root README's Trust Model states this as Requirement 9.1: *"the OrderBook
delegation is the entire safety boundary."* Slipstream does **not** implement
on-chain fraud proofs or a re-execution verifier (that's a documented pre-mainnet
gap). The safety doesn't come from proving the ER honest; it comes from never
giving the ER anything valuable to steal.

---

## 3.6 The MagicBlock programs you'll see

| Program | Address (prefix) | Role |
|---|---|---|
| Delegation program | `DELeGGvXpWV2fqJUEqsQ…` | Records that an L1 account is delegated; enforces delegation scope + session timeout. |
| Magic program | `Magic11111…` | Target of `ScheduleCommit` / undelegate CPIs from inside the ER. |

Note what the delegation program provides and what it doesn't: it gives
**delegation-scope isolation and a session timeout** — *not* on-chain fraud
proofs. That's consistent with §3.5: safety is the OrderBook-only boundary, not a
verifier.

---

## 3.7 Speed tradeoffs of this model (honest)

The split buys speed but isn't free:

- **Trading itself is fast and unaffected.** Place/cancel/match happen in the ER
  at ~10 ms. Commits are *asynchronous snapshots*, never on the trade path.
- **Settlement has latency.** A fill becomes a real L1 position a few seconds
  later (ER commit → L1 lands → `settle_from_log`), and in batches. The frontend
  hides this by showing the position instantly from ER state ("pending
  settlement") while L1 catches up.
- **Per-commit cost + epoch churn.** Each commit costs ~0.0001 SOL and each epoch
  rotation abandons a tiny (~8 KB) FillLog's rent. Negligible on devnet.
- **Operator trust (devnet).** The ER is run by MagicBlock on devnet; there's no
  mainnet ER endpoint. This is a devnet-scoped MVP by definition (Trust Model
  Req 9.2).

---

## 3.8 Takeaways

- An **ER** runs the same program against **delegated** accounts at ~10 ms,
  sponsored cost; **commit** snapshots state to L1; **undelegate** returns
  authority to L1.
- The public devnet node enforces a **hard 10-commit-per-account cap**; funding
  an escrow doesn't lift it; a fresh account gets a fresh budget (→ epoch
  rotation, doc 4).
- The 612 KB OrderBook is **delegated once forever** — never committed, never
  undelegated (the 10 KB growth cap + the whole premise forbid it).
- **Only non-financial state is delegated.** Funds stay on L1, so the ER can
  never move money. That OrderBook-only boundary *is* the security model.
- Next: how fills cross from ER to L1 without ever committing the book →
  [doc 4](./04-settlement-and-the-fill-log.md).
