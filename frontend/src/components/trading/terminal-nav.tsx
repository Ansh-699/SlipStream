"use client";

import Link from "next/link";
import { Code2, Zap, BookText } from "lucide-react";
import { ConnectButton } from "@/components/wallet/connect-button";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Terminal top bar: identity on the left, utilities and the wallet on the right.
 * Deliberately not the marketing header — this one is 52px, flat, and gets out
 * of the way of the price ladder underneath it.
 */
export function TerminalNav() {
  return (
    <header className="flex h-[52px] shrink-0 items-center border-b border-[var(--t-border)] px-4">
      <Link href="/" className="flex items-center gap-2.5" aria-label="Slipstream home">
        <span className="relative h-6 w-6 overflow-hidden rounded">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-32.png" alt="" className="h-full w-full object-cover" />
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-[var(--t-text)]">Slipstream</span>
      </Link>

      <span className="ml-3 hidden rounded bg-[var(--t-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--t-text-2)] sm:inline">
        devnet
      </span>

      {/* The three icon links are `hidden sm:inline-flex` (NOT `inline-flex`,
          which would fight `hidden` for the same `display` slot). At 360px the
          right cluster measured 239px against a 107px wordmark and 32px of
          padding = 378px of content on a 360px viewport, so the whole document
          scrolled sideways and the Connect Wallet button — the entry point to
          every funded flow — was clipped at the edge. Dropping the three 32px
          icons brings the cluster to ~131px, which fits down to 320px with its
          padding intact. Docs and GitHub stay reachable on mobile through
          StatusStrip ("Docs" and "Source"); MagicBlock has no such duplicate
          and is an external marketing link, which is the acceptable loss. */}
      <div className="ml-auto flex items-center gap-1">
        <Link
          href="/docs"
          className="hidden h-8 w-8 items-center justify-center rounded text-[var(--t-text-2)] transition-colors hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)] sm:inline-flex"
          aria-label="Docs"
          title="Docs"
        >
          <BookText className="h-4 w-4" strokeWidth={1.75} />
        </Link>
        <a
          href="https://github.com/Ansh-699/SlipStream"
          target="_blank"
          rel="noopener noreferrer"
          className="hidden h-8 w-8 items-center justify-center rounded text-[var(--t-text-2)] transition-colors hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)] sm:inline-flex"
          aria-label="GitHub repository"
          title="GitHub"
        >
          <Code2 className="h-4 w-4" strokeWidth={1.75} />
        </a>
        <a
          href="https://www.magicblock.gg/"
          target="_blank"
          rel="noopener noreferrer"
          className="hidden h-8 w-8 items-center justify-center rounded text-[var(--t-text-2)] transition-colors hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)] sm:inline-flex"
          aria-label="MagicBlock"
          title="MagicBlock"
        >
          <Zap className="h-4 w-4" strokeWidth={1.75} />
        </a>
        {/* S13-05: the terminal had no theme control at all - ThemeToggle was
            rendered only on the landing page and /docs. `border-0` because this
            component's own default border is tuned for the landing glass
            surface; its text colour is left alone so the existing light-mode
            remap (which carries !important) keeps winning. */}
        <ThemeToggle className="border-0 rounded" />
        <div className="ml-2">
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
