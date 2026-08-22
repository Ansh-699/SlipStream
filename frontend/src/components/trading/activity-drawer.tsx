"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { OpenOrders } from "./open-orders";
import { PositionsTable } from "./positions-table";
import { TradeHistory } from "./trade-history";

type Tab = "positions" | "orders" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "positions", label: "Positions" },
  { id: "orders", label: "Open Orders" },
  { id: "history", label: "Trade History" },
];

/**
 * The activity drawer under the chart. Collapsed it is just its tab strip, so a
 * trader can give the whole column to the chart without losing the tabs.
 */
export function ActivityDrawer({ markPrice }: { markPrice: bigint | null }) {
  const [tab, setTab] = useState<Tab>("positions");
  const [open, setOpen] = useState(true);

  return (
    <section className="flex shrink-0 flex-col border-t border-[var(--t-border)]" aria-label="Your activity">
      <div className="tk-head gap-4">
        <div role="tablist" aria-label="Activity" className="flex items-center gap-4">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`activity-${t.id}`}
              className="tk-tab"
              onClick={() => {
                setTab(t.id);
                setOpen(true);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Collapse activity" : "Expand activity"}
          className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded text-[var(--t-text-2)] transition-colors hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)]"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${open ? "" : "rotate-180"}`}
            strokeWidth={1.75}
          />
        </button>
      </div>

      {open && (
        <div id={`activity-${tab}`} role="tabpanel" className="h-[212px] overflow-auto slim-scroll">
          {tab === "positions" && <PositionsTable markPrice={markPrice} />}
          {tab === "orders" && <OpenOrders />}
          {tab === "history" && <TradeHistory />}
        </div>
      )}
    </section>
  );
}
