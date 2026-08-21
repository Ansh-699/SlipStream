#!/usr/bin/env bash
# Read-only on-chain evidence for audit-e2e slice S2. No signer, no mutation.
#   ER  order book : 83zMFL6cHjgXkQ7KRNcgtHaZ1fhyNgxhM8aMpPpEnMqe
#   L1  market     : ECUp8pXzVLzxjVs8mtKBJma3mdcHf8zSC4cqPeBy8MPy
# Output captured in onchain-read.txt.
set -euo pipefail
ER=https://devnet.magicblock.app
L1=https://api.devnet.solana.com
OB=83zMFL6cHjgXkQ7KRNcgtHaZ1fhyNgxhM8aMpPpEnMqe
MK=ECUp8pXzVLzxjVs8mtKBJma3mdcHf8zSC4cqPeBy8MPy

get() { # rpc addr [offset len]
  local params="\"$2\",{\"encoding\":\"base64\""
  [ $# -gt 2 ] && params="$params,\"dataSlice\":{\"offset\":$3,\"length\":$4}"
  curl -s -X POST "$1" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[$params}]}"
}

echo "read at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
get "$ER" "$OB" 0 48        > /tmp/s2_ob_header.json
get "$ER" "$OB" 180272 16384 > /tmp/s2_ob_levels.json
get "$ER" "$OB" 622640 4096  > /tmp/s2_ob_free.json
get "$ER" "$OB" 48 180224    > /tmp/s2_ob_slots.json
get "$L1" "$MK"              > /tmp/s2_market.json

python3 - <<'PY'
import base64, json, struct, datetime

def load(p):
    j = json.load(open(p))
    return base64.b64decode(j['result']['value']['data'][0]), j['result']['context']['slot']

h, er_slot = load('/tmp/s2_ob_header.json')
names = ["max_order_slots","max_price_levels_per_side","max_fill_events","active_order_count",
         "bid_level_count","ask_level_count","fill_event_head","fill_event_tail",
         "fill_event_count","free_list_head","free_slot_count"]
vals = dict(zip(names, struct.unpack_from("<11H", h, 8)))
next_order_id, next_fill_seq = struct.unpack_from("<QQ", h, 32)
print(f"-- OrderBookHeader (ER slot {er_slot}) orders_per_user={h[4]}")
for n in names:
    print(f"   {n:28s} {vals[n]}")
print(f"   {'next_order_id':28s} {next_order_id}")
print(f"   {'next_fill_sequence':28s} {next_fill_seq}")

m, l1_slot = load('/tmp/s2_market.json')
off = 224 + 225 * 8
settled = struct.unpack("<I", m[off+34:off+38])[0]
print(f"-- Market (L1 slot {l1_slot})")
print(f"   {'last_mark_price':28s} {struct.unpack_from('<Q', m, 200)[0]}")
print(f"   {'last_funding_ts':28s} {struct.unpack_from('<q', m, 168)[0]} "
      f"({datetime.datetime.fromtimestamp(struct.unpack_from('<q', m, 168)[0], datetime.UTC)})")
print(f"   {'last_settled_sequence':28s} {settled}")
print(f"-- ring holds sequences {next_fill_seq - vals['fill_event_count']} .. {next_fill_seq - 1}; "
      f"{next_fill_seq - 1 - settled} fill(s) produced but not settled")
print(f"-- {settled - (next_fill_seq - vals['fill_event_count'])} already-settled entries "
      f"stand between the write head and the oldest unsettled fill")

# free-list integrity: walk it and compare with the header + active slots
fl, _ = load('/tmp/s2_ob_free.json')
free = list(struct.unpack("<2048H", fl))
seen, cur = set(), vals['free_list_head']
while cur != 0xFFFF:
    assert cur < 2048 and cur not in seen, f"free list broken at {cur}"
    seen.add(cur); cur = free[cur]
sl, _ = load('/tmp/s2_ob_slots.json')
now = int(datetime.datetime.now(datetime.UTC).timestamp())
active, expired = [], []
for i in range(2048):
    o = sl[i*88:(i+1)*88]
    if o[0]:
        active.append(i)
        exp = struct.unpack_from("<q", o, 72)[0]
        if 0 < exp <= now:
            expired.append((i, exp))
print(f"-- free-list walk length {len(seen)} vs header free_slot_count {vals['free_slot_count']}: "
      f"{'MATCH' if len(seen)==vals['free_slot_count'] else 'MISMATCH'}; no cycle, no out-of-range index")
print(f"-- active slots {len(active)} vs header active_order_count {vals['active_order_count']}: "
      f"{'MATCH' if len(active)==vals['active_order_count'] else 'MISMATCH'}; "
      f"active+free = {len(active)+len(seen)} of 2048")
print(f"-- resting orders already past their own expiry_ts: {len(expired)} {expired}")

lv, _ = load('/tmp/s2_ob_levels.json')
def side(base, count, desc, tag):
    rows = [struct.unpack_from("<QHHH", lv, base + i*16) for i in range(count)]
    ok = all((rows[i][0] > rows[i+1][0]) if desc else (rows[i][0] < rows[i+1][0])
             for i in range(count-1))
    print(f"-- {tag} levels ({count}) sorted {'descending' if desc else 'ascending'}: "
          f"{'OK' if ok else 'VIOLATED'} -> {[r[0] for r in rows]}")
    for i, (p, hd, tl, c) in enumerate(rows):
        s = sl[hd*88:(hd+1)*88]
        assert s[0] and struct.unpack_from("<Q", s, 48)[0] == p, f"{tag} level {i} head mismatch"
    print(f"   every {tag} level head_slot points at an ACTIVE slot at the level's own price")
side(0, vals['bid_level_count'], True, "bid")
side(8192, vals['ask_level_count'], False, "ask")
PY
