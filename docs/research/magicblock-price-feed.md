# Replacing Pyth with the MagicBlock (Pyth Lazer) price feed

**Date:** 2026-07-17 · **Status:** research, no code changed

## Brief

SlipStream's on-chain program hand-rolls a Pyth `PriceUpdateV2` parser plus a Switchboard
parser (`programs/slipstream/src/oracle.rs`), with a devnet Pyth-only fallback. Question:
can MagicBlock's 50ms Pyth-Lazer feed replace Pyth, what does it cost, and what breaks?
"Answered" = PDA/layout/feed IDs verified against primary sources, cluster availability
confirmed, trust model spelled out against what `dual_oracle_read` guarantees today.

## Answer first

**Not as a drop-in, and the blocker isn't parsing — it's which cluster the code runs on.**

The parsing is a non-issue: MagicBlock's feed account is byte-compatible with Pyth's
`PriceUpdateV2`, and SlipStream's existing `parse_pyth` already lands in the right branch.

The blocker is that all three oracle-consuming instructions — `liquidate_position`,
`compute_funding`, `crank_twap` — run on **L1 devnet**, and MagicBlock's feed only carries
live data **inside the Ephemeral Rollup**. On L1 the same account is owned by the delegation
program with `price = 0` and a 15-month-stale timestamp.

Pointing `market.pyth_feed` at `ENYweb...` today would make **every liquidation, funding
crank, and TWAP crank fail** with `OracleStale` (the `price_raw <= 0` guard at
`oracle.rs:92`). The market would freeze.

Getting the 50ms feed into liquidation requires delegating `market` and every `position`
into the ER and running those instructions there. That's an architecture migration, not an
oracle swap.

## Evidence

### 1. The account layout is already compatible — VERIFIED

MagicBlock's `ephemeral-oracle` program declares `PriceUpdateV3`, which is field-for-field
identical to Pyth's `PriceUpdateV2` (`write_authority`, `verification_level`,
`price_message`, `posted_slot`). Both are 134 bytes on-chain. Their own README tells
consumers to read it with `PriceUpdateV2::try_deserialize_unchecked()` [S2].

Offsets confirmed empirically against the live devnet ER account: `price` i64 @ 73,
`exponent` i32 @ 89, `publish_time` i64 @ 93 — exactly what `oracle.rs:88-90` already reads.
`len = 134` clears the `>= 134` check at `oracle.rs:86` and misses the `>= 248` legacy branch.

**Implication:** no parser work needed. **What would change this:** MagicBlock migrating to a
genuine V3 layout that appends fields before `posted_slot`.

### 2. Exponent sign is INVERTED vs Pyth — VERIFIED, and it would break us

MagicBlock stores `exponent = +8`; the correct price needs `10^(-exponent)`. Pyth stores
`-8` and uses `10^(exponent)`. Their own sample compensates: `10_f64.powi(-price.exponent)`
[S2, lib.rs:247].

Measured 2026-07-17 (devnet ER): SOL `expo=+8` → $74.68 · BTC `expo=+8` → $62,939.58 ·
ETH `expo=+8` → $1,831.85. Live Pyth feed `7UVim...` on the same cluster: `expo=-8`.

`normalise_to_6_decimals` would compute `exp_diff = 8 - (-6) = 14` → `raw * 10^14` →
overflow → `MathOverflow`. **Fails safe rather than mispricing**, but it does mean the swap
is not zero-code even ignoring the cluster problem.

**Caution:** a consumer using `pyth_solana_receiver_sdk`'s `get_price_no_older_than()` plus
the standard `price * 10^expo` gets a number off by 10^16. MagicBlock's README recommends
exactly that SDK without flagging the sign flip.

### 3. PDA derivation — VERIFIED (the blog is misleading)

Seeds are `["price_feed", provider, symbol]` where `symbol` is the **decimal string of
`pyth_lazer_id`** — not a symbol name, not a 32-byte feed ID [S2, instructions.rs:14-22].

All four published addresses reproduce exactly:

| Feed | id | seed | Derived address | Expo | Channel |
|---|---|---|---|---|---|
| SOL/USD | 6 | `"6"` | `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` | -8 (stored +8) | 50ms |
| BTC/USD | 1 | `"1"` | `71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr` | -8 | 50ms |
| ETH/USD | 2 | `"2"` | `5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG` | -8 | 50ms |
| USDC/USD | 7 | `"7"` | `Ekug3x6hs37Mf4XKCDptvRVCSCjJCAD7LKmKQXBAa541` | -8 | 50ms |

Program: `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`. Provider: `"pyth-lazer"`. 125 feeds
in `pyth_lazer_list.json`. The blog's `"price feed"` (with a space) is a typo — the code says
`b"price_feed"` [S2, lib.rs:23]. The blog's "buffer of the feedID" is technically right but
reads as if it means a hex feed ID; it's `"6"`.

### 4. Availability: live in ER, dead on L1 — VERIFIED, this is the crux

Measured 2026-07-17 for SOL/USD `ENYweb...`:

