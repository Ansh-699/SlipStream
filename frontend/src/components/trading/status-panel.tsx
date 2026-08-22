"use client";

import { useEffect, useState } from "react";
import { useMarket } from "@/hooks/use-market";
import { useOrderBook } from "@/hooks/use-orderbook";
import { useLivePrice } from "@/hooks/use-live-price";
import { PRICE_SCALE } from "@/lib/slipstream";

/**
 * Live system health: RPC layers, oracle stream, mark-price freshness (proxies
 * TWAP-crank liveness), and settlement pipeline lag. Everything here is
 * independently verifiable on-chain — the panel exists so a stalled keeper is
 * visible in seconds instead of surfacing as mysteriously stale prices.
 */

type Level = "ok" | "warn" | "down";

const DOT: Record<Level, string> = {
  ok: "bg-[var(--t-up)]",
  warn: "bg-[var(--t-warn)]",
  down: "bg-[var(--t-down)]",
};

function Row({ label, level, detail }: { label: string; level: Level; detail: string }) {
  return (
    <div className="flex h-[26px] items-center justify-between border-b border-[var(--t-surface-2)] last:border-b-0">
      <span className="text-[12px] text-[var(--t-text-2)]">{label}</span>
      <span className="inline-flex items-center gap-1.5 text-[11px] font-mono tnum text-[var(--t-text)]">
        {detail}
        <span className={`inline-block w-[6px] h-[6px] rounded-full ${DOT[level]}`} />
      </span>
    </div>
  );
}

interface ApiStatus {
  base: { ok: boolean; slot: number | null };
  er: { ok: boolean; slot: number | null };
  indexer: { lastFillAt: number | null };
  keepers: { lastFundingTs: number | null; ageSecs: number | null; stalled: boolean | null };
}

function since(secs: number): string {
  if (secs < 90) return `${Math.max(0, secs)}s ago`;
  if (secs < 5_400) return `${Math.round(secs / 60)}m ago`;
  if (secs < 172_800) return `${Math.round(secs / 3_600)}h ago`;
  return `${Math.round(secs / 86_400)}d ago`;
}

export function StatusPanel() {
  const { market } = useMarket(0);
  const { nextFillSequence } = useOrderBook(0);
  const { live, connected } = useLivePrice();
  const [api, setApi] = useState<ApiStatus | null>(null);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/status");
        const json = (await res.json()) as ApiStatus;
        if (!stop) setApi(json);
      } catch {
        if (!stop) setApi(null);
      }
    };
    poll();
    const id = setInterval(poll, 10_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  // Mark freshness: divergence between the on-chain mark (updated by the TWAP
  // crank + fills) and the live Pyth stream. A dead crank drifts within a
  // couple of ticks.
  let markLevel: Level = "warn";
  let markDetail = "—";
  if (market && live && market.lastMarkPrice > 0n) {
    const mark = Number(market.lastMarkPrice) / PRICE_SCALE;
    const divergencePct = Math.abs(mark - live.price) / live.price;
    markLevel = divergencePct > 0.015 ? "down" : divergencePct > 0.005 ? "warn" : "ok";
    markDetail = `${(divergencePct * 100).toFixed(2)}% off oracle`;
  }

  // Settlement lag: matching-engine sequence vs the L1 settlement cursor.
  let settleLevel: Level = "warn";
  let settleDetail = "—";
  if (market && nextFillSequence > 0) {
    const lag = Math.max(0, nextFillSequence - 1 - market.lastSettledSequence);
    settleLevel = lag > 500 ? "down" : lag > 100 ? "warn" : "ok";
    settleDetail = `${lag} fills behind`;
  }

  const rpcRow = (s: { ok: boolean; slot: number | null } | undefined): [Level, string] =>
    !api ? ["warn", "checking…"] : s?.ok ? ["ok", `slot ${s.slot}`] : ["down", "unreachable"];

  const [baseLevel, baseDetail] = rpcRow(api?.base);
  const [erLevel, erDetail] = rpcRow(api?.er);

  // Keeper liveness, stated rather than inferred (S7-01). Every other row here
  // is a proxy: "Mark freshness" needs the oracle stream up to say anything, and
  // both RPC rows read healthy right through a total keeper outage. This one
  // reads Market.last_funding_ts, which only compute_funding advances and only a
  // keeper sends, so it is the fleet's own heartbeat.
  const k = api?.keepers;
  let keeperLevel: Level = "warn";
  let keeperDetail = api ? "unknown" : "checking…";
  if (k && k.ageSecs !== null) {
    keeperDetail = `funding ${since(k.ageSecs)}`;
    keeperLevel = k.stalled === true ? "down" : k.stalled === false ? "ok" : "warn";
  }

  return (
    <div>
      <div className="flex h-[36px] items-center justify-between border-b border-[var(--t-border)] px-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-2)]">
          System Status
        </span>
        <span className="text-[11px] text-[var(--t-text-3)]">All signals verifiable on-chain</span>
      </div>
      <div className="p-3">
        <Row label="Solana RPC" level={baseLevel} detail={baseDetail} />
        <Row label="Ephemeral Rollup" level={erLevel} detail={erDetail} />
        <Row
          label="Oracle stream"
          level={connected ? "ok" : "down"}
          detail={connected && live ? `$${live.price.toFixed(2)}` : "disconnected"}
        />
        <Row label="Mark freshness" level={markLevel} detail={markDetail} />
        <Row label="Keepers" level={keeperLevel} detail={keeperDetail} />
        <Row label="Settlement" level={settleLevel} detail={settleDetail} />
      </div>
    </div>
  );
}
