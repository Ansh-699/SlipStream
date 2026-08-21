#!/usr/bin/env python3
"""S3 repro: the live devnet position set, and what S3-01/S3-05 do to it.

Scratch audit code. Never wired into any test suite. Decodes a snapshot of
`getProgramAccounts(7qujfsb4..., dataSize=96, disc=4)` taken over public devnet
RPC at 2026-08-21T19:20Z and replays the program's own arithmetic on it.

Run:  python3 docs/audit/audit-e2e/repro/s3/live_positions.py
"""
import base64
import json
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = os.path.join(HERE, "positions-devnet-2026-08-21T19-20Z.json")

BASE_SCALE = 10**9
FUNDING_SCALE = 10**18
PRICE_SCALE = 10**6

MARK = 91_317_865            # live Pyth, 6-dp, publish_ts 44 s old
MAX_LEVERAGE = 20            # Market.max_leverage, on chain
CUR_INDEX = -38_671_621_383_128_857          # Market cumulative funding index today
POISONED_INDEX = -9_120_169_729_644_858_361  # after one compute_funding call (see funding_catchup.py)
VAULT_USDC = 655_915_845_954                 # BTWVG5oD... token balance, 6-dp
INSURANCE = 20_725_715                       # Market.insurance_fund_balance


def idiv(a, b):
    """Rust integer division: truncates TOWARD ZERO."""
    q = abs(a) // abs(b)
    return q if (a < 0) == (b < 0) else -q


def notional(size_atoms, price):       # math/fixed_point.rs:53-62
    return idiv(abs(size_atoms) * price, BASE_SCALE)


def funding_payment(size, index_now, snapshot, price):   # math/funding.rs:45-80
    if size == 0:
        return 0
    n = notional(size, price)
    signed = n if size > 0 else -n
    pay = idiv(signed * (index_now - snapshot), FUNDING_SCALE)
    assert -(2**63) <= pay < 2**63, "i64::try_from would reject (funding.rs:79)"
    return pay


def health(collateral, upnl, accrued, maint):            # math/fixed_point.rs:117-138
    if maint == 0:
        return None                                      # u64::MAX -- see S3-08
    net = collateral + upnl + accrued
    if net <= 0:
        return 0.0
    return (net * PRICE_SCALE // maint) / 1e6


positions = []
for a in json.load(open(SNAP))["result"]:
    b = base64.b64decode(a["account"]["data"][0])
    if b[0] != 4:                                        # DISC_POSITION, state/mod.rs:30
        continue
    size = struct.unpack_from("<q", b, 40)[0]
    if size == 0:
        continue
    lo = struct.unpack_from("<q", b, 80)[0]
    hi = struct.unpack_from("<q", b, 88)[0]
    positions.append({
        "key": a["pubkey"],
        "size": size,
        "entry": struct.unpack_from("<Q", b, 48)[0],
        "collateral": struct.unpack_from("<Q", b, 56)[0],
        "snapshot": (hi << 64) | (lo & 0xFFFFFFFFFFFFFFFF),
    })

oi_long = sum(p["size"] for p in positions if p["size"] > 0)
oi_short = -sum(p["size"] for p in positions if p["size"] < 0)
print(f"non-empty positions: {len(positions)}")
print(f"  summed long  {oi_long/1e9:>10,.3f} SOL   (Market.open_interest_long  87.400)")
print(f"  summed short {oi_short/1e9:>10,.3f} SOL   (Market.open_interest_short 94.300)")
assert oi_long == 87_400_000_000 and oi_short == 94_300_000_000, \
    "stored OI counters agree with the actual position set"

# ------------------------------------------------ who is liquidatable RIGHT NOW
# liquidate_position.rs:126-163, priced off the LIVE dual-oracle read, not off the
# frozen Market.last_mark_price that close_position is blocked on.
print("\n=== liquidate_position health at the live oracle ($91.317865) ===")
liq_now = []
for p in positions:
    n = notional(p["size"], MARK)
    maint = (n // MAX_LEVERAGE) // 2                     # fixed_point.rs:65-75
    diff = (MARK - p["entry"]) if p["size"] > 0 else (p["entry"] - MARK)
    upnl = idiv(diff * abs(p["size"]), BASE_SCALE)       # fixed_point.rs:94-113
    fund = funding_payment(p["size"], CUR_INDEX, p["snapshot"], MARK)
    h = health(p["collateral"], upnl, -fund, maint)      # note the negation, line 150-155
    if h is not None and h < 1.0:
        liq_now.append((p["key"], p["size"] / 1e9, p["collateral"] / 1e6, upnl / 1e6, h))
for k, s, c, u, h in liq_now:
    print(f"  {k}  size {s:>8.3f} SOL  collateral ${c:>8.2f}  uPnL ${u:>9.2f}  health {h:.3f}")
print(f"  => {len(liq_now)} of {len(positions)} positions are liquidatable NOW.")
print("     Their owners cannot call close_position at all: mark_price_for_close()")
print("     returns None (state/market.rs:173-183) so it errors OracleStale.")
assert liq_now, "expected at least one liquidatable position"

# --------------------------------- what one compute_funding call does to them
print("\n=== after one permissionless compute_funding call (S3-01) ===")
long_coll = sum(p["collateral"] for p in positions if p["size"] > 0)
short_coll = sum(p["collateral"] for p in positions if p["size"] < 0)
credit = -sum(funding_payment(p["size"], POISONED_INDEX, p["snapshot"], MARK)
              for p in positions if p["size"] > 0)
owed = sum(funding_payment(p["size"], POISONED_INDEX, p["snapshot"], MARK)
           for p in positions if p["size"] < 0)
collectable = min(owed, short_coll)
forgiven = max(0, owed - short_coll)

print(f"  LONG  side  collateral ${long_coll/1e6:>12,.2f}   is CREDITED ${credit/1e6:>12,.2f}")
print(f"  SHORT side  collateral ${short_coll/1e6:>12,.2f}   OWES        ${owed/1e6:>12,.2f}")
print(f"  collectable from shorts (capped by their collateral):  ${collectable/1e6:>12,.2f}")
print(f"  SILENTLY FORGIVEN by saturating_sub, claim_funding.rs:97: ${forgiven/1e6:>10,.2f}")
print(f"  NET new withdrawable claim minted on the vault:        ${(credit-collectable)/1e6:>12,.2f}")
print(f"  vault actually holds                                   ${VAULT_USDC/1e6:>12,.2f}")
print(f"  insurance_fund_balance                                 ${INSURANCE/1e6:>12,.2f}")
assert credit > 70_000_000_000
assert forgiven > 40_000_000_000
assert credit - collectable > INSURANCE * 1000

print("\nALL ASSERTIONS PASSED")
