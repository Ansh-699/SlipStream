"use client";

import { MarketInfo } from "./market-info";
import { OrderForm } from "./order-form";
import { OrderBookDisplay } from "./order-book-display";
import { PositionsTable } from "./positions-table";
import { OpenOrders } from "./open-orders";
import { SessionPanel } from "./session-panel";
import { PriceChart } from "./price-chart";
import { RecentTrades } from "./recent-trades";
import { TradeHistory } from "./trade-history";
import { StatusPanel } from "./status-panel";
import { FillToasts } from "./fill-toasts";
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
          Session and the two columns end on roughly the same plane.

          Below `lg` the columns stack, and source order would bury the order
          form and the wallet under ~1.7k px of chart and tables — the two
          things a new visitor needs first. So the right column is ordered
          first on small screens and back to the right at `lg`. */}
      <section className="flex flex-col px-3 md:px-5 lg:px-8 pt-4 pb-10 gap-4 max-w-[1700px] mx-auto w-full relative z-10">
        <div className="shrink-0">
          <MarketInfo />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* LEFT 9 cols: chart + book on top, activity tables below */}
          <div className="order-3 lg:order-none lg:col-span-9 flex flex-col gap-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
              {/* Chart */}
              <div className="lg:col-span-2 h-[440px] lg:h-[620px]">
                <PriceChart />
              </div>
              {/* Order Book + Recent Trades */}
              <div className="lg:col-span-1 flex flex-col gap-4">
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
              <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-white/50">
                Your Activity
              </span>
              <div className="h-px flex-1 bg-white/[0.06]" />
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <OpenOrders />
              <PositionsTable markPrice={markPrice} />
            </div>

            {/* Settled trade history (from the fills indexer). */}
            <TradeHistory />
          </div>

          {/* RIGHT 3 cols: Order Form + Trading Session + System Status.

              `contents` below `lg` dissolves this wrapper so its three panels
              become grid items in their own right and can be ordered against
              the left column individually: order form and wallet first, system
              telemetry last. Rendering StatusPanel twice would have been the
              other way to do it, and would have doubled its RPC polling. */}
          <div className="contents lg:flex lg:order-none lg:col-span-3 lg:flex-col lg:gap-4">
            <div className="order-1 lg:order-none">
              <OrderForm />
            </div>
            <div className="order-2 lg:order-none">
              <SessionPanel />
            </div>
            <div className="order-4 lg:order-none">
              <StatusPanel />
            </div>
          </div>
        </div>
      </section>

      {/* Fill notifications for the connected wallet. */}
      <FillToasts />
    </div>
  );
}
