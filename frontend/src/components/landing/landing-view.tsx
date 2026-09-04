import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { HeroPrice } from "@/components/landing/hero-price";
import { SettlementStatus, VerifyLinks } from "@/components/landing/settlement-status";

/**
 * Landing page. A Server Component: the only interactive children are the theme
 * toggle and the price ticker, and both bring their own "use client".
 *
 * THE REWRITE, in one line: the old page had one visual idea (a glass card)
 * applied thirteen times, so nothing on it was emphasised and nothing on it was
 * live. Hierarchy now comes from the type ramp (56 / 16 / 14 / 13 / 12) and a
 * single accent colour, and the one thing that moves is a real price.
 *
 * COLOUR RULE, non-negotiable: every colour here is an arbitrary-value utility
 * over a --t-* token. NO `text-white/*`, no bare palette classes. The light
 * remap in globals.css only rewrites a fixed list of neutral utilities, so
 * anything off that list -- an unlisted opacity step, any palette class, every
 * gradient stop -- silently keeps its dark value in light mode. That is not
 * hypothetical: it is how the old gradient wordmark measured 1.24:1. The tokens
 * are defined on both :root and .dark, so the theme flips by variable swap and
 * the remap never has to match. Same mechanism market-bar.tsx already uses, so
 * the landing and the terminal finally agree.
 */

// Three rows, not four cards. "Real perps mechanics" is gone: it was a feature
// list, and the two things that actually distinguish this are where matching
// runs and where custody stays.
const SPEC: readonly (readonly [string, string])[] = [
  [
    "Matching",
    "Orders place, cancel and match inside a MagicBlock Ephemeral Rollup at roughly 10 ms — the speed an order book needs, without leaving Solana.",
  ],
  [
    "Custody",
    "Only the order book is delegated to the rollup. Collateral, positions and the vault never leave Solana L1, so the rollup cannot move funds.",
  ],
  [
    "Signing",
    "A scoped, expiring session key signs your orders locally. No wallet popup per trade, and it can never move your funds.",
  ],
];

export function LandingView() {
  return (
    <div className="app-bg flex min-h-screen flex-col">
      <header className="mx-auto flex h-16 w-full max-w-[760px] items-center px-6">
        <Link href="/" className="flex items-center gap-2.5">
          {/* alt="" — the adjacent text already names the link, so a description
              here makes a screen reader say "Slipstream Slipstream". */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-32.png" alt="" width={28} height={28} className="h-7 w-7 rounded-md" />
          <span className="text-[15px] font-semibold tracking-tight text-[var(--t-text)]">
            Slipstream
          </span>
        </Link>
        <nav className="ml-auto flex items-center gap-5 text-[13px]">
          <Link
            href="/docs"
            className="text-[var(--t-text-2)] transition-colors hover:text-[var(--t-text)]"
          >
            Docs
          </Link>
          <ThemeToggle />
        </nav>
      </header>

      <main className="mx-auto w-full max-w-[760px] flex-1 px-6 pb-24 pt-14 sm:pt-24">
        {/* The eyebrow used to be a pulsing dot next to the word "Live" over a
            page with no live data — the one dishonest element on it. It is now
            the frame for the real price, which reports its own staleness. */}
        <HeroPrice />

        <h1 className="mt-6 max-w-[19ch] text-[38px] font-semibold leading-[1.05] tracking-[-0.03em] text-[var(--t-text)] sm:text-[54px]">
          A perpetual-futures order book that settles on Solana.
        </h1>

        <p className="mt-6 max-w-[58ch] text-[16px] leading-relaxed text-[var(--t-text-2)]">
          Matching runs in a MagicBlock Ephemeral Rollup, so fills land in
          milliseconds. Your collateral and positions stay on Solana L1, where the
          rollup cannot reach them.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-6">
          {/* One filled button and one text link. Two buttons at identical
              weight is two primary actions, which is none. */}
          <Link
            href="/trade"
            className="rounded-lg bg-[var(--t-up-3)] px-5 py-2.5 text-[14px] font-semibold text-[var(--t-on-fill)] transition-opacity hover:opacity-90"
          >
            Launch the app
          </Link>
          <Link
            href="/docs"
            className="text-[14px] text-[var(--t-text-2)] underline decoration-[var(--t-border-strong)] underline-offset-4 transition-colors hover:text-[var(--t-text)]"
          >
            Read the docs
          </Link>
        </div>

        <dl className="mt-20 border-t border-[var(--t-border)]">
          {SPEC.map(([term, body]) => (
            <div
              key={term}
              className="grid gap-1 border-b border-[var(--t-border)] py-5 sm:grid-cols-[128px_1fr] sm:gap-6"
            >
              <dt className="text-[12px] font-semibold uppercase tracking-wider text-[var(--t-text-3)]">
                {term}
              </dt>
              <dd className="max-w-[56ch] text-[14px] leading-relaxed text-[var(--t-text-2)]">
                {body}
              </dd>
            </div>
          ))}
        </dl>

        {/* The trust boundary, stated plainly rather than implied by the word
            "secured". A reader evaluating this needs the limits, not adjectives. */}
        <p className="mt-10 max-w-[58ch] text-[13px] leading-relaxed text-[var(--t-text-2)]">
          What the rollup can and cannot do: it orders and matches your orders, so
          a faulty or malicious operator could in principle reorder or delay them.
          It cannot move collateral, mint, or settle a position against a price it
          chose — those paths live in the L1 program. There are no fraud proofs,
          and on devnet the rollup operator is trusted.
        </p>

        {/* Async server components. Both fail to null rather than throwing: the
            front door must render even when the chain does not answer. */}
        <SettlementStatus />
        <VerifyLinks />
      </main>

      <footer className="mx-auto w-full max-w-[760px] px-6 pb-10">
        <div className="flex flex-col gap-3 border-t border-[var(--t-border)] pt-6 text-[13px] text-[var(--t-text-3)] sm:flex-row sm:items-center sm:justify-between">
          <span>Slipstream · Devnet MVP</span>
          <div className="flex items-center gap-5">
            <Link href="/trade" className="transition-colors hover:text-[var(--t-text)]">
              App
            </Link>
            <Link href="/docs" className="transition-colors hover:text-[var(--t-text)]">
              Docs
            </Link>
            <a
              href="https://github.com/Ansh-699/SlipStream"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-[var(--t-text)]"
            >
              GitHub
            </a>
          </div>
        </div>
        {/* Was 11px at 2.46:1 in the default theme — the least readable text on
            the page was the sentence that keeps it honest. Now --t-text-2. */}
        <p className="mt-4 max-w-[64ch] text-[12px] leading-relaxed text-[var(--t-text-2)]">
          Devnet only. Trades use worthless test tokens. This is not production
          software — see the docs for the full trust model and the devnet
          concessions it makes.
        </p>
      </footer>
    </div>
  );
}
