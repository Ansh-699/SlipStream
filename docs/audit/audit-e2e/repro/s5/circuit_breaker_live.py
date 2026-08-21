#!/usr/bin/env python3
"""S5-03 reproduction: the next permissionless crank_twap halts the live market.

Read-only. Fetches the live devnet Market and the market's own Pyth feed over
public RPC, decodes both with the offsets the program uses, and replays
crank_twap.rs:57-69 in Python. Asserts that the circuit breaker trips, and
counts how many further cranks are needed to clear it again.

    python3 docs/audit/audit-e2e/repro/s5/circuit_breaker_live.py

No signer, no transaction, no mutation.
"""
import base64
import json
import struct
import urllib.request

RPC = "https://api.devnet.solana.com"
MARKET = "ECUp8pXzVLzxjVs8mtKBJma3mdcHf8zSC4cqPeBy8MPy"
PYTH = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"

# programs/slipstream/src/state/market.rs:20-55  (#[repr(C)])
OFF_TWAP_WRITE_INDEX = 10
OFF_TWAP_COUNT = 12
OFF_MARK_MINUTE = 14  # _padding1, see market.rs:63-71
OFF_LAST_MARK_PRICE = 200
OFF_TWAP_PRICES = 224
TWAP_BUFFER_SIZE = 225  # market.rs:6
MARK_PRICE_MAX_STALENESS_MINS = 30  # market.rs:16


def get_account(pubkey):
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "getAccountInfo",
        "params": [pubkey, {"encoding": "base64"}],
    }).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        v = json.load(r)["result"]["value"]
    return v, base64.b64decode(v["data"][0])


def parse_pyth_price_update_v2(d):
    """programs/slipstream/src/oracle.rs:126-143, the len>=134 branch."""
    assert len(d) >= 134 and len(d) < 248, len(d)
    assert d[40] == 1, "verification_level must be Full (oracle.rs:130)"
    price = struct.unpack_from("<q", d, 73)[0]
    conf = struct.unpack_from("<Q", d, 81)[0]
    expo = struct.unpack_from("<i", d, 89)[0]
    publish_time = struct.unpack_from("<q", d, 93)[0]
    assert price > 0
    # check_confidence, oracle.rs:152-161
    conf_bps = (conf * 10_000) // price
    assert conf_bps <= 100, f"conf {conf_bps} bps > MAX_CONFIDENCE_BPS"
    # normalise_to_6_decimals, oracle.rs:197-209
    exp_diff = expo - (-6)
    p6 = price * 10 ** exp_diff if exp_diff > 0 else price // 10 ** (-exp_diff)
    return p6, publish_time


def main():
    mv, m = get_account(MARKET)
    pv, p = get_account(PYTH)
    print(f"market  {MARKET}  owner={mv['owner']}  len={len(m)}")
    print(f"pyth    {PYTH}  owner={pv['owner']}  len={len(p)}")

    price, publish_time = parse_pyth_price_update_v2(p)
    print(f"parse_pyth -> price={price} (${price/1e6:.6f})  publish_time={publish_time}")

    count = struct.unpack_from("<H", m, OFF_TWAP_COUNT)[0]
    widx = struct.unpack_from("<H", m, OFF_TWAP_WRITE_INDEX)[0]
    stamp = struct.unpack_from("<H", m, OFF_MARK_MINUTE)[0]
    last_mark = struct.unpack_from("<Q", m, OFF_LAST_MARK_PRICE)[0]
    ring = [struct.unpack_from("<Q", m, OFF_TWAP_PRICES + 8 * i)[0]
            for i in range(TWAP_BUFFER_SIZE)]

    # Market::get_twap, market.rs:123-134
    twap = sum(ring[:count]) // count
    print(f"twap_count={count} twap_write_index={widx} "
          f"mark_price_minute={stamp} last_mark_price={last_mark}")
    print(f"get_twap() = {twap} (${twap/1e6:.6f})   "
          f"ring min={min(ring[:count])} max={max(ring[:count])}")

    # crank_twap.rs:57-69
    diff = abs(price - twap)
    threshold = twap // 10
    print(f"crank_twap.rs:62 -> diff={diff} > current_twap/10={threshold} ? "
          f"{diff > threshold}")
    assert diff > threshold, "breaker would NOT trip -- finding does not reproduce"
    print("=> circuit_breaker_active = 1  "
          "(blocks place_order / close_position / liquidate_position)")

    # How many more permissionless cranks clear it (crank_twap.rs:64-67)?
    r, i, n = list(ring), widx, 0
    while True:
        r[i] = price
        i = (i + 1) % TWAP_BUFFER_SIZE
        n += 1
        t = sum(r) // TWAP_BUFFER_SIZE
        if abs(price - t) <= t // 10:
            break
        assert n <= TWAP_BUFFER_SIZE, "never clears"
    print(f"cranks needed to clear the breaker again = {n} "
          f"(~{n*8/60:.1f} min at the keeper's 8s interval, twap-keeper.ts:8)")
    print("REPRODUCED")


if __name__ == "__main__":
    main()
