"use client";

import { TerminalNav } from "./terminal-nav";
import { MarketBar } from "./market-bar";
import { PriceChart } from "./price-chart";
import { OrderBookDisplay } from "./order-book-display";
import { OrderForm } from "./order-form";
import { SessionPanel } from "./session-panel";
import { StatusPanel } from "./status-panel";
import { ActivityDrawer } from "./activity-drawer";
import { StatusStrip } from "./status-strip";
import { FillToasts } from "./fill-toasts";
import { useMarket } from "@/hooks/use-market";
import { manifestError } from "@/lib/manifest";

/**
 * The trading terminal.
 *
 * A viewport-locked three-column workspace at `xl` and up — chart plus activity
 * drawer, the book, then the order ticket — the arrangement every exchange
 * terminal converges on, because a trader reads price, depth, and entry without
 * moving their eyes far. Below `xl` the columns stack and the page scrolls
 * normally, with the ticket and wallet ordered first: on a phone the primary
 * task has to be reachable without scrolling past a chart.
 */
export function TradingDashboard() {
  const { market } = useMarket(0);
  const markPrice = market?.lastMarkPrice ?? null;

  return (
    <div className="terminal flex min-h-screen flex-col xl:h-screen xl:overflow-hidden">
      {manifestError && (
        <div
          role="alert"
          className="shrink-0 border-b border-[#f59e0b]/40 bg-[#f59e0b]/10 px-4 py-2 text-[12px] font-medium text-[#f59e0b]"
        >
          {manifestError}
        </div>
      )}

      <TerminalNav />
      <MarketBar />

      <main className="flex min-h-0 flex-1 flex-col xl:flex-row">
        {/* Chart + activity. Owns the slack at xl; fixed height while stacked. */}
        <div className="tk-col order-2 flex min-h-0 min-w-0 flex-col xl:order-none xl:flex-1">
          <div className="h-[420px] shrink-0 xl:h-auto xl:min-h-0 xl:flex-1">
            <PriceChart />
          </div>
          <ActivityDrawer markPrice={markPrice} />
        </div>

        {/* Depth. */}
        <div className="tk-col order-3 flex h-[560px] w-full shrink-0 flex-col xl:order-none xl:h-auto xl:w-[336px]">
          <OrderBookDisplay />
        </div>

        {/* Entry, wallet, and system truth. */}
        <div className="tk-col slim-scroll order-1 flex w-full shrink-0 flex-col xl:order-none xl:w-[336px] xl:overflow-y-auto">
          <OrderForm />
          <SessionPanel />
          <StatusPanel />
        </div>
      </main>

      <StatusStrip />
      <FillToasts />
    </div>
  );
}
