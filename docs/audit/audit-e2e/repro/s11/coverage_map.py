#!/usr/bin/env python3
"""S11 money-path coverage map — mechanical, no judgement.

For every instruction discriminator declared in
programs/slipstream/src/instructions/mod.rs, report how many Mollusk tests under
tests/unit/src/ actually drive that discriminator through the real compiled
program, and how many process_instruction calls the whole suite makes.

Run from the repository root:  python3 docs/audit/audit-e2e/repro/s11/coverage_map.py
"""
import re, glob, os, collections

ROOT = os.getcwd()
MOD = os.path.join(ROOT, "programs/slipstream/src/instructions/mod.rs")

# 1. declared instructions: pub const IX_X: u8 = 0xNN;
decl = {}
for m in re.finditer(r"pub const (IX_\w+): u8 = 0x([0-9A-Fa-f]{2});", open(MOD).read()):
    decl[int(m.group(2), 16)] = m.group(1)

# 2. discriminators actually placed in an Instruction `data` payload by a test
used = collections.defaultdict(list)
proc_calls = 0
tests_total = 0
for path in sorted(glob.glob(os.path.join(ROOT, "tests/unit/src/test_*.rs"))):
    src = open(path).read()
    rel = os.path.relpath(path, ROOT)
    tests_total += len(re.findall(r"#\[test\]", src))
    proc_calls += len(re.findall(r"\.process_instruction\(", src))
    if "test_instructions_simple" in rel:
        continue  # asserts constants, never invokes the program
    for m in re.finditer(r"data(?:\s*[:=]\s*)vec!\[\s*0x([0-9A-Fa-f]{2})", src):
        used[int(m.group(1), 16)].append(rel)

covered = sorted(k for k in decl if k in used)
missing = sorted(k for k in decl if k not in used)

print("declared instructions      : %d" % len(decl))
print("driven through Mollusk     : %d" % len(covered))
print("ZERO Mollusk coverage      : %d" % len(missing))
print("#[test] fns in tests/unit  : %d" % tests_total)
print("process_instruction calls  : %d" % proc_calls)
print()
print("--- ZERO in-SVM coverage ---")
for k in missing:
    print("  0x%02X  %s" % (k, decl[k]))
print()
print("--- covered ---")
for k in covered:
    print("  0x%02X  %-32s %s" % (k, decl[k], ", ".join(sorted(set(used[k])))))
