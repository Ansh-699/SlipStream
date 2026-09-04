"use client";

import dynamic from "next/dynamic";

/**
 * Client-only split for the ticker.
 *
 * This is a CORRECTNESS requirement, not a perf tweak: the ticker's hook chain
 * reaches @/lib/manifest, which constructs PublicKeys at module scope and
 * THROWS when deploy.json is absent. Rendered on the server that turns a
 * missing manifest into a 500 on the site's front door; behind ssr:false the
 * page still renders and only the price falls back to its em dash.
 *
 * The reserved height keeps the headline from jumping when the socket connects
 * -- the layout must not depend on whether the rollup answered.
 */
const PriceTicker = dynamic(() => import("./price-ticker").then((m) => m.PriceTicker), {
  ssr: false,
  loading: () => <span className="text-[12px] text-[var(--t-text-3)]">SOL-PERP · connecting</span>,
});

export function HeroPrice() {
  return (
    <div className="flex h-8 items-center">
      <PriceTicker />
    </div>
  );
}
