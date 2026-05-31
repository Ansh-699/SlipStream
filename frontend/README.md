This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## On-chain configuration (Deploy_Manifest)

The frontend resolves its on-chain addresses (program ID, SOL-PERP market, and
orderbook) from the `deploy.json` Deploy_Manifest emitted by `scripts/deploy.ts`
at the repository root (Requirement 6.2).

**Approach: build-time copy + env override.** Because `deploy.json` lives at the
repo root (two levels above this package), Next/Turbopack cannot bundle it
directly. A prebuild/predev step (`scripts/copy-manifest.mjs`, wired into the
`prebuild` and `predev` npm scripts) copies it to
`src/lib/deploy-manifest.generated.json` (gitignored), and `src/lib/manifest.ts`
exposes the resolved `PublicKey`s. Resolution order per address:

1. `NEXT_PUBLIC_*` env vars (`NEXT_PUBLIC_PROGRAM_ID`, `NEXT_PUBLIC_MARKET`,
   `NEXT_PUBLIC_ORDER_BOOK`, plus `NEXT_PUBLIC_RPC_URL` / `NEXT_PUBLIC_ER_RPC`).
2. The copied `deploy.json` values.

**Missing-manifest handling (Requirement 6.3).** If `deploy.json` is absent at
build time, the copy step writes a last-known-good fallback flagged
`__manifestPresent__: false` (so CI builds without a manifest stay green) and
`manifest.ts` exports a descriptive `manifestError`, surfaced as a visible amber
banner in the dashboard. If a required address is entirely unresolvable (no env
override and no manifest field), `manifest.ts` throws an error naming the missing
field. Invalid base58 values also throw with a descriptive message.

## Getting Started

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
