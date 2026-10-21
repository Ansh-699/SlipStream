"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ER_RPC_DIRECT, explorerTx } from "@/lib/manifest";
import { erTxSamples, medianOf, onErTx, serverErTxSamples } from "@/lib/er-latency";

// One formatter for every row: toLocaleTimeString builds a new one per call.
const MIN_SEC = new Intl.DateTimeFormat([], { hour12: false, minute: "2-digit", second: "2-digit" });
/** Bar scale: a row at this many ms fills its bar. */
const SCALE_MS = 400;

/**
 * This browser's own MagicBlock rollup transactions, each with its measured
 * click -> processed time, plus the live network round trip to the rollup.
 *
 * It exists so the number that matters for a CLOB -- how long an order takes
 * to execute -- is on screen and measured, not claimed: the README says
 * "~10 ms"; this shows what this browser, from here, actually gets.
 */
export function ErTxPanel({ collapsed = false }: { collapsed?: boolean }) {
  const rows = useSyncExternalStore(onErTx, erTxSamples, serverErTxSamples);
  // This viewer's round trip to the rollup (median of the last 5 getHealth
  // pings). Five samples make the median; after that a slow refresh is plenty.
  const [rtt, setRtt] = useState<number | null>(null);
  useEffect(() => {
    const samples: number[] = [];
    let stopped = false;
    const ping = async () => {
      if (document.hidden) return;
      const started = performance.now();
      const ok = await fetch(ER_RPC_DIRECT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      })
        .then((r) => r.ok)
        .catch(() => false);
      if (!ok || stopped) return;
      samples.push(performance.now() - started);
      if (samples.length > 5) samples.shift();
      setRtt(Math.round([...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]));
    };
    void ping();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (samples.length < 5 || ticks % 5 === 0) void ping();
    }, 3_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const p50 = medianOf(rows, (r) => r.ms);
  const sendP50 = medianOf(rows, (r) => r.sendMs);

  return (
    <section
      className="flex min-h-0 flex-col border-t border-[var(--t-border)] md:border-l"
      aria-label="Your rollup transactions"
    >
      <div className="tk-head gap-2">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--t-up)] opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--t-up)]" />
        </span>
        <span className="whitespace-nowrap text-[12px] font-medium text-[var(--t-text)]">Rollup · live</span>
        <span
          className="ml-auto whitespace-nowrap text-[11px] text-[var(--t-text-3)]"
          title="p50 of your orders: click to processed in the MagicBlock rollup (send to processed in brackets). RTT: one network round trip from this browser to the rollup."
        >
          {p50 !== null ? (
            <>
              You p50 <span className="tnum font-medium text-[var(--t-up)]">{p50} ms</span>
              {sendP50 !== null ? <span className="tnum"> ({sendP50})</span> : null}
            </>
          ) : (
            "No orders yet"
          )}
          <span className="ml-2">
            RTT <span className="tnum">{rtt === null ? "—" : `${rtt} ms`}</span>
          </span>
        </span>
      </div>
      {/* Follows the drawer: collapsed, only the header (and its p50) stays. */}
      <div className={`slim-scroll h-[212px] overflow-auto ${collapsed ? "hidden" : ""}`}>
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-[var(--t-text-2)]">
            Your orders, cancels and closes appear here with their measured rollup time.
          </div>
        ) : (
          <ul className="space-y-1 p-1.5">
            {rows.map((row, index) => (
              <li
                key={row.signature}
                className={`grid h-[28px] grid-cols-[44px_1fr_auto] items-center gap-2 rounded-[6px] border border-[var(--t-border)] bg-[var(--t-surface)] px-2.5 text-[11.5px] ${
                  index === 0 ? "card-enter" : ""
                }`}
              >
                <a
                  href={explorerTx(row.signature, "er")}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tnum truncate text-[var(--t-text-3)] hover:text-[var(--t-text)]"
                >
                  {MIN_SEC.format(row.at)}
                </a>
                <span className="min-w-0 truncate text-[var(--t-text-2)]" title={row.via ? `answered by ${row.via}` : undefined}>
                  {row.kind}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="hidden h-[3px] w-10 overflow-hidden rounded bg-[var(--t-surface-3)] sm:block">
                    <span
                      className="block h-full rounded bg-[var(--t-up)]"
                      style={{ width: `${Math.min(100, ((row.ms ?? 0) / SCALE_MS) * 100)}%` }}
                    />
                  </span>
                  <span
                    className={`tnum w-[56px] text-right ${row.ok ? "text-[var(--t-text)]" : "text-[var(--t-down)]"}`}
                    title="click to processed in the rollup"
                  >
                    {row.ok && row.ms !== null ? `${row.ms} ms` : "failed"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
