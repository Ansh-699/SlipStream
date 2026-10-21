import type { ChainSnapshot } from "./chain-read";
import { truncateAddress } from "./fig-two-answers";

/** SETTLED is ~96% of the true range; a linear axis would be one bar and a sliver. */
const STUB = 18;
const GLYPH = 2;
const SPAN = 100 - STUB;

/** pathLength=1 lets one dasharray drive every segment; reduced motion restores
 *  the finished state, not the pre-draw one. */
const CSS = `
.f1-draw{stroke-dasharray:1;stroke-dashoffset:1;animation:f1-draw 460ms cubic-bezier(.2,0,0,1) forwards}
@keyframes f1-draw{to{stroke-dashoffset:0}}
.f1-cap>*{transition:opacity 120ms linear}
.f1-cap>*+*{position:absolute;inset:0;opacity:0}
.f1-fig:has([data-seg]:hover) .f1-cap>*:first-child{opacity:0}
.f1-fig:has([data-seg="1"]:hover) [data-m="1"],
.f1-fig:has([data-seg="2"]:hover) [data-m="2"],
.f1-fig:has([data-seg="3"]:hover) [data-m="3"],
.f1-fig:has([data-seg="4"]:hover) [data-m="4"]{opacity:1}
@media(prefers-reduced-motion:reduce){
.f1-draw{animation:none;stroke-dashoffset:0}
.f1-cap>*{transition:none}}
`;

const L6 =
  "font-mono text-[11px] font-medium leading-[1.4] tracking-[0.08em] text-[var(--t-text-3)]";
const NUMERAL =
  "tnum absolute top-0 font-mono text-[40px] md:text-[72px] font-medium leading-none tracking-[-0.01em] md:tracking-[-0.02em] text-[var(--t-text)]";

const n = (v: number) => v.toLocaleString("en-US");

export interface FigSequenceProps {
  snapshot: ChainSnapshot | null;
  /** From the caller's guarded manifest import; null drops the caption clause, not the figure. */
  orderBook?: string | null;
  market?: string | null;
}

interface Seg {
  id: 1 | 2 | 3 | 4;
  left: number;
  width: number;
  label: string;
  method: string;
}

