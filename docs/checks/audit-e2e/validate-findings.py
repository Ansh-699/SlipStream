#!/usr/bin/env python3
"""Grade one audit-e2e findings document. Frozen check helper - read-only after freeze.

Usage:  python3 docs/checks/audit-e2e/validate-findings.py <SID> <mode>
        SID  = S1 .. S13 (case-insensitive)
        mode = one of MODES below, or `all`

Exit 0 = pass, 1 = fail (with reasons on stdout), 2 = bad invocation.
Run from the repository root. Deliberately mechanical: no judgement calls.
"""
import os
import re
import subprocess
import sys

MODES = [
    "exists", "headings", "calibration", "records", "status", "severity",
    "tag", "class", "evidence", "proof", "impact", "routed", "cleared",
    "minfindings", "nodiff",
]

CALIBRATION = (
    "Flag only gaps that affect correctness, the stated requirements, or "
    "documented project invariants -- cite file:line evidence for every "
    "finding. Do not report stylistic preferences."
)

REQUIRED_HEADINGS = ["## Calibration", "## Findings", "## Cross-slice notes", "## Cleared"]

# Slices whose known state (spec section 6) guarantees at least one finding.
MIN_ONE_FINDING = {"S5", "S6", "S7", "S8", "S10", "S12"}

ROOT = os.getcwd()
CHECKDIR = "docs/checks/audit-e2e"
SEVERITIES = ("P0", "P1", "P2", "P3")
TAGS = ("[reachable-now]", "[mainnet-only]")

# Any level-3 heading inside Findings / Cross-slice notes IS a record. Whether its
# id is well formed is graded by `records`; capturing it loosely here is deliberate,
# so a mistyped header cannot hide a record from every other mode.
RE_RECORD = re.compile(r"^###\s+(\S+)")
RE_RECORD_ID = re.compile(r"^S\d{1,2}-X?\d{2}$")
RE_HEADING2 = re.compile(r"^##\s+\S")
RE_CITE = re.compile(r"([A-Za-z0-9_./\[\]@-]+\.[A-Za-z0-9_]+):(\d+)(?:-(\d+))?")

fails = []


def fail(msg):
    fails.append(msg)


def load_classes():
    path = os.path.join(CHECKDIR, "classes.tsv")
    by_slice = {}
    allids = set()
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            by_slice.setdefault(parts[0], []).append(parts[1])
            allids.add(parts[1])
    return by_slice, allids


def findings_path(sid):
    return "docs/audit/audit-e2e/%s.md" % sid.lower()


def read(sid):
    p = findings_path(sid)
    if not os.path.isfile(p):
        return None
    with open(p, encoding="utf-8", errors="replace") as fh:
        return fh.read().split("\n")


def split_records(lines):
    """Return list of (rec_id, start, end) over the whole document."""
    marks = []
    for i, ln in enumerate(lines):
        m = RE_RECORD.match(ln)
        if m:
            marks.append((m.group(1), i))
    out = []
    for n, (rid, start) in enumerate(marks):
        end = marks[n + 1][1] if n + 1 < len(marks) else len(lines)
        # a level-2 heading also terminates a record
        for j in range(start + 1, end):
            if RE_HEADING2.match(lines[j]):
                end = j
                break
        out.append((rid, start, end))
    return out


def field(body, name):
    pat = re.compile(r"^-\s+\*\*%s:\*\*\s*(.*)$" % re.escape(name))
    hits = [pat.match(ln).group(1).strip() for ln in body if pat.match(ln)]
    return hits


def section(lines, heading):
    try:
        start = next(i for i, ln in enumerate(lines) if ln.strip() == heading)
    except StopIteration:
        return None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if RE_HEADING2.match(lines[j]):
            end = j
            break
    return lines[start + 1:end]


def file_line_count(path):
    try:
        with open(path, "rb") as fh:
            return sum(1 for _ in fh)
    except OSError:
        return None


# ---------------------------------------------------------------- modes

def m_exists(sid, lines, cls):
    p = findings_path(sid)
    if lines is None:
        fail("findings file missing: %s" % p)
        return
    if len([l for l in lines if l.strip()]) < 40:
        fail("%s has fewer than 40 non-blank lines - not a findings document" % p)


def m_headings(sid, lines, cls):
    have = set(l.strip() for l in lines)
    for h in REQUIRED_HEADINGS:
        if h not in have:
            fail("missing required heading: %s" % h)


