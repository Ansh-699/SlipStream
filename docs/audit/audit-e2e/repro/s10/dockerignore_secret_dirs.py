# Scratch reproduction for audit-e2e / S10.  NOT part of any test suite.
#
# Question: does the repo's .dockerignore actually exclude every on-disk secret
# directory the keeper code creates, before `COPY keepers ./keepers`
# (keepers/Dockerfile:29) bakes the build host's tree into the image?
#
# Implements Docker's documented .dockerignore matching (moby/patternmatcher):
#   - patterns are '/'-separated and relative to the build context root
#   - '*' matches within one path segment, '**' spans segments, '?' one char
#   - a match on any ancestor directory excludes the whole subtree
#   - a leading '!' re-includes; the LAST matching pattern wins
#
# Run:  python3 docs/audit/audit-e2e/repro/s10/dockerignore_secret_dirs.py
# Exit: 0 if every asserted path behaves as .dockerignore's own comment claims,
#       1 (with a report) otherwise.

import posixpath
import re
import sys

DOCKERIGNORE = ".dockerignore"


def load_patterns(path):
    pats = []
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            neg = line.startswith("!")
            if neg:
                line = line[1:].strip()
            pats.append((neg, posixpath.normpath(line)))
    return pats


def to_regex(pattern):
    out, i, n = "", 0, len(pattern)
    while i < n:
        c = pattern[i]
        if c == "*":
            if pattern[i:i + 2] == "**":
                i += 2
                if pattern[i:i + 1] == "/":
                    i += 1
                    out += "(?:.*/)?"      # '**/' -> zero or more segments
                else:
                    out += ".*"
                continue
            out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        else:
            out += re.escape(c)
        i += 1
    return re.compile("^" + out + "$")


def excluded(path, pats):
    """Docker semantics: last matching pattern wins; ancestors count."""
    parts = path.split("/")
    candidates = ["/".join(parts[:k]) for k in range(1, len(parts) + 1)]
    verdict, why = False, None
    for neg, pat in pats:
        rx = to_regex(pat)
        if any(rx.match(c) for c in candidates):
            verdict, why = (not neg), pat
    return verdict, why


# (path, must_be_excluded, what .dockerignore claims about it)
CASES = [
    ("secrets/keeper-id.json", True,
     ".dockerignore:11 'secrets' - the signing keypair docker-compose.yml:29 mounts"),
    ("keepers/.env", True, ".dockerignore:12 '**/.env'"),
    ("keepers/.env.example", False, ".dockerignore:14 '!**/.env.example' re-includes it"),
    ("keepers/.bot-keys/mm-v2-0.json", True,
     ".dockerignore:22 - bot wallet secret keys (keepers/src/shared/bot-wallets.ts:67)"),
    ("keepers/data/fills.db", True, ".dockerignore:23 - local fills indexer DB"),
    # Same shape as .bot-keys, same writer style, same gitignore treatment
    # (keepers/.gitignore:7 '.verify-keys/' - "Never commit"), written by
    # keepers/src/verify-session.ts:83 and keepers/src/verify-close.ts:33 as raw
    # 64-byte secretKey JSON arrays, funded with SOL by the operator key.
    ("keepers/.verify-keys/verify-user.json", True,
     ".dockerignore:1 'never ship secrets' - but NO pattern in the file matches it"),
]


def main():
    pats = load_patterns(DOCKERIGNORE)
    failures = []
    print("path                                        excluded?  matched pattern")
    print("-" * 78)
    for path, want, claim in CASES:
        got, why = excluded(path, pats)
        print("%-43s %-10s %s" % (path, got, why if why else "<none>"))
        if got != want:
            failures.append((path, want, got, claim))
    print()
    for path, want, got, claim in failures:
        print("FAIL %s: expected excluded=%s, got %s" % (path, want, got))
        print("     claim: %s" % claim)
    if failures:
        print("\n%d of %d secret paths are NOT excluded from the build context."
              % (len(failures), len(CASES)))
        return 1
    print("all %d paths behave as .dockerignore claims" % len(CASES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
