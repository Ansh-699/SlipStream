"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

export interface NavItem {
  slug: string;
  title: string;
}

export function DocsShell({
  nav,
  children,
}: {
  nav: NavItem[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const hrefFor = (slug: string) => (slug ? `/docs/${slug}` : "/docs");
  const isActive = (slug: string) => pathname === hrefFor(slug);

  return (
    <div className="min-h-screen app-bg text-foreground">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-white/[0.08] backdrop-blur-md bg-black/40">
        <div className="max-w-[1100px] mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2.5 shrink-0">
            <span className="relative h-7 w-7 rounded-lg overflow-hidden shadow-[0_0_18px_rgba(16,185,129,0.5)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="Slipstream" className="h-full w-full object-cover" />
            </span>
            <span className="text-base font-bold tracking-tight">Slipstream</span>
            <span className="text-xs font-medium text-white/40 ml-1">docs</span>
          </Link>
          <div className="ml-auto flex items-center gap-3">
            <Link
              href="/trade"
              className="text-xs font-medium text-white/60 hover:text-white transition-colors"
            >
              ← Back to the terminal
            </Link>
            <ThemeToggle />
            <button
              onClick={() => setOpen((v) => !v)}
              className="lg:hidden text-xs font-medium px-2.5 py-1 rounded-md border border-white/15 text-white/70"
            >
              {open ? "Close" : "Menu"}
            </button>
          </div>
        </div>
      </header>

      {/* Stack on mobile, two columns from lg. The row layout must NOT apply
          below lg: when the Menu button unhides the aside there, `flex-row`
          gave the `w-full` aside the whole track and squeezed `flex-1 min-w-0`
          main down to 0px — the article slid off the right edge and re-flowed
          at min-content width (roughly one word per line, page height 4x). */}
      <div className="max-w-[1100px] mx-auto px-4 flex flex-col lg:flex-row gap-8 py-8">
        {/* Sidebar */}
        <aside
          className={`${
            open ? "block" : "hidden"
          } lg:block w-full lg:w-56 shrink-0 lg:sticky lg:top-20 lg:self-start`}
        >
          <nav className="flex flex-col gap-0.5">
            {nav.map((item) => (
              <Link
                key={item.slug || "index"}
                href={hrefFor(item.slug)}
                onClick={() => setOpen(false)}
                className={`text-sm px-3 py-1.5 rounded-md transition-colors ${
                  isActive(item.slug)
                    ? "bg-emerald-500/15 text-emerald-300 font-semibold"
                    : "text-white/60 hover:text-white hover:bg-white/[0.04]"
                }`}
              >
                {item.title}
              </Link>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
