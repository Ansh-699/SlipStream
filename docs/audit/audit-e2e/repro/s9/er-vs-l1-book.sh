#!/usr/bin/env bash
# S9 repro — the base-layer fallback the orderbook hooks use is a snapshot of an
# account the docs say is NEVER committed. Read-only RPC; no signer, no writes.
# Scratch audit code; never wired into a suite.
#
#   bash docs/audit/audit-e2e/repro/s9/er-vs-l1-book.sh
#
# Prints the 48-byte OrderBookHeader from both layers so the two can be compared.
# Layout: frontend/src/lib/slipstream/accounts.ts:374-398
set -euo pipefail
OB=83zMFL6cHjgXkQ7KRNcgtHaZ1fhyNgxhM8aMpPpEnMqe   # deploy-manifest.generated.json orderBook

echo "OrderBook $OB — header read at $(date -u +%FT%TZ)"
for pair in "L1|https://api.devnet.solana.com" "ER|https://devnet.magicblock.app"; do
  L=${pair%%|*}; U=${pair#*|}
  curl -s -m 30 -X POST "$U" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$OB\",{\"encoding\":\"base64\",\"dataSlice\":{\"offset\":0,\"length\":48}}]}" \
  | LAYER="$L" python3 -c "
import sys, json, base64, struct, os
r = json.load(sys.stdin); v = r.get('result', {}).get('value')
lab = os.environ['LAYER']
if not v:
    print(lab, '-> no account'); raise SystemExit
d = base64.b64decode(v['data'][0])
u16 = lambda o: struct.unpack_from('<H', d, o)[0]
u64 = lambda o: struct.unpack_from('<Q', d, o)[0]
print(f'{lab}: owner={v[\"owner\"]}')
print(f'    disc={d[0]} activeOrderCount={u16(14)} bidLevelCount={u16(16)} '
      f'askLevelCount={u16(18)} fillEventCount={u16(24)} '
      f'nextOrderId={u64(32)} nextFillSequence={u64(40)}')
"
done
cat <<'EOT'

The L1 copy decodes cleanly (disc=5), so use-orderbook.ts:84-87 accepts it as the
book whenever the ER read fails, and use-orderbook.ts:115 then labels it "live"
with a fresh updatedAt. docs/03-ephemeral-rollups-and-delegation.md:172 says the
OrderBook is delegated once and never committed, so that copy can never advance.
EOT
