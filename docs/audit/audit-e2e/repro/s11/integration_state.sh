#!/bin/sh
# S11-C5 — does the unrun integration suite still compile, and what does it need?
# Read-only: installs node_modules (gitignored) and type-checks. No signer, no tx.
# Run from the repository root:  sh docs/audit/audit-e2e/repro/s11/integration_state.sh
set -e
echo "== 1. tsc with ONLY tests/integration deps installed (what the suite's own"
echo "==    package.json + README tell you to do) =="
rm -rf client/node_modules
( cd tests/integration && npm ci --no-audit --no-fund >/dev/null 2>&1 )
( cd tests/integration && npx tsc --noEmit ) && echo "  tsc exit=0" || echo "  tsc FAILED (exit $?)"

echo
echo "== 2. tsc after ALSO installing client/ deps (the undeclared cross-package"
echo "==    import at option_b_flow.test.ts:59 and crank_twap_harness.ts:41) =="
( cd client && npm ci --no-audit --no-fund >/dev/null 2>&1 )
( cd tests/integration && npx tsc --noEmit ) && echo "  tsc exit=0" || echo "  tsc FAILED (exit $?)"

echo
echo "== 3. the only suite that needs no devnet, no ER and no signer =="
( cd tests/integration && npx tsx manifest_wellformedness.test.ts | tail -4 )
echo "  ^ runs offline in seconds; not in test:all (package.json:12) and in no CI job"
