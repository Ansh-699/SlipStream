import type { ChainSnapshot } from "./chain-read";
import { CopyButton } from "./copy-button";
import { truncateAddress } from "./fig-two-answers";

const LABEL = "font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--t-text-3)]";
const VALUE = "tnum font-mono text-[13px] leading-[1.45] text-[var(--t-text)]";
const METHOD = "font-mono text-[11px] leading-[1.4] text-[var(--t-text-3)]";
const ROW =
  "grid gap-x-4 gap-y-1 border-b border-[var(--t-border)] py-3 sm:grid-cols-[132px_1fr]";

interface LinkRow {
  label: string;
  value: string;
  href: string;
  head: number;
  tail: number;
}

const SOL = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export async function Verify({ snapshot }: { snapshot: ChainSnapshot | null }) {
  let links: LinkRow[] = [];
  let upgradeLinked = false;
  try {
    // @/lib/manifest throws at evaluation when deploy.json is absent.
    const { PROGRAM_ID, MARKET, ORDER_BOOK, explorerAddress, explorerTx } = await import(
      "@/lib/manifest"
    );
    // The signature is in the raw manifest only; manifest.ts does not re-export it.
    const generated = await import("@/lib/deploy-manifest.generated.json");
    const signature = (generated.default as { lastUpgradeSignature?: string })
      .lastUpgradeSignature;

    const program = PROGRAM_ID.toBase58();
    const market = MARKET.toBase58();
    const book = ORDER_BOOK.toBase58();
    links = [
      { label: "Program", value: program, href: explorerAddress(program, "base"), head: 8, tail: 5 },
      { label: "Market", value: market, href: explorerAddress(market, "base"), head: 8, tail: 5 },
      // The book is delegated, so devnet's index does not hold its live state.
      { label: "Order book", value: book, href: explorerAddress(book, "er"), head: 8, tail: 5 },
      ...(signature
        ? [
            {
              label: "Last upgrade",
              value: signature,
              href: explorerTx(signature, "base"),
              head: 5,
              tail: 4,
            },
          ]
        : []),
    ];
    upgradeLinked = Boolean(signature);
  } catch {
    links = [];
  }

  if (!links.length && !snapshot) return null;

  return (
    <section>
      <h2 className={LABEL}>Fig. 3 — Verify it yourself</h2>

      <dl className="mt-4 border-t border-[var(--t-border)]">
        {links.map((r) => (
          <div key={r.label} className={ROW}>
            <dt className={`${LABEL} self-baseline`}>{r.label}</dt>
            <dd className="flex min-w-0 items-baseline gap-3">
              <span className={VALUE} title={r.value}>
                {truncateAddress(r.value, r.head, r.tail)}
              </span>
              <CopyButton value={r.value} label={r.label} />
              <a
                href={r.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${r.label} on the explorer`}
                className="font-mono text-[13px] leading-none text-[var(--t-link)] transition-opacity hover:opacity-70"
              >
                ↗
              </a>
            </dd>
          </div>
        ))}

        <div className={ROW}>
          <dt className={`${LABEL} self-baseline`}>Open interest</dt>
          <dd className="min-w-0">
            <span className={VALUE}>
              {snapshot ? `long ${SOL(snapshot.oiLong)} / short ${SOL(snapshot.oiShort)}` : "—"}
            </span>
            <span className={`mt-1 block ${METHOD}`}>market@176 / @184 u64le · BASE_SCALE 1e9</span>
          </dd>
        </div>

        <div className={ROW}>
          <dt className={`${LABEL} self-baseline`}>Max leverage</dt>
          <dd className="min-w-0">
            <span className={VALUE}>{snapshot ? `${snapshot.maxLeverage}x` : "—"}</span>
            <span className={`mt-1 block ${METHOD}`}>market@4 u8</span>
          </dd>
        </div>
      </dl>

      {upgradeLinked && (
        <p className={`mt-3 max-w-[78ch] ${METHOD}`}>
          deploy.json&rsquo;s own date field is stale; the block time behind this signature is the
          real one.
        </p>
      )}
    </section>
  );
}
