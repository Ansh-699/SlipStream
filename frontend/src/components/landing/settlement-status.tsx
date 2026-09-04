import { PUBLIC_FALLBACKS, rpcPost } from "@/lib/rpc-failover";

/**
 * The honest number: how many matched fills are still waiting on L1 settlement.
 *
 * Everything else on this page is a claim. This is the one line that reports
 * the system's actual state including when that state is bad, which is the
 * whole reason it is worth showing -- a landing page that names its own stalled
 * pipeline is making a claim a competitor's page cannot cheaply copy.
 *
 * Read server-side so no key reaches the browser, through the shared failover
 * so a spent RPC key degrades this line instead of blanking it.
 */

const UPSTREAM = process.env.BASE_RPC_UPSTREAM || PUBLIC_FALLBACKS.base;

async function readAccount(address: string, dataSlice?: { offset: number; length: number }) {
  const out = await rpcPost(UPSTREAM, PUBLIC_FALLBACKS.base, {
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [address, { encoding: "base64", ...(dataSlice ? { dataSlice } : {}) }],
  });
  const b64 = (out?.json as { result?: { value?: { data?: string[] } } })?.result?.value?.data?.[0];
  return typeof b64 === "string" ? Buffer.from(b64, "base64") : null;
}

async function readLag(): Promise<{ pending: number; settled: number } | null> {
  try {
    // Imported inside the try: @/lib/manifest THROWS on evaluation when
    // deploy.json is absent, and the landing page must not 500 because a build
    // artefact is missing.
    const { MARKET, ORDER_BOOK } = await import("@/lib/manifest");
    const { decodeMarket } = await import("@/lib/slipstream/accounts");

    const [marketBuf, bookHeader] = await Promise.all([
      readAccount(MARKET.toBase58()),
      // Header only. decodeOrderBook refuses a short buffer by design, and the
      // full account is ~626 KB -- an absurd read for one u64, on every
      // revalidation, for a line of text.
      readAccount(ORDER_BOOK.toBase58(), { offset: 0, length: 48 }),
    ]);
    if (!marketBuf || !bookHeader || bookHeader.length < 48) return null;

    const settled = decodeMarket(marketBuf).lastSettledSequence;
    // nextFillSequence is u64 LE at byte 40 (accounts.ts:475). Read here rather
    // than via decodeOrderBook for the reason above.
    const nextFill = Number(bookHeader.readBigUInt64LE(40));
    if (!Number.isFinite(nextFill) || nextFill < settled) return null;
    return { pending: nextFill - settled, settled };
  } catch {
    return null;
  }
}

export async function SettlementStatus() {
  const lag = await readLag();
  if (!lag) return null;

  return (
    <p className="mt-10 border-t border-[var(--t-border)] pt-6 text-[13px] leading-relaxed text-[var(--t-text-3)]">
      <span className="tnum font-medium text-[var(--t-text-2)]">
        {lag.pending.toLocaleString()}
      </span>{" "}
      matched fills are waiting on L1 settlement
      {lag.pending > 1000 ? (
        <>
          . The deployed program predates a fix to the fill-log drain, so the
          settlement pipeline is stalled pending a redeploy — positions stay
          pending until then. Matching, custody and the order book are unaffected.
        </>
      ) : (
        <> and will settle on the next keeper pass.</>
      )}
    </p>
  );
}

/**
 * The three addresses this page's claims rest on, linked to the explorer.
 *
 * The only element here a sceptic can actually check. It lives in this file
 * because it needs the same guarded @/lib/manifest import as the lag reader —
 * that module throws at evaluation when deploy.json is missing, so both have to
 * reach it inside a try rather than at module scope.
 */
export async function VerifyLinks() {
  let rows: { label: string; address: string; layer: "base" | "er" }[];
  let href: (a: string, l: "base" | "er") => string;
  try {
    const { PROGRAM_ID, MARKET, ORDER_BOOK, explorerAddress } = await import("@/lib/manifest");
    href = explorerAddress;
    rows = [
      { label: "Program", address: PROGRAM_ID.toBase58(), layer: "base" },
      { label: "Market", address: MARKET.toBase58(), layer: "base" },
      { label: "Order book", address: ORDER_BOOK.toBase58(), layer: "er" },
    ];
  } catch {
    return null;
  }

  return (
    <div className="mt-8">
      <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--t-text-3)]">
        Verify it yourself
      </h2>
      <ul className="mt-3 space-y-1.5">
        {rows.map((r) => (
          <li key={r.label} className="flex flex-wrap items-baseline gap-x-3 text-[13px]">
            <span className="w-[86px] shrink-0 text-[var(--t-text-3)]">{r.label}</span>
            <a
              href={href(r.address, r.layer)}
              target="_blank"
              rel="noopener noreferrer"
              className="tnum break-all text-[var(--t-link)] underline underline-offset-4"
            >
              {r.address}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
