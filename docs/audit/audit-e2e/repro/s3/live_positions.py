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

# The ONLY price `liquidate_position` uses: apply_dual_oracle's live reading
# (liquidate_position.rs:91-101). `claim_funding` and `close_position` do NOT
# see this number -- they read Market.last_mark_price via mark_price_for_close.
ORACLE_PX = 91_317_865       # live Pyth, 6-dp, publish_ts 44 s old
LAST_MARK = 74_114_120       # Market.last_mark_price, frozen 16 d ago; the price
                             # claim_funding would use IF the crank ever resumes
MAX_LEVERAGE = 20            # Market.max_leverage, on chain
CUR_INDEX = -38_671_621_383_128_857          # Market cumulative funding index today
POISONED_INDEX = -9_120_169_729_644_858_361  # after one compute_funding call (see funding_catchup.py)
VAULT_USDC = 655_915_845_954                 # BTWVG5oD... token balance, 6-dp
INSURANCE = 20_725_715                       # Market.insurance_fund_balance
LIQ_THRESHOLD = 1.0                          # HEALTH_FACTOR_LIQUIDATION_THRESHOLD


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

def liquidate(p, index):
    """One `liquidate_position` call, replayed line for line.

    Every price here is ORACLE_PX: liquidate_position takes apply_dual_oracle's
    live reading (:91-101) and never calls mark_price_for_close, so unlike
    claim_funding / close_position it is NOT blocked by the dead crank.
    Returns (health, settlement) -- settlement is the signed i128 at :203-206.
    """
    n = notional(p["size"], ORACLE_PX)                   # :132
    maint = (n // MAX_LEVERAGE) // 2                     # :133-134, fixed_point.rs:65-75
    diff = (ORACLE_PX - p["entry"]) if p["size"] > 0 else (p["entry"] - ORACLE_PX)
    upnl = idiv(diff * abs(p["size"]), BASE_SCALE)       # :136, fixed_point.rs:94-113
    fund = funding_payment(p["size"], index, p["snapshot"], ORACLE_PX)   # :138-143
    h = health(p["collateral"], upnl, -fund, maint)      # :150-155, note the negation
    bonus_bps = idiv(n * 50, 10_000)                     # :189, apply_bps
    net = max(0, p["collateral"] + upnl - fund)          # :190-191
    bonus = min(bonus_bps, net // 5)                     # :192-193
    return h, p["collateral"] + upnl - fund - bonus      # :203-206


# ------------------------------------------------ who is liquidatable RIGHT NOW
print("\n=== liquidate_position health at the live oracle ($91.317865) ===")
liq_now = [p for p in positions
           if (lambda h: h is not None and h < LIQ_THRESHOLD)(liquidate(p, CUR_INDEX)[0])]
for p in liq_now:
    h, settle = liquidate(p, CUR_INDEX)
    print(f"  {p['key']}  size {p['size']/1e9:>8.3f} SOL  "
          f"collateral ${p['collateral']/1e6:>8.2f}  health {h:.3f}")
print(f"  => {len(liq_now)} of {len(positions)} positions are liquidatable NOW.")
print("     Their owners cannot call close_position at all: mark_price_for_close()")
print("     returns None (state/market.rs:173-183) so it errors OracleStale.")
assert liq_now, "expected at least one liquidatable position"

# ------------- what one compute_funding call does, THROUGH liquidate_position
# This is the money path that executes on the deployment as it stands: it is
# permissionless, it prices off apply_dual_oracle, and it credits/charges
# UserAccount.free_collateral and insurance_fund_balance with no dependency on
# mark_price_for_close anywhere in the file.
print("\n=== after one permissionless compute_funding call, via liquidate_position ===")
liq_after, deficit_total, credited_total = [], 0, 0
for p in positions:
    h, settle = liquidate(p, POISONED_INDEX)
    if h is None or h >= LIQ_THRESHOLD:
        continue                                         # :157-163 HealthFactorAboveThreshold
    liq_after.append(p)
    if settle > 0:
        credited_total += settle                         # :222-226
    else:
        deficit_total += -settle                         # :227-237

n_short = sum(1 for p in positions if p["size"] < 0)
wiped = sum(p["collateral"] for p in liq_after)
print(f"  liquidatable BEFORE the call: {len(liq_now)} of {len(positions)}")
print(f"  liquidatable AFTER  the call: {len(liq_after)} of {len(positions)}  "
      f"({len(liq_after)} of the {n_short} shorts; the other "
      f"{n_short-len(liq_after)} are over-collateralised enough to survive)")
print(f"  their collateral, zeroed by :211 with no payout:  ${wiped/1e6:>12,.2f}")
print(f"  settlement deficit beyond that collateral:        ${deficit_total/1e6:>12,.2f}")
print(f"  insurance_fund_balance available to absorb it:    ${INSURANCE/1e6:>12,.2f}")
print(f"  => insurance fund drained to $0.00 (:230-231), and "
      f"${(deficit_total-INSURANCE)/1e6:,.2f} is booked")
print("     as protocol bad debt by the else-branch at :232-236 -- no ADL, no log.")
print(f"  credited to free_collateral by :222-226 on this path: "
      f"${credited_total/1e6:,.2f}")
assert all(p["size"] < 0 for p in liq_after), "only shorts are forced liquidatable"
assert len(liq_after) > len(liq_now), "the call forces new liquidations"
assert credited_total == 0, "no long is liquidatable at the poisoned index"
assert deficit_total > 1000 * INSURANCE

# ------------------------------------------ the OTHER side: latched, not payable
# LATCHED, NOT REACHABLE-NOW. claim_funding does not read the oracle at all: it
# prices off market.mark_price_for_close(now) (claim_funding.rs:61-63), which is
# None today, so the instruction errors OracleStale and pays nobody (S3-03).
#
# The block below is the IF-THE-CRANK-RESUMES case, and it is the input S3-05
# quotes. crank_twap.rs:71-72 sets last_mark_price := the then-fresh Pyth price,
# so it is priced at ORACLE_PX -- i.e. it assumes the crank restarts while Pyth
# still reads $91.317865. At the last_mark_price actually stored on the market
# today ($74.114120) the same credit is smaller; both are printed.
print("\n=== IF crank_twap resumes: claim_funding at the refreshed last_mark_price ===")
print("    (latched: today claim_funding.rs:61-63 errors OracleStale -- see S3-03)")
long_coll = sum(p["collateral"] for p in positions if p["size"] > 0)
short_coll = sum(p["collateral"] for p in positions if p["size"] < 0)
credit = -sum(funding_payment(p["size"], POISONED_INDEX, p["snapshot"], ORACLE_PX)
              for p in positions if p["size"] > 0)
owed = sum(funding_payment(p["size"], POISONED_INDEX, p["snapshot"], ORACLE_PX)
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

at_stored = -sum(funding_payment(p["size"], POISONED_INDEX, p["snapshot"], LAST_MARK)
                 for p in positions if p["size"] > 0)
print(f"\n  same credit at the last_mark_price stored TODAY ($74.114120): "
      f"${at_stored/1e6:,.2f}")
print("  neither figure is reachable-now; the reachable-now money is the")
print("  liquidate_position block above.")
assert at_stored < credit

print("\nALL ASSERTIONS PASSED")
