"use client";

import { startPoll } from "@/lib/poll";
import { useEffect, useMemo, useState } from "react";
import { useOrderBook } from "@/hooks/use-orderbook";
import { useWallet } from "@/hooks/use-wallet-compat";
import { explorerAddress } from "@/lib/manifest";
import { PRICE_SCALE, SIDE_BID } from "@/lib/slipstream";

/**
 * Trade history: the wallet's SETTLED fills from the L1 indexer the settlement
 * keeper writes (/api/trades), plus its fills that have executed on the ER but
 * not yet settled.
 *
 * Showing only settled fills made this panel read "No settled fills yet" to a
 * trader who had demonstrably just traded — every fill was sitting unsettled in
 * the ER ring, and the panel had no way to say so. That is the same failure this
 * codebase keeps having to remove: a state the UI cannot express being rendered
 * as an emphatic, wrong, empty one. Settlement being behind is a fact about the
 * pipeline, not evidence that nothing happened.
 *
 * Pending rows come from the shared order book, so they cost no extra request.
 */

interface FillRow {
  sequence: number;
  price: number;
  quantity: number;
  maker: string;
  taker: string;
  maker_side: number;
  taker_fee_bps: number;
  maker_rebate_bps: number;
  settled_at: number;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const GRID = "grid grid-cols-[0.9fr_0.9fr_0.9fr_0.7fr_0.7fr_0.9fr] gap-2 items-center";

export function TradeHistory() {
  const { publicKey } = useWallet();
  const [fills, setFills] = useState<FillRow[]>([]);
  const [indexed, setIndexed] = useState(true);
  const wallet = publicKey?.toBase58() ?? null;

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const url = wallet ? `/api/trades?wallet=${wallet}&limit=60` : "/api/trades?limit=60";
        const res = await fetch(url);
        const json = await res.json();
        if (!stop) {
          setFills(json.fills ?? []);
          setIndexed(json.indexed !== false);
        }
      } catch {
        /* keep last */
      }
    };
    poll();
    const stopPoll = startPoll(poll, 10_000);
    return () => {
      stop = true;
      stopPoll();
    };
  }, [wallet]);

  // Unsettled fills for this wallet, straight off the shared ER book.
  const { fillEvents, status: bookStatus } = useOrderBook(0);
  const pending = useMemo(() => {
    if (!wallet) return [];
    const settledSeq = new Set(fills.map((f) => f.sequence));
    const out: FillRow[] = [];
    for (const fe of fillEvents) {
      if (fe.quantity <= 0n) continue;
      const maker = fe.maker.toBase58();
      const taker = fe.taker.toBase58();
      if (maker !== wallet && taker !== wallet) continue;
      const seq = Number(fe.sequence);
      // A fill that HAS settled is already in `fills` with a real timestamp and
      // fee figures; the ring copy would be a worse duplicate of it.
      if (settledSeq.has(seq)) continue;
      out.push({
        sequence: seq,
        price: Number(fe.price),
        quantity: Number(fe.quantity),
        maker,
        taker,
        maker_side: fe.makerSide,
        taker_fee_bps: 0,
        maker_rebate_bps: 0,
        settled_at: 0, // 0 = not settled; the row renders "pending" instead of a time
      });
    }
    out.sort((a, b) => b.sequence - a.sequence);
    return out.slice(0, 60);
  }, [fillEvents, wallet, fills]);

  const rows = useMemo(() => [...pending, ...fills], [pending, fills]);
  const volume = rows.reduce((s, f) => s + (f.quantity / 1e9) * (f.price / PRICE_SCALE), 0);

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex h-9 items-center justify-between gap-3 px-3 border-b border-[var(--t-border)] shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-2)]">
          Trade History
        </span>
        <div className="flex items-center gap-3 text-[11px] text-[var(--t-text-3)] truncate">
          {rows.length > 0 && (
            <span className="tnum">
              {rows.length} fills · ${volume.toFixed(0)} vol
            </span>
          )}
          {pending.length > 0 && (
            <span className="tnum text-[var(--t-warn)]">{pending.length} settling</span>
          )}
          <span className="truncate">
            {wallet ? "Your fills" : "All settled fills"} · L1 settlement + live rollup
          </span>
        </div>
      </div>

      <div className="p-3 flex-1 min-h-0 flex flex-col">
        <div className={`${GRID} h-[26px] text-[11px] text-[var(--t-text-3)] border-b border-[var(--t-surface-2)] shrink-0`}>
          <span>Time</span>
          <span className="text-right">Price</span>
          <span className="text-right">Size (SOL)</span>
          <span className="text-right">Side</span>
          <span className="text-right">Role</span>
          <span className="text-right">Counterparty</span>
        </div>

        <div className="max-h-[220px] overflow-y-auto slim-scroll">
          {rows.length === 0 ? (
            <div className="text-center text-xs text-[var(--t-text-2)] py-6">
              {bookStatus === "loading"
                ? "Loading your fills…"
                : bookStatus === "unavailable"
                  ? "Can't reach the order book"
                  : !indexed
                    ? "Indexer warming up…"
                    : "No fills yet"}
            </div>
          ) : (
            rows.map((f) => {
              const isMaker = wallet !== null && f.maker === wallet;
              // Taker side is opposite the resting (maker) side; flip again for
              // the viewer's own side when they were the maker.
              const takerBought = f.maker_side === SIDE_BID ? false : true;
              const viewerBought = wallet ? (isMaker ? !takerBought : takerBought) : takerBought;
              const counterparty = isMaker ? f.taker : f.maker;
              return (
                <a
                  key={`${f.settled_at === 0 ? "p" : "s"}-${f.sequence}`}
                  href={explorerAddress(counterparty, "er")}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${GRID} group h-7 text-[11.5px] text-[var(--t-text)] border-b border-[var(--t-surface-2)] last:border-b-0 hover:bg-[var(--t-surface-3)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]`}
                >
                  <span
                    className={`font-mono tnum ${
                      f.settled_at === 0 ? "text-[var(--t-warn)]" : "text-[var(--t-text-2)]"
                    }`}
                    title={
                      f.settled_at === 0
                        ? "Executed on the rollup; waiting on L1 settlement"
                        : undefined
                    }
                  >
                    {f.settled_at === 0 ? "settling" : fmtTime(f.settled_at)}
                  </span>
                  <span className="text-right font-mono tnum">
                    {(f.price / PRICE_SCALE).toFixed(3)}
                  </span>
                  <span className="text-right font-mono tnum">{(f.quantity / 1e9).toFixed(2)}</span>
                  <span
                    className={`text-right font-semibold ${viewerBought ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}
                  >
                    {viewerBought ? "Buy" : "Sell"}
                  </span>
                  <span className="text-right text-[11px] text-[var(--t-text-2)]">
                    {wallet ? (isMaker ? "Maker" : "Taker") : <span className="text-[var(--t-text-3)]">—</span>}
                  </span>
                  <span className="text-right font-mono tnum text-[var(--t-link)] underline decoration-dotted underline-offset-2">
                    {counterparty.slice(0, 4)}…
                  </span>
                </a>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