export function FigSequence({ snapshot, orderBook = null, market = null }: FigSequenceProps) {
  const u = snapshot?.unrecoverable;
  const gap = u?.kind === "measured" ? u.fills : 0;
  const total = snapshot ? gap + snapshot.ringCount + 1 : 3;
  const x2 = snapshot ? STUB + (SPAN * gap) / total : STUB + SPAN / 3;
  const x3 = snapshot ? x2 + (SPAN * snapshot.ringCount) / total : STUB + (SPAN * 2) / 3;

  const segs: Seg[] = [];
  if (snapshot) {
    const headTail =
      snapshot.ringCount === snapshot.ringMax && snapshot.ringHead === snapshot.ringTail;
    segs.push({
      id: 1,
      left: 0,
      width: STUB,
      label: "SETTLED (L1)",
      method: `SETTLED · LASTSETTLEDSEQUENCE U32LE@2058 · L1 · 0 → ${n(snapshot.settled)}`,
    });
    if (u?.kind === "measured") {
      segs.push({
        id: 2,
        left: STUB,
        width: x2 - STUB,
        label: `UNRECOVERABLE · ${n(u.fills)} fills · ${n(u.from)} → ${n(u.to)}`,
        method: `UNRECOVERABLE · NEXTFILLSEQUENCE − FILLEVENTCOUNT − 1 − LASTSETTLEDSEQUENCE · ${n(u.from)} → ${n(u.to)} · ${n(u.fills)} FILLS`,
      });
    }
    segs.push({
      id: 3,
      left: x2,
      width: x3 - x2,
      label: `IN RING (ER) · ${n(snapshot.ringCount)} / ${n(snapshot.ringMax)}${headTail ? " · head == tail" : ""}`,
      method: `IN RING · FILLEVENTCOUNT U16LE@24 OF MAXFILLEVENTS U16LE@12 · ER · ${n(snapshot.oldestSurviving)} → ${n(snapshot.nextFill - 1)}`,
    });
    segs.push({
      id: 4,
      left: x3,
      width: 100 - x3,
      label: "NEXT",
      method: `NEXT · NEXTFILLSEQUENCE U64LE@40 · ER · ${n(snapshot.nextFill)}`,
    });
  }

  const derivation = snapshot
    ? [
        orderBook ? `ORDER BOOK ${truncateAddress(orderBook)} · SLICE[0,48]` : null,
        "MAXFILLEVENTS U16LE@12",
        "FILLEVENTHEAD U16LE@20",
        "FILLEVENTTAIL U16LE@22",
        "FILLEVENTCOUNT U16LE@24",
        "NEXTFILLSEQUENCE U64LE@40",
        market ? `MARKET ${truncateAddress(market)}` : null,
        "LASTSETTLEDSEQUENCE U32LE@2058",
        `SLOT ${n(snapshot.slot)}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "NO READ";

  // Zero is two facts — nothing was overwritten, or the cursor outran the
  // evidence — and neither may render as a clean axis.
  let state: string | null = null;
  if (snapshot && u?.kind === "ring-not-full") {
    state = `SEGMENT 2 NOT DRAWN · FILLEVENTCOUNT ${n(snapshot.ringCount)} < MAXFILLEVENTS ${n(snapshot.ringMax)}, SO NO ENTRY HAS BEEN OVERWRITTEN`;
  } else if (snapshot && u?.kind === "cursor-past-gap") {
    state = `SEGMENT 2 NOT DRAWN · RING FULL AT ${n(snapshot.ringMax)} WITH HEAD == TAIL, SO ENTRIES WERE OVERWRITTEN · THE CURSOR AT ${n(snapshot.settled)} IS ALREADY PAST THE OLDEST SURVIVING ENTRY ${n(snapshot.oldestSurviving)}, SO THIS DERIVATION CANNOT SIZE THE LOSS`;
  }

  const dashed = !snapshot;

  return (
    <figure className="f1-fig w-full px-5 sm:px-6 lg:px-10">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <div className="overflow-x-auto">
        <div className="relative min-w-[560px] md:min-w-[880px]">
          <div className="relative h-[40px] md:h-[72px]">
            {snapshot ? (
              <>
                <span className={NUMERAL} style={{ left: 0 }}>
                  {n(snapshot.settled)}
                </span>
                {u?.kind === "measured" ? (
                  <span className={NUMERAL} style={{ left: `${x2}%` }}>
                    {n(snapshot.oldestSurviving)}
                  </span>
                ) : null}
                <span className={NUMERAL} style={{ right: 0 }}>
                  {n(snapshot.nextFill)}
                </span>
              </>
            ) : (
              <>
                <span className={NUMERAL} style={{ left: 0 }}>
                  —
                </span>
                <span className={NUMERAL} style={{ right: 0 }}>
                  —
                </span>
              </>
            )}
          </div>

          <svg className="mt-3 block w-full" height="64" aria-hidden="true" focusable="false">
            <line
              x1="0.5"
              y1="14"
              x2="0.5"
              y2="50"
              strokeWidth="1"
              className="stroke-[var(--t-border-strong)]"
            />
            <line
              x1="0"
              y1="32"
              x2={`${STUB - GLYPH}%`}
              y2="32"
              strokeWidth="10"
              pathLength={1}
              strokeDasharray={dashed ? "7 5" : undefined}
              className={
                dashed ? "stroke-[var(--t-border-strong)]" : "f1-draw stroke-[var(--t-up)]"
              }
            />
            <line
              x1={`${STUB - GLYPH}%`}
              y1="52"
              x2={`${STUB - GLYPH / 2}%`}
              y2="12"
              strokeWidth="1.5"
              className="stroke-[var(--t-border-strong)]"
            />
            <line
              x1={`${STUB - GLYPH / 2}%`}
              y1="52"
              x2={`${STUB}%`}
              y2="12"
              strokeWidth="1.5"
              className="stroke-[var(--t-border-strong)]"
            />

            {/* currentColor, never a hex: an SVG paint attribute is off the
                light-mode remap list. */}
            <g className="text-[var(--t-down)]">
              <defs>
                <pattern
                  id="fig1-hatch"
                  width="6"
                  height="6"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="1" />
                </pattern>
              </defs>
              {u?.kind === "measured" ? (
                <>
                  <rect
                    x={`${STUB}%`}
                    y="20"
                    width={`${x2 - STUB}%`}
                    height="24"
                    fill="url(#fig1-hatch)"
                    stroke="currentColor"
                    strokeWidth="1"
                    pathLength={1}
                    className="f1-draw"
                  />
                  <line
                    x1={`${STUB}%`}
                    y1="14"
                    x2={`${STUB}%`}
                    y2="50"
                    strokeWidth="1"
                    stroke="currentColor"
                  />
                  <line
                    x1={`${x2}%`}
                    y1="14"
                    x2={`${x2}%`}
                    y2="50"
                    strokeWidth="1"
                    stroke="currentColor"
                  />
                </>
              ) : null}
            </g>

            <line
              x1={`${x2}%`}
              y1="32"
              x2={`${x3}%`}
              y2="32"
              strokeWidth="10"
              pathLength={1}
              strokeDasharray={dashed || u?.kind !== "measured" ? "7 5" : undefined}
              className={
                dashed
                  ? "stroke-[var(--t-border-strong)]"
                  : u?.kind === "measured"
                    ? "f1-draw stroke-[var(--t-text-2)]"
                    : "stroke-[var(--t-text-2)]"
              }
            />
            <line
              x1={`${x3}%`}
              y1="14"
              x2={`${x3}%`}
              y2="50"
              strokeWidth="1"
              className="stroke-[var(--t-border-strong)]"
            />
          </svg>

          <div className="relative mt-2 h-4">
            {(segs.length
              ? segs
              : [
                  { id: 1 as const, left: 0, label: "SETTLED (L1)" },
                  { id: 2 as const, left: STUB, label: "UNRECOVERABLE" },
                  { id: 3 as const, left: x2, label: "IN RING (ER)" },
                  { id: 4 as const, left: x3, label: "NEXT" },
                ]
            ).map((s) => (
              <span
                key={s.id}
                className={`absolute top-0 whitespace-nowrap ${L6} ${
                  !snapshot
                    ? ""
                    : s.id === 1
                      ? "text-[var(--t-up)]"
                    : s.id === 2 && snapshot
                      ? "text-[var(--t-down)]"
                      : s.id === 3 && snapshot
                        ? "text-[var(--t-text-2)]"
                        : ""
                }`}
                style={s.id === 4 ? { right: 0 } : { left: `${s.left}%` }}
              >
                {s.label}
              </span>
            ))}
          </div>

          {segs.length ? (
            <div className="absolute inset-0 z-10">
              {segs.map((s) => (
                <div
                  key={s.id}
                  data-seg={s.id}
                  className="absolute inset-y-0"
                  style={s.id === 4 ? { right: 0, width: 24 } : { left: `${s.left}%`, width: `${s.width}%` }}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <figcaption className="mt-5 max-w-[78ch]">
        <div className={`f1-cap relative ${L6}`}>
          <p>{derivation}</p>
          {segs.map((s) => (
            <p key={s.id} data-m={s.id}>
              {s.method}
            </p>
          ))}
        </div>
        <p className={`mt-2 ${L6}`}>AXIS BROKEN AFTER SETTLED · SEGMENTS 2–4 TO SCALE</p>
        <p className={`mt-1 ${L6}`}>
          {state ??
            "THIS FIGURE MEASURES THE SETTLEMENT CURSOR AGAINST THE OLDEST SURVIVING RING ENTRY · IT CANNOT SEE LOSS THE CURSOR HAS ALREADY STEPPED OVER"}
        </p>
        {snapshot ? (
          <p className="mt-5 max-w-[56ch] font-[family-name:var(--font-ui)] text-[15px] leading-[1.65] text-[var(--t-text-2)]">
            The condition is diagnosed:{" "}
            <span className="font-mono text-[13px]">push_fill_event</span> returns FillQueueFull
            rather than overwrite an entry the mirror has not taken and{" "}
            <span className="font-mono text-[13px]">mirror_fills</span> refuses once the ring&rsquo;s
            oldest surviving sequence has passed the last mirrored one, and neither guard is running
            here because the deployed bytecode is older than both.
          </p>
        ) : null}
      </figcaption>
    </figure>
  );
}
