import Link from "next/link";

// The root not-found boundary. Without this file Next served its built-in 404:
// an unstyled white page in Times New Roman with no logo, no nav and not one
// link — a dead end in dark mode for anyone following a stale docs URL (the
// slugs are guessable numbered filenames, and /docs is the CTA target from both
// landing buttons). Being at the root of app/, this renders inside
// app/layout.tsx, so it inherits the fonts, the theme script and the body
// background. It covers notFound() from docs/[slug]/page.tsx and docs/page.tsx
// as well as any unmatched path.
//
// Server Component on purpose: a 404 should ship zero JavaScript of its own.
export default function NotFound() {
  return (
    <main className="app-bg min-h-screen flex items-center justify-center p-6">
      <div className="relative z-10 w-full max-w-md text-center">
        <p className="panel-title">404</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">
          Page not found
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          That URL doesn&apos;t exist. It may have been a mistyped or outdated
          docs link.
        </p>
        <div className="mt-7 flex items-center justify-center gap-3 flex-wrap">
          <Link
            href="/docs"
            className="rounded-lg border border-emerald-500/30 dark:border-emerald-400/20 bg-emerald-500/20 hover:bg-emerald-500/30 px-4 py-2 text-sm font-semibold text-emerald-800 dark:text-emerald-100 transition-colors"
          >
            Docs
          </Link>
          <Link
            href="/trade"
            className="rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.06] dark:bg-white/[0.06] hover:bg-black/[0.1] dark:hover:bg-white/[0.12] px-4 py-2 text-sm font-semibold text-foreground transition-colors"
          >
            Terminal
          </Link>
          <Link
            href="/"
            className="rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.06] dark:bg-white/[0.06] hover:bg-black/[0.1] dark:hover:bg-white/[0.12] px-4 py-2 text-sm font-semibold text-foreground transition-colors"
          >
            Home
          </Link>
        </div>
      </div>
    </main>
  );
}
