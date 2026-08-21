"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { useMarket } from "@/hooks/use-market";
import { ConnectButton } from "@/components/wallet/connect-button";
import { ThemeToggle } from "@/components/theme-toggle";

const PRICE_SCALE = 1_000_000;

function Brand() {
  return (
    <div className="flex items-center gap-2.5 shrink-0">
      <div className="relative h-7 w-7 rounded-lg overflow-hidden shadow-[0_0_18px_rgba(16,185,129,0.5)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="Slipstream" className="h-full w-full object-cover" />
      </div>
      <span className="text-base font-bold tracking-tight text-white hidden sm:inline">
        Slipstream
      </span>
    </div>
  );
}

export function MarketInfo() {
  const { market, loading } = useMarket(0);

  const shell = (children: React.ReactNode) => (
    <div className="panel-bar px-4 py-2.5 relative z-40">
      <div className="flex items-center gap-4 flex-wrap">
        <Brand />
        <div className="h-9 w-px bg-white/10 hidden sm:block" />
        <div className="flex items-center gap-5 flex-wrap flex-1 min-w-0">{children}</div>
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          <Link
            href="/docs"
            className="text-xs font-medium text-white/55 hover:text-white transition-colors hidden sm:inline"
          >
            Docs
          </Link>
          <ThemeToggle />
          <ConnectButton />
        </div>
      </div>
    </div>
  );

  if (loading) {
    return shell(<span className="text-sm font-medium text-white/50">Loading market…</span>);
  }

  if (!market) {
    return shell(
      <span className="text-sm font-medium text-white/50">
        Market not initialized.
      </span>
    );
  }

  const markPrice = Number(market.lastMarkPrice) / PRICE_SCALE;
  const oiLong = Number(market.openInterestLong) / 1e9;
  const oiShort = Number(market.openInterestShort) / 1e9;

  // Live funding-rate estimate for the NEXT interval: premium = (mark − index)/index.
  // We use the book TWAP as mark and the live mark price as the index proxy
  // (same inputs compute_funding uses on-chain). Shown in bps; + = longs pay.
  const twap = market.twapPrice;
  const fundingBps =
    twap && markPrice > 0 ? ((twap - markPrice) / markPrice) * 10_000 : null;

  return shell(
    <>
      <div className="flex flex-col shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold tracking-tight text-white">SOL-PERP</span>
          {market.circuitBreakerActive ? (
            <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">PAUSED</Badge>
          ) : market.restrictedMode ? (
            <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">CLOSES ONLY</Badge>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-300/80 uppercase tracking-wider">
              <span className="live-dot" /> Live
            </span>
          )}
        </div>
        <span className="text-[10px] text-white/55 font-medium">Perpetual · ER</span>
      </div>

      <div className="flex flex-col shrink-0">
        <span className="text-[22px] leading-none font-bold tnum text-white tracking-tight">
          ${markPrice > 0 ? markPrice.toFixed(3) : "—"}
        </span>
        <span className="text-[10px] text-white/55 font-medium uppercase tracking-wider mt-1">Mark</span>
      </div>

      <Stat label="OI Long" value={`${oiLong.toFixed(2)}`} accent="emerald" />
      <Stat label="OI Short" value={`${oiShort.toFixed(2)}`} accent="rose" />
      <Stat
        label="Funding / 8h"
        value={
          fundingBps !== null
            ? `${fundingBps >= 0 ? "+" : ""}${(fundingBps / 100).toFixed(3)}%`
            : "—"
        }
        accent={fundingBps !== null ? (fundingBps >= 0 ? "emerald" : "rose") : undefined}
      />
    </>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "emerald" | "rose";
}) {
  const color =
    accent === "emerald"
      ? "text-emerald-400"
      : accent === "rose"
      ? "text-rose-400"
      : "text-white";
  return (
    <div className="flex flex-col shrink-0">
      <span className={`text-sm font-bold tnum ${color}`}>{value}</span>
      <span className="text-[10px] text-white/55 font-medium uppercase tracking-wider mt-0.5">
        {label}
      </span>
    </div>
  );
}