def m_calibration(sid, lines, cls):
    joined = "\n".join(lines)
    # normalise soft-wrapping inside the quoted block only
    flat = re.sub(r"\n>\s*", " ", joined)
    flat = re.sub(r"[ \t]+", " ", flat)
    if CALIBRATION not in flat:
        fail("calibration sentence not reproduced verbatim (see spec section 2)")


def m_records(sid, lines, cls):
    recs = split_records(lines)
    if not recs:
        return  # zero findings is legal here; minfindings guards the rest
    for rid, _s, _e in recs:
        if not RE_RECORD_ID.match(rid):
            fail("record heading %r is not `### <SID>-NN` or `### <SID>-XNN`" % rid)
            continue
        if not rid.startswith(sid + "-"):
            fail("record id %s does not carry this slice's prefix %s-" % (rid, sid))
    seen = {}
    for rid, _s, _e in recs:
        if rid in seen:
            fail("duplicate record id %s" % rid)
        seen[rid] = 1


def m_status(sid, lines, cls):
    for rid, s, e in split_records(lines):
        v = field(lines[s:e], "Status")
        if len(v) != 1 or v[0] not in ("CONFIRMED", "SUSPECTED"):
            fail("%s: Status must be exactly one of CONFIRMED|SUSPECTED (got %r)" % (rid, v))


def m_severity(sid, lines, cls):
    for rid, s, e in split_records(lines):
        v = field(lines[s:e], "Severity")
        if len(v) != 1 or v[0] not in SEVERITIES:
            fail("%s: Severity must be exactly one of P0|P1|P2|P3 (got %r)" % (rid, v))


def m_tag(sid, lines, cls):
    for rid, s, e in split_records(lines):
        sev = field(lines[s:e], "Severity")
        tag = field(lines[s:e], "Tag")
        sev = sev[0] if len(sev) == 1 else None
        if sev in ("P0", "P1"):
            if len(tag) != 1 or tag[0] not in TAGS:
                fail("%s is %s and must carry exactly one of %s (got %r)"
                     % (rid, sev, " / ".join(TAGS), tag))
        elif sev in ("P2", "P3"):
            if tag:
                fail("%s is %s and must NOT carry a Tag line (got %r)" % (rid, sev, tag))


def m_class(sid, lines, cls):
    by_slice, allids = cls
    for rid, s, e in split_records(lines):
        v = field(lines[s:e], "Class")
        if len(v) != 1:
            fail("%s: exactly one Class line required (got %r)" % (rid, v))
            continue
        cid = v[0].split()[0].strip("`*")
        if "-X" in rid:
            if cid not in allids:
                fail("%s: cross-slice Class %r is not a known class id" % (rid, cid))
        elif cid not in by_slice.get(sid, []):
            fail("%s: Class %r is not one of %s's classes in classes.tsv" % (rid, cid, sid))


def m_evidence(sid, lines, cls):
    for rid, s, e in split_records(lines):
        v = field(lines[s:e], "Evidence")
        if len(v) != 1:
            fail("%s: exactly one Evidence line required (got %d)" % (rid, len(v)))
            continue
        cites = RE_CITE.findall(v[0])
        if not cites:
            fail("%s: Evidence line carries no path:line citation" % rid)
            continue
        for path, a, b in cites:
            n = file_line_count(path)
            if n is None:
                fail("%s: cited path does not resolve to a file: %s" % (rid, path))
                continue
            for num in (a, b):
                if num and int(num) > n:
                    fail("%s: %s:%s is past end of file (%d lines)" % (rid, path, num, n))
                if num and int(num) < 1:
                    fail("%s: %s:%s is not a valid line number" % (rid, path, num))


def m_proof(sid, lines, cls):
    for rid, s, e in split_records(lines):
        body = lines[s:e]
        joined = "\n".join(body)
        if "**Proof.**" not in joined:
            fail("%s: no **Proof.** block" % rid)
            continue
        idx = next(i for i, ln in enumerate(body) if "**Proof.**" in ln)
        tail = [l for l in body[idx:] if l.strip()]
        if len(tail) < 3:
            fail("%s: **Proof.** block has fewer than 3 non-blank lines" % rid)
        st = field(body, "Status")
        if st == ["CONFIRMED"]:
            proof_scope = "\n".join(body[idx:])
            has_fence = "```" in proof_scope
            has_repro = "docs/audit/audit-e2e/repro/" in proof_scope
            if not (has_fence or has_repro):
                fail("%s is CONFIRMED but its Proof has no fenced output block and no "
                     "repro/ reference" % rid)


def m_impact(sid, lines, cls):
    for rid, s, e in split_records(lines):
        joined = "\n".join(lines[s:e])
        for need in ("**What is wrong.**", "**Blast radius.**", "**Suggested remediation.**"):
            if need not in joined:
                fail("%s: missing %s" % (rid, need))


