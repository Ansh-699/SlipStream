#!/usr/bin/env python3
"""S5-C7 producer contract check: does the minute stamp reject the frozen mark?

Read-only. Fetches the live devnet Market, decodes the stamp `crank_twap` writes
(crank_twap.rs:75-76 -> market.rs:146-150) and replays
`Market::is_mark_price_fresh` / `Market::mark_price_for_close`
(market.rs:154-182) against the current on-chain clock.

    python3 docs/audit/audit-e2e/repro/s5/mark_staleness_live.py

This is the contract S3 (S3-C13) reads against. No signer, no mutation.
"""
import base64
import datetime
import json
import struct
import urllib.request

RPC = "https://api.devnet.solana.com"
MARKET = "ECUp8pXzVLzxjVs8mtKBJma3mdcHf8zSC4cqPeBy8MPy"
MARK_PRICE_MAX_STALENESS_MINS = 30  # market.rs:16


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1,
                       "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)["result"]


def main():
    v = rpc("getAccountInfo", [MARKET, {"encoding": "base64"}])["value"]
    m = base64.b64decode(v["data"][0])
    slot = rpc("getSlot", [])
    now_ts = rpc("getBlockTime", [slot])

    stamp = struct.unpack_from("<H", m, 14)[0]        # _padding1
    last_mark = struct.unpack_from("<Q", m, 200)[0]   # last_mark_price
    last_funding = struct.unpack_from("<q", m, 168)[0]

    iso = datetime.datetime.fromtimestamp(now_ts, datetime.UTC).isoformat()
    print(f"market {MARKET}")
    print(f"now_ts={now_ts} ({iso})  slot={slot}")
    print(f"last_mark_price={last_mark} (${last_mark/1e6:.6f})  "
          f"mark_price_minute stamp={stamp}")
    print("last_funding_ts=" + str(last_funding) + " (" +
          datetime.datetime.fromtimestamp(last_funding, datetime.UTC).isoformat() + ")")

    # Market::is_mark_price_fresh, market.rs:154-162
    now_min = (now_ts // 60) % 65536
    age = (now_min - stamp) % 65536
    fresh = stamp == 0 or age <= MARK_PRICE_MAX_STALENESS_MINS
    print(f"now_min={now_min}  wrapping_sub(stamp)={age} minutes "
          f"({age/1440:.2f} days)  threshold={MARK_PRICE_MAX_STALENESS_MINS}")
    print(f"is_mark_price_fresh -> {fresh}")

    # Market::mark_price_for_close, market.rs:173-182
    result = (last_mark if fresh else None) if last_mark > 0 else "get_twap()"
    print(f"mark_price_for_close -> {result}")
    assert not fresh, "stamp reads FRESH -- the gate is not holding, escalate to S3"
    assert result is None
    print("CONTRACT HOLDS: the stamp is set and the frozen mark is rejected.")
    print("Aliasing ceiling: the stamp is (unix_ts/60) mod 2^16, so an age of")
    print("exactly N*65536 minutes (45.51 days) reads as age 0 and passes.")


if __name__ == "__main__":
    main()
