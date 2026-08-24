"use client";

import Link from "next/link";
import { Zap, ShieldCheck, TrendingUp, KeyRound } from "lucide-react";
import { LiquidGlassCard } from "@/components/ui/liquid-weather-glass";
import { LiquidButton } from "@/components/ui/liquid-glass-button";
import { ThemeToggle } from "@/components/theme-toggle";

const FEATURES = [
  {
    title: "Rollup-speed matching",
    body: "Orders place, cancel, and match inside a MagicBlock Ephemeral Rollup at ~10 ms — the speed a real order book needs, without leaving Solana.",
    Icon: Zap,
  },
  {
    title: "L1 custody, always",
    body: "Only the order book is delegated to the rollup. Collateral, positions, and the vault never leave Solana L1 — funds can't be moved by the ER.",
    Icon: ShieldCheck,
  },
  {
    title: "Real perps mechanics",
    body: "Up to 20× leverage, live Pyth pricing, funding, and liquidations — settled into real on-chain positions through the fill-log pipeline.",
    Icon: TrendingUp,
  },
  {
    title: "Sign once, trade many",
    body: "A scoped, expiring session key signs your orders locally — no wallet popup per trade, and it can never move your funds.",
    Icon: KeyRound,
  },
];

const STATS = [
  { value: "~10 ms", label: "ER block time" },
  { value: "20×", label: "Max leverage" },
  { value: "612 KB", label: "On-chain order book" },
  { value: "Solana", label: "Devnet MVP" },
];

const STEPS = [
  { n: "01", t: "Connect & fund", d: "Connect a Solana wallet, grab test USDC from the faucet, and deposit collateral." },
  { n: "02", t: "Start a session", d: "Delegate a scoped trading credit to the rollup and authorize a one-tap session key." },
  { n: "03", t: "Trade at speed", d: "Place margin × leverage orders that match in the ER instantly, then settle to L1." },
];

