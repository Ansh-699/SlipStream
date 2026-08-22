"use client";

import Link from "next/link";
import { useOracleConnected } from "@/hooks/use-live-price";

/** Slim footer strip: connection truth on the left, reference links on the right. */
export function StatusStrip() {
  // Only the boolean — subscribing to the price snapshot would re-render this
  // footer at the 20 msg/s feed rate for a value that flips on connect only.
  const connected = useOracleConnected();

  return (
    <footer className="flex h-[32px] shrink-0 items-center gap-4 border-t border-[var(--t-border)] px-4 text-[11px] text-[var(--t-text-3)]">
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-[var(--t-up)]" : "bg-[var(--t-text-2)]"}`}
        />
        <span className={connected ? "text-[var(--t-up)]" : "text-[var(--t-text-2)]"}>
          {connected ? "Oracle stream online" : "Oracle stream reconnecting"}
        </span>
      </span>

      <span className="hidden sm:inline">Devnet · worthless test tokens</span>

      <div className="ml-auto flex items-center gap-4">
        <Link href="/docs/06-session-keys" className="transition-colors hover:text-[var(--t-text)]">
          Session keys
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
          Source
        </a>
      </div>
    </footer>
  );
}
