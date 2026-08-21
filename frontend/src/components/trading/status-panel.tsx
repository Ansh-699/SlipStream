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
  ok: "bg-[#22c55e]",
  warn: "bg-[#f59e0b]",
  down: "bg-[#ef4444]",
};

function Row({ label, level, detail }: { label: string; level: Level; detail: string }) {
  return (
    <div className="flex h-[26px] items-center justify-between border-b border-[#15191a] last:border-b-0">
      <span className="text-[12px] text-[#a2abb1]">{label}</span>
      <span className="inline-flex items-center gap-1.5 text-[11px] font-mono tnum text-[#e6e9ea]">
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

  return (
    <div>
      <div className="flex h-[36px] items-center justify-between border-b border-[#1d2224] px-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#a2abb1]">
          System Status
        </span>
        <span className="text-[11px] text-[#838c92]">All signals verifiable on-chain</span>
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
        <Row label="Settlement" level={settleLevel} detail={settleDetail} />
      </div>
    </div>
  );
}
