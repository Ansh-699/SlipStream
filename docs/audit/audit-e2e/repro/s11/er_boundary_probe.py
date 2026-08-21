#!/usr/bin/env python3
"""S11-C8 — is S5's central product claim asserted by any test?

PRODUCT.md's positioning rests on: the only accounts this program ever delegates
are {OrderBook, TradingCredit, FillLog}, and the ER is pinned to the MagicBlock
delegation / magic program ids. This checks (a) whether any Rust test touches the
delegation lifecycle at all, and (b) whether the replicated hardcoded program-id
constants that enforce the pinning are asserted equal anywhere.

Run from the repository root:  python3 docs/audit/audit-e2e/repro/s11/er_boundary_probe.py
"""
import re, glob, os, collections

ROOT = os.getcwd()
IX = os.path.join(ROOT, "programs/slipstream/src/instructions")

DELEG_IXS = ["DELEGATE_ORDERBOOK", "UNDELEGATE_ORDERBOOK", "DELEGATE_TRADING_CREDIT",
             "UNDELEGATE_TRADING_CREDIT", "EMERGENCY_UNDELEGATE",
             "DELEGATE_ORDERBOOK_PREPARE", "COMMIT_ORDERBOOK", "DELEGATE_FILL_LOG",
             "COMMIT_FILL_LOG"]

mod = open(os.path.join(IX, "mod.rs")).read()
disc = {m.group(1): int(m.group(2), 16)
        for m in re.finditer(r"pub const IX_(\w+): u8 = 0x([0-9A-Fa-f]{2});", mod)}

tests = "".join(open(p).read() for p in glob.glob(os.path.join(ROOT, "tests/unit/src/*.rs")))
used = {int(d, 16) for d in re.findall(r"data(?:\s*[:=]\s*)vec!\[\s*0x([0-9A-Fa-f]{2})", tests)}

print("--- (a) delegation-lifecycle instructions driven by a Rust test ---")
for name in DELEG_IXS:
    d = disc[name]
    print("  0x%02X  IX_%-28s %s" % (d, name, "COVERED" if d in used else "no test"))
print("  delegation-program id referenced in tests/unit/src/ : %d times"
      % len(re.findall(r"DELEGATION_PROGRAM|DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh", tests)))

print()
print("--- (b) replicated hardcoded program-id constants ---")
copies = collections.defaultdict(dict)
for path in sorted(glob.glob(os.path.join(IX, "*.rs"))):
    src = open(path).read()
    for name in ("DELEGATION_PROGRAM_ID", "MAGIC_PROGRAM_ID", "MAGIC_CONTEXT_ID"):
        m = re.search(r"const %s: Pubkey = \[(.*?)\];" % name, src, re.S)
        if m:
            body = re.sub(r"\s|//.*", "", m.group(1))
            copies[name][os.path.relpath(path, ROOT)] = body
total = 0
for name, byfile in copies.items():
    vals = set(byfile.values())
    total += len(byfile)
    print("  %-22s %d hardcoded copies, %d distinct value(s) -> %s"
          % (name, len(byfile), len(vals), "AGREE today" if len(vals) == 1 else "DISAGREE"))
    for f in sorted(byfile):
        print("      %s" % f)
print("  total hardcoded copies: %d" % total)
asserts = len(re.findall(r"DELEGATION_PROGRAM_ID|MAGIC_PROGRAM_ID|MAGIC_CONTEXT_ID", tests))
print("  test assertions over any of these constants: %d" % asserts)
