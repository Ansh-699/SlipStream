"use client";

import { startPoll } from "@/lib/poll";
import { useEffect, useState } from "react";
import { useMarket } from "@/hooks/use-market";
import { useOrderBook } from "@/hooks/use-orderbook";
import { useLivePrice } from "@/hooks/use-live-price";
import { useMarkPrice } from "@/hooks/use-mark-price";

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
  const { mark, divergence, divergenceStale, stampStale, ageMins } = useMarkPrice(0);
  const [api, setApi] = useState<ApiStatus | null>(null);
  // "no payload yet" and "the probe itself failed" are different facts, and a
  // single `api === null` rendered them identically: a permanently 500ing
  // /api/status left Solana RPC, Ephemeral Rollup and Keepers sitting at amber
  // "checking…" forever, which reads as "still loading" on the one panel whose
  // stated job is to make an outage visible in seconds.
  const [probeFailed, setProbeFailed] = useState(false);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/status");
        // fetch rejects only on a network-level failure; a 500 from the route
        // resolves happily, and `res.json()` would then park Next's error body
        // in `api` as a payload with no base/er/keepers — rendering "unreachable"
        // on every row, i.e. blaming the chain for a broken status endpoint.
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as ApiStatus;
        if (!stop) {
          setApi(json);
          setProbeFailed(false);
        }
      } catch {
        // The last good payload is dropped, deliberately: a retained slot number
        // would keep rendering under a green "ok" dot and report a layer as
        // healthy on evidence that is minutes old. "status check failed" is a
        // worse-looking but truer answer.
        if (!stop) {
          setApi(null);
          setProbeFailed(true);
        }
      }
    };
    poll();
    const stopPoll = startPoll(poll, 10_000);
    return () => {
      stop = true;
      stopPoll();
    };
  }, []);

  // Mark freshness. Two independent signals, both from useMarkPrice so the
  // thresholds and the age clock live in exactly one place:
  //   - the program's own stamp gate (Market::is_mark_price_fresh), which needs
  //     nothing but the market account, and
  //   - mark-vs-oracle divergence, which catches a mark that is being stamped
  //     but is wrong, and says nothing at all while the oracle is down.
  //
  // This row used to recompute divergence here against a raw `live` read with a
  // second set of cutoffs (0.015 / 0.005). `live` was frozen at its last frame
  // whenever the socket died, so during an oracle outage the row scored a green
  // "0.02% off oracle" directly beneath its own red "Oracle stream —
  // disconnected". With no oracle there is nothing to compare the mark against,
  // and that is not "ok".
  let markLevel: Level = "warn";
  let markDetail = "—";
  if (stampStale && ageMins !== null) {
    markLevel = "down";
    markDetail = `stamp ${since(ageMins * 60)}`;
  } else if (divergence !== null) {
    markLevel = divergenceStale ? "down" : "ok";
    markDetail = `${(divergence * 100).toFixed(2)}% off oracle`;
  } else if (mark !== null) {
    markDetail = "no oracle to compare";
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
    api
      ? s?.ok
        ? ["ok", `slot ${s.slot}`]
        : ["down", "unreachable"]
      : probeFailed
        ? ["down", "status check failed"]
        : ["warn", "checking…"];

  const [baseLevel, baseDetail] = rpcRow(api?.base);
  const [erLevel, erDetail] = rpcRow(api?.er);

  // Keeper liveness, stated rather than inferred (S7-01). Every other row here
  // is a proxy: "Mark freshness" needs the oracle stream up to say anything, and
  // both RPC rows read healthy right through a total keeper outage. This one
  // reads Market.last_funding_ts, which only compute_funding advances and only a
  // keeper sends, so it is the fleet's own heartbeat.
  const k = api?.keepers;
  let keeperLevel: Level = probeFailed ? "down" : "warn";
  let keeperDetail = api ? "unknown" : probeFailed ? "status check failed" : "checking…";
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
        {/* `live` is null whenever the socket is down — useLivePrice gates it in
            its own getSnapshot — so a connected socket that has not delivered a
            frame yet is its own state, not "disconnected" under a green dot. */}
        <Row
          label="Oracle stream"
          level={connected ? (live ? "ok" : "warn") : "down"}
          detail={live ? `$${live.price.toFixed(2)}` : connected ? "waiting for data" : "disconnected"}
        />
        <Row label="Mark freshness" level={markLevel} detail={markDetail} />
        <Row label="Keepers" level={keeperLevel} detail={keeperDetail} />
        <Row label="Settlement" level={settleLevel} detail={settleDetail} />
      </div>
    </div>
  );
}
