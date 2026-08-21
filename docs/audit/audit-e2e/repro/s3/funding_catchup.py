#!/usr/bin/env python3
"""S3 repro: what one permissionless `compute_funding` call does to the LIVE
devnet market ECUp8pXzVLzxjVs8mtKBJma3mdcHf8zSC4cqPeBy8MPy.

Scratch audit code. Never wired into any test suite. Read-only: it decodes a
snapshot of the market account taken over public devnet RPC and replays, in
Python, the exact integer arithmetic the program performs. Every step below
cites the Rust line it mirrors.

Run:  python3 docs/audit/audit-e2e/repro/s3/funding_catchup.py
"""
import base64
import json
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = os.path.join(HERE, "market-ECUp8p-devnet-2026-08-21T19-13-46Z.json")

FUNDING_SCALE = 10**18                     # math/fixed_point.rs:14
INTEREST_RATE_PER_INTERVAL = 10**14        # math/funding.rs:7
BASE_SCALE = 10**9                         # math/fixed_point.rs:12
PRICE_SCALE = 10**6                        # math/fixed_point.rs:5


def idiv(a, b):
    """Rust integer division: truncates TOWARD ZERO (Python // floors)."""
    q = abs(a) // abs(b)
    return q if (a < 0) == (b < 0) else -q


# ---------------------------------------------------------------- live state
raw = base64.b64decode(json.load(open(SNAP))["result"]["value"]["data"][0])
u16 = lambda o: struct.unpack_from("<H", raw, o)[0]
u64 = lambda o: struct.unpack_from("<Q", raw, o)[0]
i64 = lambda o: struct.unpack_from("<q", raw, o)[0]

twap_count = u16(12)
stamp = u16(14)                       # Market::mark_price_minute, state/market.rs:142
funding_interval_secs = u64(160)
last_funding_ts = i64(168)
oi_long, oi_short = u64(176), u64(184)
insurance = u64(192)
last_mark_price = u64(200)
cum_index = (i64(216) << 64) | i64(208) & 0xFFFFFFFFFFFFFFFF   # state/market.rs:60-63
twap_prices = [u64(224 + 8 * i) for i in range(225)]

# Market::get_twap(), state/market.rs:123-134 -- the value compute_funding uses
# as the MARK (instructions/compute_funding.rs:49-52).
mark = sum(twap_prices[:twap_count]) // twap_count

# Observed over public devnet RPC at the same moment (see the findings file for
# the raw reads). Switchboard's result.value is 0, so oracle.rs:262-271 takes the
# Pyth-only fallback and the index price is Pyth's.
NOW = 1787339626                 # 2026-08-21T19:13:46Z
PYTH_6DP = 91_317_865            # $91.317865, publish_ts 44 s old => is_fresh() true

print("=== live market state (devnet, 2026-08-21T19:13:46Z) ===")
print(f"  last_mark_price        {last_mark_price:>22,}  (${last_mark_price/1e6:,.6f})")
print(f"  mark_price_minute      {stamp:>22,}")
print(f"  get_twap()             {mark:>22,}  (${mark/1e6:,.6f})")
print(f"  pyth index price       {PYTH_6DP:>22,}  (${PYTH_6DP/1e6:,.6f})")
print(f"  funding_interval_secs  {funding_interval_secs:>22,}")
print(f"  last_funding_ts        {last_funding_ts:>22,}")
print(f"  cumulative index       {cum_index:>22,}  ({cum_index/1e18:+.9f})")
print(f"  open_interest_long     {oi_long:>22,}  ({oi_long/1e9:,.3f} SOL)")
print(f"  open_interest_short    {oi_short:>22,}  ({oi_short/1e9:,.3f} SOL)")
print(f"  insurance_fund_balance {insurance:>22,}  (${insurance/1e6:,.6f})")

