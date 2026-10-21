"use client";

import dynamic from "next/dynamic";

// ssr:false is correctness, not perf: the ticker's hook chain reaches
// @/lib/manifest, which throws at module scope when deploy.json is absent.
// The fallback duplicates the ticker's markup rather than importing it, since a
// shared import here would eagerly pull that same chain back into the shell.
const PriceTicker = dynamic(() => import("./price-ticker").then((m) => m.PriceTicker), {
  ssr: false,
  loading: () => (
    <span className="inline-flex items-baseline gap-2">
      <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] leading-[1.4] text-[var(--t-text-3)]">
        SOL-PERP
      </span>
      <span className="tnum font-mono text-[13px] leading-[1.45] text-[var(--t-text-3)]">—</span>
    </span>
  ),
});

export function HeroPrice() {
  // Fixed height: the masthead must not jump when the socket connects.
  return (
    <div className="flex h-[19px] items-center">
      <PriceTicker />
    </div>
  );
}
