#!/usr/bin/env python3
"""S11 — does ANY Rust test submit the same instruction twice?

Exactly-once settlement (S4-C1) and replay resistance (S4-C4) can only be tested
by issuing an instruction, then issuing it again against the resulting state.
This walks every #[test] fn in tests/unit/src/ and prints the discriminators it
submits, flagging any fn that submits the same one more than once.

Run from the repository root:  python3 docs/audit/audit-e2e/repro/s11/replay_probe.py
"""
import re, glob, os

ROOT = os.getcwd()
tot_tests = tot_calls = multi = repeat = 0
for path in sorted(glob.glob(os.path.join(ROOT, "tests/unit/src/test_*.rs"))):
    src = open(path).read()
    rel = os.path.relpath(path, ROOT)
    # split on #[test] so each chunk is one test fn body
    chunks = src.split("#[test]")[1:]
    for c in chunks:
        tot_tests += 1
        name = re.search(r"fn (\w+)", c)
        name = name.group(1) if name else "?"
        calls = len(re.findall(r"\.process_instruction\(", c))
        tot_calls += calls
        discs = re.findall(r"data(?:\s*[:=]\s*)vec!\[\s*0x([0-9A-Fa-f]{2})", c)
        if calls > 1:
            multi += 1
            dup = len(discs) != len(set(discs))
            if dup:
                repeat += 1
            print("  %-70s calls=%d discs=%s%s"
                  % (rel + "::" + name, calls, [d.upper() for d in discs],
                     "  <-- REPEATED" if dup else ""))

print()
print("#[test] fns                              : %d" % tot_tests)
print("total process_instruction calls          : %d" % tot_calls)
print("tests issuing MORE THAN ONE instruction  : %d" % multi)
print("tests issuing the SAME instruction twice : %d" % repeat)
