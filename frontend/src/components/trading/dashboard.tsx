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
          Normal scrolling document (NO viewport height-lock). A 12-col grid:
          the LEFT 9 cols hold the chart + order book on top and the Open Orders
          + Positions tables below; the RIGHT 3 cols hold the Order Form + the
          Trading Session. So Positions sits directly to the LEFT of the Trading
          Session and the two columns end on roughly the same plane. */}
      <section className="flex flex-col px-3 md:px-4 lg:px-6 pt-3 pb-6 gap-3 max-w-[1700px] mx-auto w-full relative z-10">
        <div className="shrink-0">
          <MarketInfo />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
          {/* LEFT 9 cols: chart + book on top, activity tables below */}
          <div className="lg:col-span-9 flex flex-col gap-3">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-start">
              {/* Chart */}
              <div className="lg:col-span-2 h-[440px] lg:h-[620px] rise-in">
                <PriceChart />
              </div>
              {/* Order Book + Recent Trades */}
              <div className="lg:col-span-1 flex flex-col gap-3 rise-in" style={{ animationDelay: "60ms" }}>
                <div className="h-[360px] lg:h-[400px]">
                  <OrderBookDisplay />
                </div>
                <div className="h-[260px] lg:h-[208px]">
                  <RecentTrades />
                </div>
              </div>
            </div>

            {/* Open Orders + Positions — now to the LEFT of the session panel. */}
            <div className="flex items-center gap-2 mt-1">
              <div className="h-px flex-1 bg-white/[0.06]" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-white/30">
                Your Activity
              </span>
              <div className="h-px flex-1 bg-white/[0.06]" />
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 rise-in" style={{ animationDelay: "150ms" }}>
              <OpenOrders />
              <PositionsTable markPrice={markPrice} />
            </div>
          </div>

          {/* RIGHT 3 cols: Order Form + Trading Session. */}
          <div className="lg:col-span-3 flex flex-col gap-3 rise-in" style={{ animationDelay: "120ms" }}>
            <OrderForm />
            <SessionPanel />
          </div>
        </div>
      </section>
    </div>
  );
}
