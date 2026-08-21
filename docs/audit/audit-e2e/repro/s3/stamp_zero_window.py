#!/usr/bin/env python3
"""S3 repro: the `stamp == 0` window that permanently disables the stale-mark gate.

Scratch audit code. Never wired into any test suite. Read-only: it replays, in
Python, the exact integer arithmetic of `crank_twap` and `Market::is_mark_price_fresh`
and asserts the state the S3-C13 clearance called unreachable. Every step cites the
Rust line it mirrors. The live `last_mark_price` is decoded from the same devnet
snapshot the other S3 repros use.

Run:  python3 docs/audit/audit-e2e/repro/s3/stamp_zero_window.py
"""
import base64
import json
import os
import struct
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = os.path.join(HERE, "market-ECUp8p-devnet-2026-08-21T19-13-46Z.json")

MARK_PRICE_MAX_STALENESS_MINS = 30   # state/market.rs:16
MOD = 65536                          # the `% 65536` at crank_twap.rs:75
WINDOW_SECS = MOD * 60               # 3,932,160 s = 45.5111 days


def stamp_of(now_ts):
    """crank_twap.rs:75 -- `((now_ts / 60) as u64 % 65536) as u16`."""
    return (now_ts // 60) % MOD


def is_mark_price_fresh(stamp, now_ts):
    """state/market.rs:154-161, verbatim."""
    if stamp == 0:
        return True                                    # :156-158, the escape
    now_min = stamp_of(now_ts)
    return (now_min - stamp) % MOD <= MARK_PRICE_MAX_STALENESS_MINS  # wrapping_sub, :160


def mark_price_for_close(last_mark_price, stamp, now_ts, twap):
    """state/market.rs:173-182."""
    if last_mark_price > 0:
        return last_mark_price if is_mark_price_fresh(stamp, now_ts) else None
    return twap


# ---------------------------------------------------------------- live state
raw = base64.b64decode(json.load(open(SNAP))["result"]["value"]["data"][0])
u16 = lambda o: struct.unpack_from("<H", raw, o)[0]
u64 = lambda o: struct.unpack_from("<Q", raw, o)[0]

live_stamp = u16(14)                 # Market::mark_price_minute, state/market.rs:143-145
last_mark_price = u64(200)
now = int(time.time())

print("=== the gate as it stands on the live market (the S3-02 negative result) ===")
print(f"  stamp {live_stamp}  last_mark_price {last_mark_price:,} (${last_mark_price/1e6:.6f})")
print(f"  age {((stamp_of(now) - live_stamp) % MOD):,} min against a "
      f"{MARK_PRICE_MAX_STALENESS_MINS} min budget")
print(f"  mark_price_for_close -> {mark_price_for_close(last_mark_price, live_stamp, now, None)}")
assert mark_price_for_close(last_mark_price, live_stamp, now, None) is None

# ------------------------------------------------- crank inside the zero window
print("\n=== one crank_twap call inside a stamp==0 window (crank_twap.rs:71-76) ===")
t0 = (now // WINDOW_SECS + 1) * WINDOW_SECS          # start of the next window
for probe in (t0, t0 + 30, t0 + 59):
    assert stamp_of(probe) == 0, probe
print(f"  crank at unix {t0} -> now_min = ({t0} // 60) % {MOD} = {stamp_of(t0)}")
print(f"  crank_twap.rs:72  last_mark_price = {last_mark_price:,}   (non-zero: the "
      "oracle price, guarded non-zero at :49-51)")
print(f"  crank_twap.rs:76  set_mark_price_minute({stamp_of(t0)})")
assert stamp_of(t0) == 0
assert last_mark_price > 0

print("\n=== is_mark_price_fresh at that stamp, for arbitrary age (market.rs:154-161) ===")
for label, ages in (("1 hour", 3600), ("30 days", 30 * 86400),
                    ("1 year", 365 * 86400), ("100 years", 100 * 365 * 86400)):
    later = t0 + ages
    fresh = is_mark_price_fresh(0, later)
    served = mark_price_for_close(last_mark_price, 0, later, None)
    print(f"  age {label:<10} fresh={fresh}   mark_price_for_close -> "
          f"{served:,} (${served/1e6:.6f})")
    assert fresh is True
    assert served == last_mark_price

print("\n  => the gate is off permanently. close_position.rs:119-125, "
      "claim_funding.rs:61-63")
print("     and execute_trigger.rs:78-86 all settle at a mark that never refreshes "
      "again.")

# ---------------------------------------------------------------- wall clock
print("\n=== the next two windows (60 s each, every "
      f"{WINDOW_SECS} s = {WINDOW_SECS/86400:.4f} days) ===")
fmt = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
for k in (1, 2):
    a = (now // WINDOW_SECS + k) * WINDOW_SECS
    print(f"  {fmt(a)} .. {fmt(a + 59)}   (unix {a}..{a + 59})")
    assert stamp_of(a) == 0 and stamp_of(a + 59) == 0
    assert stamp_of(a - 1) != 0 and stamp_of(a + 60) != 0

print(f"\n  crank_twap is permissionless (crank_twap.rs:19-29: no is_signer test on any")
print("  account), so a caller picks the window; a keeper hitting it by accident has")
print(f"  a 60-in-{WINDOW_SECS} chance per crank.")

print("\nALL ASSERTIONS PASSED")
