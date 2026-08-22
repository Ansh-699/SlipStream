"use client";

import { startPoll } from "@/lib/poll";
import { useEffect, useState } from "react";
import { useWallet } from "@/hooks/use-wallet-compat";
import { explorerAddress } from "@/lib/manifest";
import { PRICE_SCALE, SIDE_BID } from "@/lib/slipstream";

/**
 * Settled trade history, served from the fills indexer the settlement keeper
 * writes (/api/trades). Connected wallet -> personal history with Maker/Taker
 * role + fees; otherwise the market-wide settled tape.
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

  const volume = fills.reduce((s, f) => s + (f.quantity / 1e9) * (f.price / PRICE_SCALE), 0);

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex h-9 items-center justify-between gap-3 px-3 border-b border-[var(--t-border)] shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-2)]">
          Trade History
        </span>
        <div className="flex items-center gap-3 text-[11px] text-[var(--t-text-3)] truncate">
          {fills.length > 0 && (
            <span className="tnum">
              {fills.length} fills · ${volume.toFixed(0)} vol
            </span>
          )}
          <span className="truncate">
            {wallet ? "Your settled fills" : "All settled fills"} · from the L1 settlement pipeline
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
          {fills.length === 0 ? (
            <div className="text-center text-xs text-[var(--t-text-2)] py-6">
              {indexed ? "No settled fills yet" : "Indexer warming up…"}
            </div>
          ) : (
            fills.map((f) => {
              const isMaker = wallet !== null && f.maker === wallet;
              // Taker side is opposite the resting (maker) side; flip again for
              // the viewer's own side when they were the maker.
              const takerBought = f.maker_side === SIDE_BID ? false : true;
              const viewerBought = wallet ? (isMaker ? !takerBought : takerBought) : takerBought;
              const counterparty = isMaker ? f.taker : f.maker;
              return (
                <a
                  key={f.sequence}
                  href={explorerAddress(counterparty, "er")}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${GRID} group h-7 text-[11.5px] text-[var(--t-text)] border-b border-[var(--t-surface-2)] last:border-b-0 hover:bg-[var(--t-surface-3)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]`}
                >
                  <span className="font-mono tnum text-[var(--t-text-2)]">{fmtTime(f.settled_at)}</span>
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
