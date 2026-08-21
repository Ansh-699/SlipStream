"use client";

import Link from "next/link";
import { LiquidButton } from "@/components/ui/liquid-glass-button";
import { ArrowLeftRight } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { LiveBook } from "./live-book";

/**
 * What the rollup is allowed to touch, and what it structurally cannot. This is
 * the product's actual differentiator, so it gets a section of its own rather
 * than a slot in a feature grid.
 */
const DELEGATED = [
  {
    name: "OrderBook",
    detail: "~612 KB of order metadata. Delegated permanently — it holds no value.",
  },
  {
    name: "TradingCredit",
    detail: "A per-market allowance you fund and cap yourself. The only value-bearing account that ever crosses.",
    bridge: true,
  },
];

const ON_L1 = [
  { name: "Free collateral", detail: "Your undelegated balance." },
  { name: "Positions", detail: "Settled size, entry, and margin." },
  { name: "Token vault", detail: "Where the USDC actually sits." },
];

const MECHANICS = [
  {
    term: "Matching",
    def: "Price-time priority inside a MagicBlock Ephemeral Rollup, on ~10 ms blocks. Limit and market orders, partial closes, and slippage-bounded close-at-market.",
  },
  {
    term: "Margin",
    def: "Up to 20× leverage against live Pyth pricing, with funding on an 8-hour interval computed from a 30-minute TWAP.",
  },
  {
    term: "Settlement",
    def: "Fills travel L1-ward through a small rotating fill log, then settle into real on-chain Position accounts. The 612 KB book itself is never committed.",
  },
  {
    term: "Signing",
    def: "A scoped, expiring session key signs your orders locally, so there is no wallet popup per trade. It can place and cancel orders and nothing else — moving money always requires you.",
  },
];

