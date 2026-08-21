#!/usr/bin/env python3
"""S4 repro: how many settled fill sequences never reached a FillLog?

Read-only devnet. Enumerates every FillLog epoch PDA that exists on L1, reads
its ER ring (the ER copy is the complete historical record: FillLogView::push
never overwrites and nothing drains `count` -- fill_log.rs:80-99), unions the
sequences, and compares against Market.last_settled_sequence.

Usage: python3 docs/audit/audit-e2e/repro/s4/coverage.py
"""
import base64
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_devnet import ER, L1, MARKET, MARKET_INDEX, PROGRAM, find_pda, rpc  # noqa: E402

MAX_EPOCH_SCAN = 1200
CURSOR_OFFSET = 2058  # Market._padding2[0..4], market.rs:198-205


def main():
    cursor = struct.unpack_from(
        "<I", base64.b64decode(
            rpc(L1, "getAccountInfo", [MARKET, {"encoding": "base64"}])["result"]["value"]["data"][0]
        ), CURSOR_OFFSET)[0]

    addrs = []
    for e in range(MAX_EPOCH_SCAN):
        a, _ = find_pda(
            [b"fill_log", struct.pack("<H", MARKET_INDEX), struct.pack("<I", e)], PROGRAM
        )
        addrs.append((e, a))

    live = []
    for i in range(0, len(addrs), 100):
        chunk = addrs[i:i + 100]
        vals = rpc(L1, "getMultipleAccounts",
                   [[a for _, a in chunk], {"encoding": "base64"}])["result"]["value"]
        for (e, a), v in zip(chunk, vals):
            if v:
                live.append((e, a, v["lamports"]))

    covered, slots_used, full_rings = set(), 0, 0
    for i in range(0, len(live), 100):
        chunk = live[i:i + 100]
        vals = rpc(ER, "getMultipleAccounts",
                   [[a for _, a, _ in chunk], {"encoding": "base64"}])["result"]["value"]
        for (e, a, _), v in zip(chunk, vals):
            if not v:
                continue
            d = base64.b64decode(v["data"][0])
            cap = struct.unpack_from("<H", d, 8)[0]
            cnt = struct.unpack_from("<H", d, 10)[0]
            hd = struct.unpack_from("<H", d, 12)[0]
            slots_used += cnt
            if cnt == cap:
                full_rings += 1
            for k in range(cnt):
                covered.add(struct.unpack_from("<Q", d, 24 + ((hd + k) % cap) * 104)[0])

    missing = sum(1 for s in range(1, cursor + 1) if s not in covered)
    print("FillLog epoch accounts on L1 :", len(live))
    print("  of which ER ring is FULL   :", full_rings)
    print("  rent locked in them        :", sum(l for _, _, l in live) / 1e9, "SOL")
    print("Market.last_settled_sequence :", cursor)
    print("distinct sequences ever mirrored :", len(covered))
    print("ring slots consumed              :", slots_used,
          "(waste =", slots_used - len(covered), "duplicate re-mirrors)")
    print("sequences 1..cursor NEVER mirrored into any FillLog :", missing)

    assert missing == 0, (
        "EXACTLY-ONCE VIOLATED: %d fill sequences below the settlement cursor were "
        "never mirrored into any FillLog, so they were settled ZERO times while the "
        "cursor advanced past them (settle_from_log.rs:260-271)." % missing
    )


if __name__ == "__main__":
    main()