# ---------------------------------------------- Market::is_mark_price_fresh
# state/market.rs:154-161
now_min = (NOW // 60) % 65536
age_min = (now_min - stamp) % 65536
fresh = age_min <= 30                              # MARK_PRICE_MAX_STALENESS_MINS
print("\n=== Market::is_mark_price_fresh (state/market.rs:154-161) ===")
print(f"  now_min {now_min}  stamp {stamp}  wrapping_sub {age_min} min "
      f"({age_min/1440:.1f} days)  fresh={fresh}")
print(f"  => mark_price_for_close() returns {'Some(..)' if fresh else 'None'} "
      "(state/market.rs:173-183)")
assert not fresh, "expected the live mark to be stale"

# ------------------------------------------- instructions/compute_funding.rs
elapsed = NOW - last_funding_ts                     # compute_funding.rs:37
assert elapsed >= funding_interval_secs             # compute_funding.rs:38-40
intervals = elapsed // funding_interval_secs        # compute_funding.rs:41

# math/funding.rs:15-34
premium_rate = idiv((mark - PYTH_6DP) * FUNDING_SCALE, PYTH_6DP)   # funding.rs:23-26
rate_per_interval = premium_rate + INTEREST_RATE_PER_INTERVAL      # funding.rs:29-31
total_rate = rate_per_interval * intervals                         # compute_funding.rs:71-73
new_index = cum_index + total_rate                                 # compute_funding.rs:77-80

print("\n=== one permissionless compute_funding call (disc 0x06) ===")
print(f"  elapsed              {elapsed:,} s ({elapsed/86400:.2f} days)")
print(f"  intervals            {intervals}                <- UNCAPPED "
      "(compute_funding.rs:41)")
print(f"  premium_rate         {premium_rate:,}  ({premium_rate/1e18:+.6%} per interval)"
      "   <- UNCAPPED (funding.rs:23-26)")
print(f"  rate_per_interval    {rate_per_interval:,}  ({rate_per_interval/1e18:+.6%})")
print(f"  x {intervals} intervals      {total_rate:,}  ({total_rate/1e18:+.4%} of notional)")
print(f"  new cumulative index {new_index:,}  ({new_index/1e18:+.6f})")
assert intervals == 48
assert total_rate / 1e18 < -9.0, "expected a catastrophic negative jump"

# ------------------------------ math/funding.rs:45-80 compute_funding_payment
def funding_payment(size_atoms, index_now, snapshot, mark_price):
    if size_atoms == 0:
        return 0
    delta = index_now - snapshot                                    # funding.rs:55-57
    abs_notional = idiv(abs(size_atoms) * mark_price, BASE_SCALE)   # fixed_point.rs:53-62
    signed = abs_notional if size_atoms > 0 else -abs_notional      # funding.rs:66-70
    return idiv(signed * delta, FUNDING_SCALE)                      # funding.rs:74-77


# A crank restart refreshes last_mark_price/stamp (crank_twap.rs:71-76); the
# poisoned index is already committed, so the claim settles at the FRESH mark.
ONE_SOL = 1_000_000_000
long_pay = funding_payment(ONE_SOL, new_index, cum_index, PYTH_6DP)
short_pay = funding_payment(-ONE_SOL, new_index, cum_index, PYTH_6DP)
notional_1sol = idiv(ONE_SOL * PYTH_6DP, BASE_SCALE)

print("\n=== what each side then claims (claim_funding.rs:66-104) ===")
print(f"  1 SOL notional at the fresh mark: ${notional_1sol/1e6:,.2f}")
print(f"  long  1 SOL -> payment {long_pay:>18,}  "
      f"=> CREDITED ${-long_pay/1e6:,.2f}  (claim_funding.rs:99-104)")
print(f"  short 1 SOL -> payment {short_pay:>18,}  "
      f"=> DEBITED  ${short_pay/1e6:,.2f}  (claim_funding.rs:88-98)")
print(f"  credit is {-long_pay/notional_1sol:,.1f}x the position's own notional")
assert long_pay < 0 and short_pay > 0
assert -long_pay > 8 * notional_1sol

whole_book_long = funding_payment(oi_long, new_index, cum_index, PYTH_6DP)
print(f"\n  entire long OI ({oi_long/1e9:,.1f} SOL) is credited "
      f"${-whole_book_long/1e6:,.2f}")
print(f"  insurance fund holds  ${insurance/1e6:,.2f}")
print(f"  ratio: {-whole_book_long/insurance:,.0f}x the insurance fund")

# ------------------------------- claim_funding.rs:88-98 silently forgives debt
print("\n=== claim_funding debit saturation (claim_funding.rs:88-98) ===")
free_collateral, pos_collateral = 50_000_000, 25_000_000     # $50 free, $25 in position
owed = short_pay
shortfall = owed - free_collateral
after_pos = max(0, pos_collateral - shortfall)               # saturating_sub, line 97
forgiven = shortfall - (pos_collateral - after_pos)
print(f"  short owes ${owed/1e6:,.2f}; has ${free_collateral/1e6:,.2f} free + "
      f"${pos_collateral/1e6:,.2f} in the position")
print(f"  after the claim: free=$0.00  position collateral=${after_pos/1e6:,.2f}")
print(f"  SILENTLY FORGIVEN: ${forgiven/1e6:,.2f}  "
      "(no insurance debit, no log, no error)")
assert after_pos == 0 and forgiven > 0

# ---------------- liquidate_position.rs:187-237 -- the bonus nobody receives
print("\n=== liquidator bonus (liquidate_position.rs:187-237) ===")
collateral, upnl, funding = 100_000_000, -95_000_000, 0
size, mark_px = 10 * ONE_SOL, 90_000_000
notional = idiv(size * mark_px, BASE_SCALE)                  # fixed_point.rs:53-62
bonus_bps = idiv(notional * 50, 10_000)                      # apply_bps, fixed_point.rs:78-87
net_collateral = max(0, collateral + upnl - funding)
bonus = min(bonus_bps, net_collateral // 5)                  # line 189-193
settlement = collateral + upnl - funding - bonus             # line 203-206
print(f"  notional ${notional/1e6:,.2f}  50bps=${bonus_bps/1e6:,.2f}  "
      f"20% of net=${net_collateral//5/1e6:,.2f}  -> bonus ${bonus/1e6:,.2f}")
print(f"  trader credited ${settlement/1e6:,.2f} (bonus deducted, line 206)")
print("  liquidator credited: $0.00 -- `liquidator_bonus` is referenced on exactly")
print("  two lines of the file (193, 206) and neither pays anybody.")
print(f"  => ${bonus/1e6:,.2f} of the trader's collateral is destroyed, and it is")
print("     not added to insurance_fund_balance either.")
assert bonus > 0

print("\nALL ASSERTIONS PASSED")
