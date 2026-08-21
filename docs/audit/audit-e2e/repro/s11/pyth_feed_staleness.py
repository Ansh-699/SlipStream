#!/usr/bin/env python3
"""S11-C5 — is the Pyth account the integration suite hardcodes still usable?

tests/integration/setup.ts:30-32 exports PYTH_SOL_USD = J83w4... and
tests/integration/option_b_flow.test.ts:109 initialises a market with it.
deploy.json:11 (and the deployed market) use 7UVimf... instead. Read both
accounts over public read-only devnet RPC and decode publish_time at the offsets
programs/slipstream/src/oracle.rs uses for each layout.

Read-only. No signer, no transaction.
Run:  python3 docs/audit/audit-e2e/repro/s11/pyth_feed_staleness.py
"""
import base64, json, struct, time, urllib.request

RPC = "https://api.devnet.solana.com"
LEGACY = "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"   # tests/integration/setup.ts:31
RECEIVER = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"  # deploy.json:11
MAX_STALENESS_SECS = 60  # programs/slipstream/src/oracle.rs:22


def account(addr):
    req = urllib.request.Request(
        RPC,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getAccountInfo",
                         "params": [addr, {"encoding": "base64"}]}).encode(),
        headers={"Content-Type": "application/json"})
    v = json.load(urllib.request.urlopen(req))["result"]["value"]
    return v["owner"], base64.b64decode(v["data"][0])


now = int(time.time())
print("read at unix %d (%s UTC)\n" % (now, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))))

for label, addr in (("setup.ts PYTH_SOL_USD", LEGACY), ("deploy.json pythFeed", RECEIVER)):
    owner, d = account(addr)
    print("%s\n  %s\n  owner=%s len=%d" % (label, addr, owner, len(d)))
    if len(d) >= 248:                       # oracle.rs:112 legacy PriceAccountV2
        expo = struct.unpack_from("<i", d, 20)[0]
        pub = struct.unpack_from("<q", d, 96)[0]
        px = struct.unpack_from("<q", d, 208)[0]
        status = struct.unpack_from("<I", d, 224)[0]
        print("  layout=legacy PriceAccountV2  status=%d" % status)
    else:                                    # oracle.rs:126 PriceUpdateV2
        expo = struct.unpack_from("<i", d, 89)[0]
        pub = struct.unpack_from("<q", d, 93)[0]
        px = struct.unpack_from("<q", d, 73)[0]
        print("  layout=PriceUpdateV2  verification_level=%d" % d[40])
    age = now - pub
    print("  price=%.6f  publish_time=%d  age=%d s (%.1f days)" % (px * (10.0 ** expo), pub, age, age / 86400.0))
    print("  passes oracle.rs is_fresh(<=%ds)? %s\n" % (MAX_STALENESS_SECS, "YES" if 0 <= age <= MAX_STALENESS_SECS else "NO"))