export function LandingView() {
  return (
    <div className="min-h-screen app-bg text-foreground relative overflow-x-hidden">
      {/* Top nav */}
      <header className="relative z-30 max-w-[1200px] mx-auto px-5 h-16 flex items-center">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="relative h-8 w-8 rounded-lg overflow-hidden shadow-[0_0_18px_rgba(16,185,129,0.5)]">
            {/* logo-32.png, not logo.png: the render box is 32px and the 512px
                original cost 160 KB to paint it. 2.7 KB, same artwork. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-32.png" alt="Slipstream" className="h-full w-full object-cover" />
          </span>
          <span className="text-lg font-bold tracking-tight">Slipstream</span>
        </Link>
        <nav className="ml-auto flex items-center gap-5 text-sm font-medium text-white/70">
          <Link href="/docs" className="hover:text-white transition-colors hidden sm:inline">Docs</Link>
          <ThemeToggle />
          <Link
            href="/trade"
            className="rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-800 dark:text-emerald-100 px-4 py-1.5 transition-colors border border-emerald-500/30 dark:border-emerald-400/20 font-semibold"
          >
            Launch App
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <section className="relative z-10 max-w-[1100px] mx-auto px-5 pt-10 pb-16 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-medium text-white/60 mb-7">
          <span className="live-dot" /> Live on Solana devnet · MagicBlock ER
        </div>

        {/* Banner */}
        <div className="mx-auto max-w-[640px] rise-in">
          <LiquidGlassCard
            shadowIntensity="sm"
            glowIntensity="md"
            blurIntensity="xl"
            borderRadius="24px"
            className="glass-surface overflow-hidden"
          >
            {/* width/height are the INTRINSIC 1600x900, not a render size --
                `w-full h-auto` still governs the painted box. They exist so the
                browser reserves the aspect-ratio box before the 487 KB lands;
                without them the hero was 0px tall until decode and both CTAs
                below jumped ~189px down under the user's finger. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/banner.png" alt="Slipstream" width={1600} height={900} className="w-full h-auto block" />
          </LiquidGlassCard>
        </div>

        <h1 className="mt-9 text-5xl sm:text-6xl md:text-7xl font-bold tracking-tight leading-[1.05]">
          {/* The light stops are the DEFAULT and the 300/400 stops are behind
              `dark:` -- the same shape the two CTAs below use. Palette classes
              like `from-emerald-300` are invisible to the light-mode remap
              block in globals.css (it only rewrites the neutral white/N
              utilities), so as bare defaults this 72px wordmark rendered at
              1.24-1.43:1 on the light `.app-bg` gradient; the 700/800 stops
              measure 4.50-7.17:1 across the same gradient. Dark mode is
              unchanged: `.dark .dark\:from-emerald-300` (0,2,0) beats the bare
              class (0,1,0). */}
          <span className="bg-gradient-to-r from-emerald-700 via-teal-700 to-emerald-800 dark:from-emerald-300 dark:via-teal-300 dark:to-emerald-400 bg-clip-text text-transparent">Slipstream</span>
        </h1>
        <p className="mt-5 mx-auto max-w-[620px] text-base sm:text-lg text-white/60 leading-relaxed">
          A perpetual-futures central-limit order book on Solana. Matching runs in a
          MagicBlock Ephemeral Rollup for sub-second fills; your collateral and
          positions stay secured on Solana L1.
        </p>

        <div className="mt-9 flex items-center justify-center gap-3 flex-wrap">
          <Link href="/trade">
            <LiquidButton
              size="xl"
              className="font-semibold text-emerald-950 dark:text-emerald-50 bg-emerald-500/40 dark:bg-emerald-500/25 hover:bg-emerald-500/50 dark:hover:bg-emerald-500/35 shadow-[0_4px_30px_rgba(16,185,129,0.4)] rounded-xl"
            >
              Launch the app →
            </LiquidButton>
          </Link>
          <Link href="/docs">
            <LiquidButton
              size="xl"
              className="font-semibold text-zinc-800 dark:text-white/90 bg-black/[0.06] dark:bg-white/[0.06] hover:bg-black/[0.1] dark:hover:bg-white/[0.12] rounded-xl border border-black/10 dark:border-white/10"
            >
              Read the docs
            </LiquidButton>
          </Link>
        </div>

        {/* Stat strip */}
        <div className="mt-12 grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-[760px] mx-auto">
          {STATS.map((s) => (
            <LiquidGlassCard
              key={s.label}
              shadowIntensity="xs"
              glowIntensity="xs"
              borderRadius="16px"
              className="glass-surface px-4 py-4"
            >
              <div className="text-2xl font-bold tnum text-white">{s.value}</div>
              <div className="text-[11px] uppercase tracking-wider text-white/45 font-semibold mt-1">
                {s.label}
              </div>
            </LiquidGlassCard>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="relative z-10 max-w-[1100px] mx-auto px-5 py-12">
        <div className="text-center mb-10">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">Built for speed, secured by Solana</h2>
          <p className="mt-3 text-white/55 max-w-[560px] mx-auto">
            The hard parts of an on-chain order book — solved by splitting hot state
            from value-bearing state.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {FEATURES.map((f) => (
            <LiquidGlassCard
              key={f.title}
              shadowIntensity="sm"
              glowIntensity="xs"
              borderRadius="20px"
              className="glass-surface p-6"
            >
              <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/15 border border-emerald-400/20 text-emerald-400">
                <f.Icon className="h-5 w-5" strokeWidth={2} />
              </div>
              <h3 className="text-lg font-semibold text-white mb-1.5">{f.title}</h3>
              <p className="text-sm text-white/60 leading-relaxed">{f.body}</p>
            </LiquidGlassCard>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="relative z-10 max-w-[1100px] mx-auto px-5 py-12">
        <div className="text-center mb-10">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">Start trading in three steps</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {STEPS.map((s) => (
            <LiquidGlassCard
              key={s.n}
              shadowIntensity="sm"
              glowIntensity="xs"
              borderRadius="20px"
              className="glass-surface p-6"
            >
              <div className="text-sm font-bold tnum text-emerald-400 mb-2">{s.n}</div>
              <h3 className="text-base font-semibold text-white mb-1.5">{s.t}</h3>
              <p className="text-sm text-white/60 leading-relaxed">{s.d}</p>
            </LiquidGlassCard>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="relative z-10 max-w-[900px] mx-auto px-5 py-14">
        <LiquidGlassCard
          shadowIntensity="md"
          glowIntensity="md"
          borderRadius="28px"
          className="glass-surface p-10 text-center"
        >
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">Ready to trade?</h2>
          <p className="mt-3 text-white/60 max-w-[480px] mx-auto">
            It&apos;s free on devnet — grab test USDC from the in-app faucet and place your
            first leveraged order in under a minute.
          </p>
          <div className="mt-7 flex items-center justify-center gap-3 flex-wrap">
            <Link href="/trade">
              <LiquidButton
                size="xl"
                className="font-semibold text-emerald-950 dark:text-emerald-50 bg-emerald-500/40 dark:bg-emerald-500/25 hover:bg-emerald-500/50 dark:hover:bg-emerald-500/35 shadow-[0_4px_30px_rgba(16,185,129,0.4)] rounded-xl"
              >
                Launch the app →
              </LiquidButton>
            </Link>
          </div>
        </LiquidGlassCard>
      </section>

      {/* Footer */}
      <footer className="relative z-10 max-w-[1100px] mx-auto px-5 py-10 border-t border-white/[0.06]">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/45">
          <div className="flex items-center gap-2">
            <span className="relative h-5 w-5 rounded overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo-32.png" alt="Slipstream" className="h-full w-full object-cover" />
            </span>
            <span className="font-medium text-white/70">Slipstream</span>
            <span className="text-white/30">· Devnet MVP</span>
          </div>
          <div className="flex items-center gap-5">
            <Link href="/trade" className="hover:text-white transition-colors">App</Link>
            <Link href="/docs" className="hover:text-white transition-colors">Docs</Link>
            <a
              href="https://github.com/Ansh-699/SlipStream"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white transition-colors"
            >
              GitHub
            </a>
          </div>
        </div>
        <p className="mt-5 text-[11px] text-white/30 text-center sm:text-left max-w-[680px]">
          Devnet only. Trades use worthless test tokens. Not production software — see the
          docs for the full trust model and devnet concessions.
        </p>
      </footer>
    </div>
  );
}
