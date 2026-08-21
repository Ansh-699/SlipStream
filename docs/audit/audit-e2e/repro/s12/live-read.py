#!/usr/bin/env python3
"""S12 scratch repro — read-only devnet reads that back the liveness findings.

Run:  python3 docs/audit/audit-e2e/repro/s12/live-read.py
Reads three accounts over public devnet RPC. No signer, no mutation.

  1. Market ECUp8p...  -> last_mark_price, last_funding_ts, tick/lot/leverage
  2. Pyth   7UVimf...  -> the feed the market is configured with, fresh
  3. OrderBook 83zMFL. -> on-chain owner (= the real delegation program) + space

Asserts the doc claims S12-02 / S12-08 / cleared-C6 rest on.
"""
import base64
import datetime
import json
import struct
import urllib.request

RPC = "https://api.devnet.solana.com"
MARKET = "ECUp8pXzVLzxjVs8mtKBJma3mdcHf8zSC4cqPeBy8MPy"
PYTH = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
ORDERBOOK = "83zMFL6cHjgXkQ7KRNcgtHaZ1fhyNgxhM8aMpPpEnMqe"
DELEGATION_PROGRAM = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"


def get(pubkey, slice_=None):
    cfg = {"encoding": "base64"}
    if slice_ is not None:
        cfg["dataSlice"] = slice_
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getAccountInfo",
                       "params": [pubkey, cfg]}).encode()
    req = urllib.request.Request(RPC, data=body,
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30))["result"]["value"]


def iso(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.UTC).isoformat()


now = datetime.datetime.now(datetime.UTC)
print("read at:", now.isoformat())

# --- 1. Market -------------------------------------------------------------
# Market layout, programs/slipstream/src/state/market.rs:20-55
#   u8 disc, u8 bump, u16 market_index, u8 max_leverage, u8 circuit_breaker,
#   u16 taker_fee_bps, u16 maker_rebate_bps, u16 twap_write_index,
#   u16 twap_count, [u8;2] pad, then 4 x [u8;32] pubkeys, then the u64/i64 block.
m = base64.b64decode(get(MARKET)["data"][0])
off = 16 + 32 * 4
tick, lot, fint, lft, oil, ois, ins, lmp = struct.unpack_from("<QQQqQQQQ", m, off)
mark_age_days = (now.timestamp() - lft) / 86400
print("\n[market]")
print("  max_leverage        =", m[4])
print("  taker_fee_bps       =", struct.unpack_from("<H", m, 6)[0])
print("  maker_rebate_bps    =", struct.unpack_from("<H", m, 8)[0])
print("  tick_size           =", tick)
print("  lot_size            =", lot)
print("  funding_interval_s  =", fint)
print("  last_funding_ts     =", lft, iso(lft))
print("  last_mark_price     = %d  ($%.3f)" % (lmp, lmp / 1e6))
print("  open_interest L/S   = %d / %d" % (oil, ois))
print("  age of last funding = %.1f days" % mark_age_days)

# --- 2. Pyth feed the market is configured with ----------------------------
# PriceUpdateV2: price i64 @73, exponent i32 @89, publish_time i64 @93
p = base64.b64decode(get(PYTH)["data"][0])
praw = struct.unpack_from("<q", p, 73)[0]
pexp = struct.unpack_from("<i", p, 89)[0]
ppt = struct.unpack_from("<q", p, 93)[0]
pyth_price = praw * (10 ** pexp)
print("\n[pyth 7UVimf...]")
print("  price               = $%.2f" % pyth_price)
print("  publish_time        =", ppt, iso(ppt))
print("  feed age            = %.0f s" % (now.timestamp() - ppt))
print("  mark vs pyth        = %.1f%% low" % (100 * (pyth_price - lmp / 1e6) / pyth_price))

# --- 3. OrderBook ----------------------------------------------------------
ob = get(ORDERBOOK, {"offset": 0, "length": 0})
print("\n[orderbook 83zMFL...]")
print("  owner               =", ob["owner"])
print("  space               =", ob["space"])

# --- assertions the findings rest on --------------------------------------
assert mark_age_days > 10, "K1 no longer holds: funding cranked recently"
assert now.timestamp() - ppt < 600, "pyth feed is not fresh; rerun"
assert ob["owner"] == DELEGATION_PROGRAM, "orderbook not delegated to DELeGG...RSaeSh"
assert ob["space"] == 626736, "orderbook size != docs/02 arithmetic"
assert tick == 1000 and lot == 100_000_000 and m[4] == 20 and fint == 28800
print("\nALL ASSERTIONS HELD")
