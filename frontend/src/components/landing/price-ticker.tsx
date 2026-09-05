"use client";

import { useEffect, useState } from "react";
import { useLivePrice } from "@/hooks/use-live-price";

/**
 * The landing page's only live element: SOL-PERP mark, straight off the
 * MagicBlock rollup.
 *
 * WHY THIS ONE AND NOT THE ORDER BOOK: the book is currently full and FROZEN
 * (stale resting orders from before the makers were restarted), so a ladder
 * here would paint a healthy-looking 12x12 depth chart that never ticks --
 * a worse lie than the screenshot this page used to lead with. The ER oracle
 * feed is verifiably moving, and it is the one signal that stays up when the
 * base layer is rate-limited, which is the exact failure this project keeps
 * having.
 *
 * TWO GATES, both required. `connected` alone renders a frozen number as live
 * (see the note at use-live-price.ts:221) and `publishTime` alone cannot tell a
 * closed socket from a quiet one. Fail to an em dash, never to a stale price:
 * on a page whose whole argument is "this is really running", a wrong number is
 * worse than no number.
 */
const MAX_AGE_SECS = 10;

export function PriceTicker() {
  const { live, connected } = useLivePrice();
  // Re-render on a timer as well as on feed updates: if the socket goes quiet
  // the price stops arriving, so nothing would otherwise re-evaluate the age
  // and the last good value would sit here looking current.
  // Wall-clock as STATE, read only inside the interval and the lazy initializer:
  // calling Date.now() in render scope is impure (react-hooks/purity) and the
  // React Compiler refuses it. The lazy initializer runs once, so the first
  // paint is not a second late.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const fresh = connected && live !== null && now / 1000 - live.publishTime <= MAX_AGE_SECS;

  return (
    <span className="inline-flex items-baseline gap-2">
      <span
        className={`tnum text-[20px] font-semibold tracking-tight ${
          fresh ? "text-[var(--t-up)]" : "text-[var(--t-text-3)]"
        }`}
      >
        {fresh ? `$${live!.price.toFixed(2)}` : "—"}
      </span>
      <span className="text-[12px] text-[var(--t-text-3)]">
        {fresh ? "SOL-PERP · live on the rollup" : "SOL-PERP · reconnecting"}
      </span>
    </span>
  );
}
