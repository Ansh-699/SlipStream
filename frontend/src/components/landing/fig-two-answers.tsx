import type { BookRead } from "./chain-read";

/** Middle-truncate a base58 address; `break-all` is forbidden on this route. */
export function truncateAddress(value: string, head = 6, tail = 5): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export interface FigTwoAnswersProps {
  /** The order-book pubkey, resolved by the caller's guarded manifest import. */
  address: string;
  l1: BookRead | null;
  er: BookRead;
  l1Slot: number;
  slot: number;
}

interface DiffRow {
  name: string;
  l1: string | null;
  er: string | null;
  l1Title?: string;
  erTitle?: string;
  same: boolean | null;
}

function diff<T extends string | number>(
  name: string,
  l1: T | null | undefined,
  er: T | null | undefined,
  show: (v: T) => string,
  titled = false
): DiffRow | null {
  // A row neither endpoint can cite is deleted, not balanced.
  if (l1 == null && er == null) return null;
  return {
    name,
    l1: l1 == null ? null : show(l1),
    er: er == null ? null : show(er),
    l1Title: l1 != null && titled ? String(l1) : undefined,
    erTitle: er != null && titled ? String(er) : undefined,
    same: l1 == null || er == null ? null : l1 === er,
  };
}

const num = (v: number) => v.toLocaleString("en-US");
const sol = (v: number) => `${(v / 1e9).toFixed(3)} SOL`;

const HEAD = "px-0 pb-2 text-left font-normal text-[11px] font-mono text-[var(--t-text-3)]";
const VALUE = "tnum py-2 pl-4 text-right align-baseline text-[var(--t-text)]";

export function FigTwoAnswers({ address, l1, er, l1Slot, slot }: FigTwoAnswersProps) {
  const rows = [
    diff("owner", l1?.owner, er.owner, (v: string) => truncateAddress(v), true),
    diff("next_fill_sequence", l1?.nextFill, er.nextFill, num),
    diff("active_order_count", l1?.activeOrders, er.activeOrders, num),
    diff("data size", l1?.size, er.size, num),
    diff("rent", l1?.lamports, er.lamports, sol),
  ].filter((r): r is DiffRow => r !== null);

  return (
    <figure className="m-0">
      <div className="text-[11px] font-mono font-medium tracking-[0.08em] text-[var(--t-text-3)]">
        FIG. 2 — ONE ACCOUNT, TWO ANSWERS
      </div>

      <div
        title={address}
        className="tnum mt-4 border-b border-[var(--t-border)] pb-3 text-[13px] font-mono text-[var(--t-text)]"
      >
        <span className="hidden sm:inline">{address}</span>
        <span className="sm:hidden">{truncateAddress(address, 8, 8)}</span>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[340px] border-collapse text-[13px] font-mono">
          <thead>
            <tr>
              <th className={`${HEAD} w-full`} />
              {/* The configured upstreams can carry keys; these are the public endpoints. */}
              <th className={`${HEAD} pl-4 text-right`} scope="col">
                l1 · api.devnet.solana.com
              </th>
              <th className={HEAD} />
              <th className={`${HEAD} pl-4 text-right`} scope="col">
                er · devnet.magicblock.app
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-[var(--t-border)]">
                <th
                  scope="row"
                  className="py-2 pr-4 text-left align-baseline font-normal text-[var(--t-text-3)]"
                >
                  {r.name}
                </th>
                <td className={VALUE} title={r.l1Title}>
                  {r.l1 ?? "—"}
                </td>
                <td
                  aria-hidden="true"
                  className="w-8 border-l border-[var(--t-border)] py-2 text-center align-baseline text-[var(--t-border-strong)]"
                >
                  {r.same === null ? "" : r.same ? "=" : "≠"}
                </td>
                <td className={VALUE} title={r.erTitle}>
                  {r.er ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <figcaption className="mt-6">
        {l1 === null && (
          <p className="max-w-[56ch] text-[15px] leading-[1.65] font-[family-name:var(--font-ui)] text-[var(--t-text-2)]">
            L1 did not answer this read.
          </p>
        )}
        <p className="mt-3 max-w-[56ch] text-[15px] leading-[1.65] font-[family-name:var(--font-ui)] text-[var(--t-text-2)]">
          The same account, read on both endpoints. On the layer that holds your money it is owned
          by the delegation program. On the layer that matches your orders it is owned by
          Slipstream. That one field is the whole custody argument, and it is one getAccountInfo
          away from being checked.
        </p>
        <p className="tnum mt-5 max-w-[78ch] text-[11px] font-mono font-medium tracking-[0.08em] text-[var(--t-text-3)]">
          {`getAccountInfo(${truncateAddress(address)}, dataSlice{0,48}) ON EACH ENDPOINT · OWNER SHIPS IN THE ENVELOPE · L1 SLOT ${num(l1Slot)} · ER SLOT ${num(slot)}`}
        </p>
      </figcaption>
    </figure>
  );
}