export function LandingView() {
  return (
    <div className="app-bg text-foreground relative min-h-screen overflow-x-hidden">
      <header className="relative z-30 mx-auto flex h-16 max-w-[1100px] items-center px-5">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="relative h-8 w-8 overflow-hidden rounded-lg shadow-[0_0_18px_rgba(16,185,129,0.45)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" className="h-full w-full object-cover" />
          </span>
          <span className="text-lg font-bold tracking-tight whitespace-nowrap">Slipstream</span>
        </Link>
        <nav className="ml-auto flex shrink-0 items-center gap-4 text-sm font-medium text-zinc-700 sm:gap-5 dark:text-white/70">
          <Link href="/docs" className="hidden transition-colors hover:text-white sm:inline">
            Docs
          </Link>
          <a
            href="https://github.com/Ansh-699/SlipStream"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden transition-colors hover:text-white sm:inline"
          >
            GitHub
          </a>
          <ThemeToggle />
          <Link
            href="/trade"
            className="whitespace-nowrap rounded-lg border border-emerald-500/30 bg-emerald-500/20 px-3 py-1.5 font-semibold text-emerald-800 transition-colors hover:bg-emerald-500/30 sm:px-4 dark:border-emerald-400/20 dark:text-emerald-100"
          >
            <span className="sm:hidden">Trade</span>
            <span className="hidden sm:inline">Open the terminal</span>
          </Link>
        </nav>
      </header>

      {/* Hero — the claim, then the running market that backs it. */}
      <section className="relative z-10 mx-auto grid max-w-[1100px] items-center gap-12 px-5 pt-12 pb-20 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-14 lg:pt-20">
        <div>
          <h1 className="text-[1.9rem] font-bold leading-[1.1] tracking-[-0.035em] text-balance sm:text-[2.9rem] lg:text-[3.05rem]">
            Order matching at rollup speed.
            <br />
            <span className="text-white/55">Custody at L1 security.</span>
          </h1>
          <p className="mt-6 max-w-[54ch] text-[15px] leading-relaxed text-white/60 sm:text-base">
            A perpetual-futures central-limit order book on Solana. Orders match inside a
            MagicBlock Ephemeral Rollup in about ten milliseconds. Your collateral, your
            positions, and the vault stay on Solana L1, where the rollup cannot reach them.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/trade">
              <LiquidButton
                size="xl"
                className="rounded-xl bg-emerald-500/40 font-semibold text-emerald-950 shadow-[0_4px_30px_rgba(16,185,129,0.35)] hover:bg-emerald-500/50 dark:bg-emerald-500/25 dark:text-emerald-50 dark:hover:bg-emerald-500/35"
              >
                Start trading
              </LiquidButton>
            </Link>
            <Link
              href="/docs"
              className="rounded-xl border border-black/10 px-5 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-black/[0.04] dark:border-white/10 dark:text-white/80 dark:hover:bg-white/[0.06]"
            >
              How it works
            </Link>
          </div>

          <p className="mt-5 text-[12.5px] text-zinc-600 dark:text-white/45">
            Free on devnet. The in-app faucet funds your wallet with test USDC and the SOL
            for network fees.
          </p>
        </div>

        <LiveBook />
      </section>

      {/* The custody boundary — the claim a neighbouring product can't copy. */}
      <section className="relative z-10 mx-auto max-w-[1100px] px-5 py-16">
        <h2 className="max-w-[26ch] text-2xl font-bold tracking-[-0.03em] text-balance sm:text-3xl">
          Delegation is capped, not unlimited
        </h2>
        <p className="mt-4 max-w-[68ch] text-[15px] leading-relaxed text-white/60">
          A rollup you trust with everything is just a server. Slipstream delegates the
          smallest surface that makes matching fast, and nothing else. The split is enforced
          by the program, not by convention.
        </p>

        <div className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-black/10 bg-black/10 shadow-[0_18px_48px_rgba(0,0,0,0.35)] dark:border-white/[0.09] dark:bg-white/[0.09] md:grid-cols-2">
          <div className="bg-white p-6 dark:bg-[#0f1615]">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden />
              <h3 className="text-[13px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300/90">
                Delegated to the rollup
              </h3>
            </div>
            <dl className="mt-5 space-y-5">
              {DELEGATED.map((d) => (
                <div key={d.name} className="pl-[18px]">
                  <dt className="flex items-center gap-1.5 text-sm font-semibold">
                    {d.name}
                    {d.bridge && (
                      <ArrowLeftRight
                        className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400"
                        strokeWidth={2.25}
                        aria-label="crosses the boundary"
                      />
                    )}
                  </dt>
                  <dd className="mt-1 text-[13px] leading-relaxed text-zinc-700 dark:text-white/55">{d.detail}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="bg-white p-6 dark:bg-[#0f1615]">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-600 dark:bg-emerald-400" aria-hidden />
              <h3 className="text-[13px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300/90">
                Never delegated · stays on L1
              </h3>
            </div>
            <dl className="mt-5 space-y-5">
              {ON_L1.map((d) => (
                <div key={d.name} className="pl-[18px]">
                  <dt className="text-sm font-semibold">{d.name}</dt>
                  <dd className="mt-1 text-[13px] leading-relaxed text-zinc-700 dark:text-white/55">{d.detail}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <p className="mt-6 max-w-[72ch] text-[13.5px] leading-relaxed text-zinc-700 dark:text-white/55">
          So the worst a misbehaving rollup can do is scramble the ordering of resting orders,
          or misuse a trading credit you already capped. It cannot reach the vault, and it
          cannot touch a balance you never delegated.
        </p>
      </section>

      {/* Mechanics — a spec sheet, not a feature grid. */}
      <section className="relative z-10 mx-auto max-w-[1100px] px-5 py-16">
        <h2 className="text-2xl font-bold tracking-[-0.03em] sm:text-3xl">What&apos;s running</h2>
        <dl className="mt-8 divide-y divide-white/[0.07] border-y border-white/[0.07]">
          {MECHANICS.map((m) => (
            <div key={m.term} className="grid gap-2 py-5 sm:grid-cols-[160px_1fr] sm:gap-8">
              <dt className="text-sm font-semibold text-white/85">{m.term}</dt>
              <dd className="max-w-[70ch] text-[14px] leading-relaxed text-white/60">{m.def}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Getting in — one action, mechanism available rather than staged. */}
      <section className="relative z-10 mx-auto max-w-[1100px] px-5 py-16">
        <div className="panel p-8 sm:p-10">
          <h2 className="max-w-[24ch] text-2xl font-bold tracking-[-0.03em] text-balance sm:text-3xl">
            Sign in and the setup runs itself
          </h2>
          <p className="mt-4 max-w-[62ch] text-[15px] leading-relaxed text-white/60">
            Sign in with Google, Apple, or a Solana wallet you already have. Slipstream creates
            the account, funds a capped trading credit, delegates it to the rollup, and
            authorises your session key as one flow. Withdrawing reverses it just as
            automatically.
          </p>
          <details className="group mt-6 max-w-[68ch]">
            <summary className="cursor-pointer list-none text-[13.5px] font-semibold text-emerald-700 underline-offset-4 hover:underline dark:text-emerald-400">
              What it does on your behalf
              <span className="ml-1 inline-block transition-transform group-open:rotate-90" aria-hidden>
                ›
              </span>
            </summary>
            <ol className="mt-4 space-y-3 text-[13.5px] leading-relaxed text-zinc-700 dark:text-white/55">
              <li>
                <strong className="font-semibold text-white/75">Initialises your account</strong> and
                deposits collateral into the L1 vault.
              </li>
              <li>
                <strong className="font-semibold text-white/75">Funds a trading credit</strong> — the
                capped allowance above, and the only thing the rollup can spend.
              </li>
              <li>
                <strong className="font-semibold text-white/75">Delegates it to the rollup</strong> and
                authorises a short-lived session key so trades need no popup.
              </li>
            </ol>
            <p className="mt-4 text-[13px] leading-relaxed text-zinc-600 dark:text-white/55">
              Every one of those steps is signed by you. The session key that follows can only
              place and cancel orders.
            </p>
          </details>

          <div className="mt-8">
            <Link href="/trade">
              <LiquidButton
                size="xl"
                className="rounded-xl bg-emerald-500/40 font-semibold text-emerald-950 shadow-[0_4px_30px_rgba(16,185,129,0.35)] hover:bg-emerald-500/50 dark:bg-emerald-500/25 dark:text-emerald-50 dark:hover:bg-emerald-500/35"
              >
                Start trading
              </LiquidButton>
            </Link>
          </div>
        </div>
      </section>

      <footer className="relative z-10 mx-auto max-w-[1100px] border-t border-white/[0.06] px-5 py-10">
        <div className="flex flex-col items-center justify-between gap-4 text-sm text-zinc-700 sm:flex-row dark:text-white/45">
          <div className="flex items-center gap-2">
            <span className="relative h-5 w-5 overflow-hidden rounded">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="" className="h-full w-full object-cover" />
            </span>
            <span className="font-medium text-zinc-800 dark:text-white/70">Slipstream</span>
            <span className="text-zinc-600 dark:text-white/50">· Devnet</span>
          </div>
          <div className="flex items-center gap-5">
            <Link href="/trade" className="transition-colors hover:text-white">
              Terminal
            </Link>
            <Link href="/docs" className="transition-colors hover:text-white">
              Docs
            </Link>
            <a
              href="https://github.com/Ansh-699/SlipStream"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-white"
            >
              GitHub
            </a>
          </div>
        </div>
        <p className="mt-5 max-w-[72ch] text-[11px] leading-relaxed text-zinc-600 dark:text-white/50">
          Devnet only. Trades use worthless test tokens, and the resting liquidity is quoted by
          Slipstream&apos;s own market-maker bot. Not audited, not production software — the docs
          cover the full trust model and the devnet concessions.
        </p>
      </footer>
    </div>
  );
}