| Cluster | Owner | price | Age |
|---|---|---|---|
| Solana devnet L1 | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` (delegation program) | **0** | **~15 months** |
| MagicBlock devnet ER | `PriCems5t...` (oracle program) | 7466500050 → $74.67 | **0–1s** |
| MagicBlock mainnet ER | `PriCems5t...` | 7466678817 → $74.67 | ~11s |

Mainnet is real: same address, and the program is deployed on mainnet-beta L1.

Against SlipStream's actual delegation state:

| Account | L1 owner | ER owner | Writable where |
|---|---|---|---|
| `market` | program | program | **L1 only** (undelegated → read-only clone in ER) |
| `orderBook` | delegation program | program | **ER only** |
| Pyth `7UVim...` | Pyth receiver | Pyth receiver | live on **both** (age ~10–17s) |
| MagicBlock `ENYweb...` | delegation program | oracle program | live in **ER only** |

`liquidate_position` and `compute_funding` mutate `market.restricted_mode` /
`agreement_streak`; `crank_twap` writes the TWAP buffer. Those writes require L1. The
MagicBlock price requires the ER. **Mutually exclusive today.**

Worth noting: the existing Pyth feed is *already* cloned live into the ER at ~10s age, so
the ER isn't what's blocking Pyth — moving instructions into the ER wouldn't force an oracle
change at all.

### 5. Trust model is a real downgrade — VERIFIED from source

`update_price_feed` calls `ensure_oracle`, which is `require_keys_eq!(payer.key(),
ORACLE_IDENTITY)` against the single hardcoded key
`MPUxHCpNUy3K1CSVhebAmTbcTCKVxfk9YMDcUP2ZnEA` [S2, lib.rs:22,62,380-384].

The `UpdateData` struct carries `r`, `s`, `v` and `publisher_merkle_root` — and
`update_price_feed` **ignores all of them**. It writes
`update_data.temporal_numeric_value.quantized_value` straight into the account with no
signature or merkle verification. It then sets `verification_level = VerificationLevel::Full`
unconditionally — so the account *claims* full Pyth verification while verifying nothing, and
`get_price_no_older_than()` will accept it as Full.

`conf = 0` and `ema_price = 0` always (`update_price_feed` preserves `..prev` from init).

**Implication for SlipStream specifically:** the dual-oracle + divergence + hysteresis design
in `oracle.rs` exists precisely to avoid trusting one price source. MagicBlock's feed is one
MagicBlock-controlled keypair with no on-chain attestation — strictly weaker than the Pyth
receiver's verified path. Adopting it as the primary feed for liquidations trades a verified
oracle for a trusted-operator oracle. That is a governance decision, not a perf tweak.

**What would change this:** MagicBlock verifying Lazer's ECDSA signature on-chain, or
publishing a multi-pusher/quorum design.

## What you'd actually gain

Freshness: ~0–1s (MagicBlock ER) vs ~10–17s (Pyth L1). Real, but only realizable for logic
executing in the ER. While `liquidate_position` runs on L1 against 400ms slots and an
L1-resident `market`, a 50ms oracle buys nothing — the oracle is not the bottleneck.

## Recommendation

Two honest options, depending on the actual goal:

1. **If the goal is a faster-looking chart** (the blog's own use case): swap the frontend's
   Pyth stream (`frontend/src/hooks/use-pyth-stream.ts`) for a WS subscription to the
   MagicBlock ER feed account. Read-only, no funds at risk, no program change, gets the 50ms
   wiggle. Remember `10^(-expo)`. This is a few hours.

2. **If the goal is faster liquidations**: the oracle swap is the last step, not the first.
   It requires delegating `market` + all `position` accounts to the ER and moving
   `liquidate_position` / `compute_funding` / `crank_twap` there — and it costs the
   dual-oracle guarantee unless you keep Pyth's ER clone as the second feed (which is
   available, and would preserve `dual_oracle_read` with MagicBlock as the fast leg and Pyth
   as the divergence check). That combination is the interesting design and nobody's blog
   post describes it.

Do **not** just change `pythFeed` in `deploy.json`.

## Open questions

- Does MagicBlock's mainnet pusher have an uptime/SLA or incident history? Not found —
  resolve by asking in their Discord before any mainnet dependency.
- What happens to the ER feed account during ER downtime or validator rotation — does it
  stall at the last price or become unreadable? Resolve by watching `posted_slot` across an
  ER restart.
- Is the `exponent = +8` sign intentional or a pusher init bug? If it's a bug, a silent fix
  would flip prices by 10^16 for anyone compensating. Worth pinning before depending on it.

## Sources

- [S1] MagicBlock docs, oracle implementation + introduction — https://docs.magicblock.gg/pages/tools/oracle/implementation [primary, accessed 2026-07-17]
- [S2] `magicblock-labs/real-time-pricing-oracle` — program source (`lib.rs`, `state.rs`, `instructions.rs`), `pyth_lazer_list.json`, README — https://github.com/magicblock-labs/real-time-pricing-oracle [primary, accessed 2026-07-17]
- [S3] MagicBlock blog, "How to Build Real-Time Oracles with MagicBlock", 2025-08-19 — https://www.magicblock.xyz/blog/real-time-oracles [secondary; contains the `"price feed"` seed typo]
- [S4] Live chain reads, 2026-07-17: `api.devnet.solana.com`, `devnet.magicblock.app`, `mainnet.magicblock.app`, `api.mainnet-beta.solana.com` [primary]
- [S5] SlipStream source: `programs/slipstream/src/oracle.rs`, `keepers/src/shared/connection.ts`, `keepers/src/{liquidation,funding,twap}-keeper.ts`, `deploy.json` [primary]