def m_routed(sid, lines, cls):
    body = section(lines, "## Cross-slice notes")
    if body is None:
        fail("no ## Cross-slice notes section")
        return
    for rid, s, e in split_records(lines):
        if "-X" not in rid:
            continue
        v = field(lines[s:e], "Routed to")
        if len(v) != 1 or not re.match(r"^S\d{1,2}$", v[0].strip("`")):
            fail("%s is a cross-slice note and needs exactly one `- **Routed to:** S<n>` "
                 "line (got %r)" % (rid, v))
    # every X record must physically sit inside the Cross-slice notes section
    try:
        xs = next(i for i, ln in enumerate(lines) if ln.strip() == "## Cross-slice notes")
    except StopIteration:
        return
    for rid, s, e in split_records(lines):
        if "-X" in rid and s < xs:
            fail("%s appears before the ## Cross-slice notes heading" % rid)


def m_cleared(sid, lines, cls):
    by_slice, _all = cls
    body = section(lines, "## Cleared")
    if body is None:
        fail("no ## Cleared section")
        return
    if not [l for l in body if l.strip()]:
        fail("## Cleared section is empty - negative results are required")
        return
    for cid in by_slice.get(sid, []):
        hit = [l for l in body if re.search(r"\b%s\b" % re.escape(cid), l)]
        if not hit:
            fail("## Cleared does not account for threat class %s" % cid)
            continue
        # the class line, or the two lines after it, must carry a resolving citation
        i = body.index(hit[0])
        window = " ".join(body[i:i + 3])
        cites = RE_CITE.findall(window)
        if not cites:
            fail("## Cleared entry for %s carries no path:line evidence" % cid)
            continue
        ok = False
        for path, a, _b in cites:
            n = file_line_count(path)
            if n is not None and 1 <= int(a) <= n:
                ok = True
        if not ok:
            fail("## Cleared entry for %s cites no path:line that resolves" % cid)


def m_minfindings(sid, lines, cls):
    if sid not in MIN_ONE_FINDING:
        return
    recs = [r for r in split_records(lines) if "-X" not in r[0]]
    if not recs:
        fail("%s owns established known state (spec section 6) and must file at least "
             "one finding of its own; found zero" % sid)


def m_nodiff(sid, lines, cls):
    try:
        out = subprocess.run(["git", "status", "--porcelain"], capture_output=True,
                             text=True, check=True).stdout
    except Exception as exc:  # noqa: BLE001
        fail("could not run git status: %s" % exc)
        return
    allowed = ("docs/audit/audit-e2e/", "docs/runs/", "docs/jobs/")
    for ln in out.splitlines():
        p = ln[3:].strip().strip('"')
        if "->" in p:
            p = p.split("->")[-1].strip()
        if p == "DESIGN.md":
            continue  # pre-existing untracked working-tree file, spec R3
        if not p.startswith(allowed):
            fail("working tree changed outside the audit output paths: %s" % ln.strip())


DISPATCH = {
    "exists": m_exists, "headings": m_headings, "calibration": m_calibration,
    "records": m_records, "status": m_status, "severity": m_severity, "tag": m_tag,
    "class": m_class, "evidence": m_evidence, "proof": m_proof, "impact": m_impact,
    "routed": m_routed, "cleared": m_cleared, "minfindings": m_minfindings,
    "nodiff": m_nodiff,
}


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    sid = sys.argv[1].upper()
    mode = sys.argv[2]
    if not re.match(r"^S\d{1,2}$", sid):
        print("bad slice id %r" % sid)
        return 2
    if mode != "all" and mode not in DISPATCH:
        print("bad mode %r; expected one of: %s, all" % (mode, ", ".join(MODES)))
        return 2
    cls = load_classes()
    if sid not in cls[0]:
        print("slice %s has no classes in %s/classes.tsv" % (sid, CHECKDIR))
        return 2
    lines = read(sid)
    modes = MODES if mode == "all" else [mode]
    if lines is None:
        # every mode depends on the file; report once and fail
        print("FAIL %s %s: findings file missing: %s" % (sid, mode, findings_path(sid)))
        return 1
    for md in modes:
        DISPATCH[md](sid, lines, cls)
    if fails:
        print("FAIL %s %s" % (sid, mode))
        for f in fails:
            print("  - %s" % f)
        return 1
    print("PASS %s %s" % (sid, mode))
    return 0


if __name__ == "__main__":
    sys.exit(main())
