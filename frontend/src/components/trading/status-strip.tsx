"use client";

import Link from "next/link";
import { useLivePrice } from "@/hooks/use-live-price";

/** Slim footer strip: connection truth on the left, reference links on the right. */
export function StatusStrip() {
  const { connected } = useLivePrice();

  return (
    <footer className="flex h-[32px] shrink-0 items-center gap-4 border-t border-[#1d2224] px-4 text-[11px] text-[#838c92]">
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-[#22c55e]" : "bg-[#a2abb1]"}`}
        />
        <span className={connected ? "text-[#22c55e]" : "text-[#a2abb1]"}>
          {connected ? "Oracle stream online" : "Oracle stream reconnecting"}
        </span>
      </span>

      <span className="hidden sm:inline">Devnet · worthless test tokens</span>

      <div className="ml-auto flex items-center gap-4">
        <Link href="/docs/06-session-keys" className="transition-colors hover:text-[#e6e9ea]">
          Session keys
        </Link>
        <Link href="/docs" className="transition-colors hover:text-[#e6e9ea]">
          Docs
        </Link>
        <a
          href="https://github.com/Ansh-699/SlipStream"
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-[#e6e9ea]"
        >
          Source
        </a>
      </div>
    </footer>
  );
}
