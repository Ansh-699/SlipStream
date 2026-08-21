#!/usr/bin/env bash
# S8 scratch repro (audit-only; never wired into a test suite).
#
# Claim: /api/rpc/[layer] allowlists `getProgramAccounts`
# (frontend/src/app/api/rpc/[layer]/route.ts:80) behind only a 100 KB body cap
# (:71) and a 20-call batch cap (:107). Neither cap bounds the UPSTREAM work a
# request causes, so the route is an unauthenticated amplifier onto the paid RPC
# quota — the exact failure mode the route's own comment (:66-70) names and that
# K1 attributes the 17-day keeper outage to.
#
# This measures the amplification directly against the two upstreams the proxy
# forwards to. It sends READ-ONLY RPC and never touches the deployed origin.
#
# Run: bash docs/audit/audit-e2e/repro/s8/rpc-relay-amplification.sh
set -euo pipefail

PROGRAM=7qujfsb4ZPbQHYVZdqiXq1r8tVAMyyukX94obPqXbVwz   # deploy.json programId
REQ="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getProgramAccounts\",\"params\":[\"$PROGRAM\",{\"encoding\":\"base64\"}]}"
BATCH_CAP=20   # route.ts:107

measure() {
  local name="$1" url="$2"
  local bytes
  bytes=$(curl -s -X POST "$url" -H 'Content-Type: application/json' -d "$REQ" \
            -o /dev/null -w '%{size_download}')
  printf '%-6s request=%s B  response=%s B  amplification=%.0fx  per-capped-request(x%d)=%.1f MB\n' \
    "$name" "${#REQ}" "$bytes" \
    "$(echo "$bytes / ${#REQ}" | bc -l)" "$BATCH_CAP" \
    "$(echo "$bytes * $BATCH_CAP / 1048576" | bc -l)"
}

echo "one allowlisted getProgramAccounts, measured at the upstream:"
measure base https://api.devnet.solana.com
measure er   https://devnet.magicblock.app
echo
echo "the 612 KB OrderBook (83zMFL6cHjgXkQ7KRNcgtHaZ1fhyNgxhM8aMpPpEnMqe) is"
echo "delegated, so it is returned by the ER scan, not the base-layer scan."
