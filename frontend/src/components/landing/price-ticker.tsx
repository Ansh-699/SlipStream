"use client";

import { useEffect, useState } from "react";
import { useLivePrice } from "@/hooks/use-live-price";

// Both gates are required: `connected` alone renders a frozen number as live,
// and publishTime alone cannot tell a closed socket from a quiet one.
const MAX_AGE_SECS = 10;

export function PriceTicker() {
  const { live, connected } = useLivePrice();
  // Wall-clock as state, never in render scope — react-hooks/purity and the
  // React Compiler both reject Date.now() there.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const fresh = connected && live !== null && now / 1000 - live.publishTime <= MAX_AGE_SECS;

  return (
    <span className="inline-flex items-baseline gap-2">
      <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] leading-[1.4] text-[var(--t-text-3)]">
        SOL-PERP
      </span>
      <span
        title={fresh ? undefined : "No fresh mark from the rollup"}
        className={`tnum font-mono text-[13px] leading-[1.45] ${
          fresh ? "text-[var(--t-up)]" : "text-[var(--t-text-3)]"
        }`}
      >
        {fresh ? live!.price.toFixed(2) : "—"}
      </span>
    </span>
  );
}
