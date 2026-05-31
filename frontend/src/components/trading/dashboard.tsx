"use client";

import { MarketInfo } from "./market-info";
import { OrderForm } from "./order-form";
import { OrderBookDisplay } from "./order-book-display";
import { PositionsTable } from "./positions-table";
import { OpenOrders } from "./open-orders";
import { SessionPanel } from "./session-panel";
import { PriceChart } from "./price-chart";
import { RecentTrades } from "./recent-trades";
import { useMarket } from "@/hooks/use-market";
import { manifestError } from "@/lib/manifest";

export function TradingDashboard() {
  const { market } = useMarket(0);
  const markPrice = market?.lastMarkPrice ?? null;

  return (
    <div className="min-h-screen flex flex-col app-bg text-foreground overflow-x-hidden relative">
      {manifestError && (
        <div
          role="alert"
          className="bg-amber-500/15 border-b border-amber-500/40 text-amber-200 text-xs font-medium px-3 md:px-4 lg:px-6 py-2 relative z-10"
        >
          {manifestError}
        </div>
      )}

      {/* ── Trading screen ───────────────────────────────────────────────
          Normal scrolling document (NO viewport height-lock). Columns have
          explicit heights only on large screens so the desktop layout stays
          tidy; the order-form + session column flows at its natural height and
          `items-start` stops it being stretched/clipped, so the whole page can
          always scroll to reach the Trading Session controls and the activity
          section below. */}
      <section className="flex flex-col px-3 md:px-4 lg:px-6 pt-3 pb-3 gap-3 max-w-[1700px] mx-auto w-full relative z-10">
        <div className="shrink-0">
          <MarketInfo />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
          {/* Chart */}
          <div className="lg:col-span-6 h-[440px] lg:h-[620px] rise-in">
            <PriceChart />
          </div>

          {/* Order Book + Recent Trades */}
          <div className="lg:col-span-3 flex flex-col gap-3 rise-in" style={{ animationDelay: "60ms" }}>
            <div className="h-[360px] lg:h-[400px]">
              <OrderBookDisplay />
            </div>
            <div className="h-[260px] lg:h-[208px]">
              <RecentTrades />
            </div>
          </div>

          {/* Order Form + Session — natural height, flows with the page. */}
          <div className="lg:col-span-3 flex flex-col gap-3 rise-in" style={{ animationDelay: "120ms" }}>
            <OrderForm />
            <SessionPanel />
          </div>
        </div>
      </section>

      {/* ── Below the fold: Open Orders + Positions ──────────────────────── */}
      <section className="px-3 md:px-4 lg:px-6 pb-6 pt-1 max-w-[1700px] mx-auto w-full relative z-10">
        <div className="flex items-center gap-2 mb-3 mt-2">
          <div className="h-px flex-1 bg-white/[0.06]" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-white/30">
            Your Activity
          </span>
          <div className="h-px flex-1 bg-white/[0.06]" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <OpenOrders />
          <PositionsTable markPrice={markPrice} />
        </div>
      </section>
    </div>
  );
}
