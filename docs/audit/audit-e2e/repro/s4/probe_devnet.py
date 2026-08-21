#!/usr/bin/env python3
"""S4 read-only devnet probe: FillLog pipeline state.

Reads (never writes) the Market settlement cursor, the OrderBook fill ring
header, and every FillLog epoch PDA on both L1 and the ER.

Usage: python3 docs/audit/audit-e2e/repro/s4/probe_devnet.py
"""
import base58, hashlib, json, struct, sys, time, urllib.request

L1 = "https://api.devnet.solana.com"
ER = "https://devnet.magicblock.app"

PROGRAM = "7qujfsb4ZPbQHYVZdqiXq1r8tVAMyyukX94obPqXbVwz"
MARKET = "ECUp8pXzVLzxjVs8mtKBJma3mdcHf8zSC4cqPeBy8MPy"
ORDERBOOK = "83zMFL6cHjgXkQ7KRNcgtHaZ1fhyNgxhM8aMpPpEnMqe"
MARKET_INDEX = 0

# --- ed25519 on-curve test (for find_program_address) ---
P = 2**255 - 19
D = (-121665 * pow(121666, P - 2, P)) % P


def on_curve(b: bytes) -> bool:
    y = int.from_bytes(b, "little") & ((1 << 255) - 1)
    sign = b[31] >> 7
    if y >= P:
        return False
    u = (y * y - 1) % P
    v = (D * y * y + 1) % P
    x = (u * pow(v, 7, P)) % P
    x = (x * pow(pow(u, 3, P) * pow(v, 7, P), (P - 5) // 8, P)) % P
    if (v * x * x - u) % P == 0:
        pass
    elif (v * x * x + u) % P == 0:
        x = (x * pow(2, (P - 1) // 4, P)) % P
    else:
        return False
    if x == 0 and sign:
        return False
    return True


def find_pda(seeds, program_id_b58):
    pid = base58.b58decode(program_id_b58)
    for bump in range(255, -1, -1):
        h = hashlib.sha256()
        for s in seeds:
            h.update(s)
        h.update(bytes([bump]))
        h.update(pid)
        h.update(b"ProgramDerivedAddress")
        cand = h.digest()
        if not on_curve(cand):
            return base58.b58encode(cand).decode(), bump
    raise RuntimeError("no bump")


def rpc(url, method, params):
    req = urllib.request.Request(
        url,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def get_account(url, addr):
    out = rpc(url, "getAccountInfo", [addr, {"encoding": "base64"}])
    v = out.get("result", {}).get("value")
    if not v:
        return None, None
    import base64

    return base64.b64decode(v["data"][0]), v["owner"]


def main():
    print("probe time (UTC):", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    print("program:", PROGRAM)

    # Market.last_settled_sequence lives in _padding2[0..4] (market.rs:198-205).
    data, owner = get_account(L1, MARKET)
    print("\n[L1 Market]", MARKET, "owner", owner, "len", len(data) if data else None)
    if data:
        cursor = struct.unpack_from("<I", data, 2058)[0]
        print("  last_settled_sequence (u32 @2058) =", cursor)

    # OrderBookHeader: disc@0 .. max_fill_events@12, head@20, tail@22, count@24,
    # next_fill_sequence@40  (order_book.rs:17-37)
    for label, url in (("L1", L1), ("ER", ER)):
        data, owner = get_account(url, ORDERBOOK)
        print(f"\n[{label} OrderBook]", ORDERBOOK, "owner", owner, "len", len(data) if data else None)
        if data and len(data) >= 48:
            (disc,) = struct.unpack_from("<B", data, 0)
            max_fe = struct.unpack_from("<H", data, 12)[0]
            head = struct.unpack_from("<H", data, 20)[0]
            tail = struct.unpack_from("<H", data, 22)[0]
            count = struct.unpack_from("<H", data, 24)[0]
            nseq = struct.unpack_from("<Q", data, 40)[0]
            print(f"  disc={disc} max_fill_events={max_fe} fill_event_head={head} "
                  f"tail={tail} count={count} next_fill_sequence={nseq}")

    # FillLog epochs. Header: disc@0 bump@1 market_index@2 epoch@4 capacity@8
    # count@10 head@12 _pad@14 last_mirrored_sequence@16   (fill_log.rs:19-36)
    print("\n[FillLog epochs]")
    for epoch in range(0, 24):
        addr, bump = find_pda(
            [b"fill_log", struct.pack("<H", MARKET_INDEX), struct.pack("<I", epoch)], PROGRAM
        )
        row = {"epoch": epoch, "pda": addr}
        for label, url in (("L1", L1), ("ER", ER)):
            data, owner = get_account(url, addr)
            if data is None:
                row[label] = "absent"
                continue
            if len(data) < 24:
                row[label] = f"owner={owner} len={len(data)}"
                continue
            disc = data[0]
            cap = struct.unpack_from("<H", data, 8)[0]
            cnt = struct.unpack_from("<H", data, 10)[0]
            hd = struct.unpack_from("<H", data, 12)[0]
            lms = struct.unpack_from("<Q", data, 16)[0]
            row[label] = (f"owner={owner[:8]}.. len={len(data)} disc={disc} cap={cap} "
                          f"count={cnt} head={hd} last_mirrored_seq={lms}")
            if label == "ER" and cnt:
                seqs = []
                for i in range(min(cnt, cap)):
                    idx = (hd + i) % cap
                    off = 24 + idx * 104
                    if off + 104 <= len(data):
                        seqs.append(struct.unpack_from("<Q", data, off)[0])
                row["ER_seqs"] = seqs
        if row.get("L1") == "absent" and row.get("ER") == "absent":
            print(f"  epoch {epoch}: absent on both -> stopping scan")
            break
        print(f"  epoch {epoch} {addr}")
        print(f"      L1: {row['L1']}")
        print(f"      ER: {row['ER']}")
        if "ER_seqs" in row:
            s = row["ER_seqs"]
            print(f"      ER ring sequences: {s[:12]}{' ...' if len(s) > 12 else ''} "
                  f"(min={min(s)} max={max(s)} n={len(s)})")


if __name__ == "__main__":
    main()
