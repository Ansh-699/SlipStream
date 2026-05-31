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
    <div className="flex flex-col app-bg text-foreground overflow-x-hidden relative">
      {manifestError && (
        <div
          role="alert"
          className="bg-amber-500/15 border-b border-amber-500/40 text-amber-200 text-xs font-medium px-3 md:px-4 lg:px-6 py-2 relative z-10"
        >
          {manifestError}
        </div>
      )}

      {/* ── Trading screen ───────────────────────────────────────────────
          The single-viewport lock (lg:h-screen) only applies on large screens
          where everything fits. On smaller/shorter screens the section grows to
          its natural height and the PAGE scrolls, so the order-form + session
          controls (Deposit + Init / Delegate to ER) are always reachable. */}
      <section className="lg:h-screen lg:min-h-[680px] flex flex-col px-3 md:px-4 lg:px-6 pt-3 pb-3 gap-3 max-w-[1700px] mx-auto w-full relative z-10">
        <div className="shrink-0">
          <MarketInfo />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 flex-1 lg:min-h-0">
          {/* Chart */}
          <div className="lg:col-span-6 min-h-[360px] lg:min-h-0 rise-in">
            <PriceChart />
          </div>

          {/* Order Book + Recent Trades */}
          <div className="lg:col-span-3 flex flex-col gap-3 lg:min-h-0 rise-in" style={{ animationDelay: "60ms" }}>
            <div className="min-h-[280px] lg:flex-[7] lg:min-h-0">
              <OrderBookDisplay />
            </div>
            <div className="min-h-[200px] lg:flex-[4] lg:min-h-0">
              <RecentTrades />
            </div>
          </div>

          {/* Order Form + Session — scrolls within the column on large screens,
              flows naturally (page scroll) on smaller ones. */}
          <div className="lg:col-span-3 flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto pr-1 pb-1 rise-in slim-scroll" style={{ animationDelay: "120ms" }}>
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
