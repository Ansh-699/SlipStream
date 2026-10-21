TITLE: FIG. 1 — the front door is an instrument reading, not a brochure.

THESIS (one line, binding on every decision below): the largest type on this page is a number read from a byte offset, the headline is half its size, and the page's focal point is the venue's own unrecoverable data loss drawn to a broken axis with its arithmetic printed underneath. Every claim carries a number, an address, or a timestamp. Nothing is asserted that cannot be re-derived by a reader with curl.

=====================================================================
0. HARD CONSTRAINTS — VIOLATION IS A BUILD FAILURE, NOT A TASTE NOTE
=====================================================================
0.1 frontend/src/app/page.tsx keeps `export const revalidate = 60` and keeps rendering a Server Component tree. Do not add `force-dynamic`. Do not fetch /api/status or /api/trades from `/`.
0.2 Every `@/lib/manifest` import stays inside a `try` in an async server component, or behind `next/dynamic(..., {ssr:false})`. That module calls resolveAddress() at module scope and THROWS when deploy.json is absent. A top-level import = a 500 on the front door in CI and on a fresh checkout. hero-price.tsx keeps `ssr:false` — it is a correctness requirement, not a perf tweak.
0.3 No wallet bundle on `/`. No WalletProvider in the root layout, no import reaching @phantom/*, no `@solana/web3.js` in any server or eagerly-hydrated component on this route.
0.4 THE COLOUR RULE. Every colour is an arbitrary-value utility over a `--t-*` token: `text-[var(--t-text-2)]`, `bg-[var(--t-up-3)]`, `border-[var(--t-border)]`. NO `text-white/*`, no bare Tailwind palette class, no gradient stop, ever. globals.css:581-713 is a fixed, finite remap list; anything off it silently keeps its dark value in light mode with no error.
0.5 ZERO NEW TOKENS. The palette below uses only names already defined on both `:root` (globals.css:1496-1529) and `.dark` (:1531-1553). Because no token is added, there are no new contrast ratios to state — the audited ratios below are the existing measured ones and they carry over unchanged. If a build agent believes it needs a new token, it has misread this brief: stop and report instead of adding one.
0.6 Every async server child returns `null` on throw, on a short buffer, and on a failed sanity gate. The front door renders when the chain does not answer.
0.7 Read each account from the layer that owns it. Market from L1. Order book header from the ER for live state. (The L1 copy of the order book is read too, but ONLY as the subject of Fig. 2 — never as a source for the settlement lag.)
0.8 Never echo raw RPC or upstream error text. BASE_RPC_UPSTREAM / ER_RPC_UPSTREAM stay server-only, never NEXT_PUBLIC_*.
0.9 Tailwind v4, CSS-first. There is no tailwind.config file. Do not create one.
0.10 Must work at 390px. Must be first-class in both themes. The blocking inline theme script in layout.tsx:64-68 stays in <head>, stays synchronous, `suppressHydrationWarning` stays on <html>.
0.11 Do NOT remove the Poppins import from layout.tsx. /trade and /docs use it. (Correction to the winning direction: dropping Poppins *usage* on `/` does not remove the woff2 from the route — next/font emits it from the layout. The wordmark moves to mono for REGISTER reasons only. No build agent may claim a bundle saving from this.)

=====================================================================
1. COMPOSITIONAL SYSTEM
=====================================================================
1.1 Container. Full-bleed page. Content grid capped at `max-w-[1512px]`, 40px page padding at >=1024px, 24px at 768-1023, 20px at <768.
1.2 Grid at >=1024px: 12 columns, 24px gutter.
    - A permanent 96px LEFT RAIL occupying column 1, with a 1px hairline in `--t-border` at x=96 running the full height of <main>, from the masthead's bottom edge to the footer's top edge. This is the spine. It is one continuous element, not a per-section border.
    - The rail carries nothing but section ordinals: `01` `02` `03` `04` `05` `06`, Geist Mono 44px, `--t-text-3`, optically aligned to each section's first text baseline. Nothing else ever goes in the rail.
    - PROSE lives in columns 2-6 (measure per role, see 1.5). MACHINE READOUTS live in columns 8-12, right-aligned, tabular mono. Two content types, two measures, two alignments, side by side. This is the structural answer to the "760px document floating in a 1440px screen" tell.
1.3 Where the grid deliberately breaks — exactly twice, and never a third time:
    - Fig. 1 is FULL BLEED, 0 to 100vw, crossing the spine. It is the widest element on the page and the only thing that ignores the rail.
    - The masthead is full bleed with a hairline bottom border.
    Every other section respects the rail and the 12-column grid. Earned asymmetry, used sparingly, or it stops meaning anything.
1.4 VERTICAL RHYTHM. Every inter-section gap is an explicit arbitrary value, chosen per section. This inverts the measured tell (designed horizontal axis, defaulted vertical axis: 24/24/36/80/40/40/32, all untouched Tailwind steps). The committed rhythm, top to bottom:
        masthead 44px tall
        → 56px  → FIG. 1
        → 104px → STATEMENT
        → 128px → FIG. 2
        → 72px  → SPEC
        → 112px → TRUST BOUNDARY      ← the most air on the page
        → 88px  → FIG. 3
        → 56px  → FOOTER
    The trust paragraph gets more room than the CTA. That is the editorial judgement, and it must be visible when you stand back from the column.
    At <768px, scale the rhythm to: 40 / 72 / 88 / 56 / 80 / 64 / 44.
1.5 MEASURE IS PER ROLE, never one container width:
        h1                 max-w-[20ch]
        lede               max-w-[54ch]
        figure prose       max-w-[56ch]
        spec bodies        max-w-[56ch]
        trust paragraph    max-w-[64ch]   ← widest prose on the page, deliberately
        method/caption     max-w-[78ch]   (mono runs long)
        readout rows       unconstrained; right-aligned to the column edge
1.6 390px. The rail collapses to a 28px gutter holding the ordinal at 18px mono. The 12-column grid collapses to one column. Readout tables become two-line rows: mono value on line 1, 11px method line on line 2. Fig. 1 rotates to a vertical axis (see 5.4). Addresses MIDDLE-TRUNCATE (`83zMFL…EnMqe`) with the full value in `title` and a copy button. `break-all` is DELETED from this route — it is what currently orphans "Py" and "e" onto their own lines. The body never scrolls horizontally; if any figure exceeds the viewport it scrolls inside its own `overflow-x:auto` container.
1.7 No rounded corners on any container, figure, box, or rule on this page. The one exception is the existing CTA button, which keeps `rounded-lg`. No card, no panel, no shadow, no blur.

=====================================================================
2. TYPE RAMP — EXACT
=====================================================================
Two families on this route. Both are already loaded.

GEIST MONO (`--font-geist-mono`) is bound SEMANTICALLY, and the rule is falsifiable: if a reader could paste it into an explorer or reproduce it with an RPC call, it is mono; otherwise it is not. That covers every sequence, address, slot, byte offset, timestamp, hostname, lamport figure, OI figure, signature, field name, and every figure caption and band label. Nothing else.

INTER (`--font-ui`) sets all prose: the h1, the lede, figure prose, spec bodies, the trust paragraph, CTA labels, the disclaimer.

POPPINS is used on this route for NOTHING. The wordmark becomes `SLIPSTREAM` in Geist Mono. (Keep the layout.tsx import — see 0.11.)

DESKTOP RAMP (>=768px):
  L1  72px / Geist Mono / 500 / line-height 1.0 / tracking -0.02em / tabular-nums
      → Fig. 1 sequence numerals ONLY. The largest type on the page is a number read from chain.
  L2  34px / Inter / 600 / line-height 1.15 / tracking -0.02em
      → h1. Deliberately less than half the numerals.
  L3  17px / Inter / 400 / line-height 1.55 / tracking 0
      → lede
  L4  15px / Inter / 400 / line-height 1.65 / tracking 0
      → figure prose, spec bodies, trust paragraph
  L5  13px / Geist Mono / 400 / line-height 1.45 / tracking 0 / tabular-nums
      → readout values, addresses, struct-diff rows
  L6  11px / Geist Mono / 500 / line-height 1.4 / tracking 0.08em / UPPERCASE / --t-text-3
      → method lines, figure captions, band labels
  Ratios 2.12 / 2.00 / 1.13 / 1.15 / 1.18. Two clean octaves at the top; the tight utility cluster at the bottom is legitimate ONLY because the family axis (mono vs Inter) separates the roles inside it. This replaces the measured 54/20/16/15/14/13/12 ramp, five of whose six steps were below the perceptual threshold.

MOBILE RAMP (<768px):
  L1 → 40px (tracking -0.01em)
  L2 → 26px
  L3 → 16px
  L4 → 15px
  L5 → 13px
  L6 → 11px

OPTICAL TRACKING IS PER ROLE. Negative tracking only at L1/L2. Positive tracking only at L6. Zero everywhere else. Never a global tracking value.

CASE IS A SEMANTIC AXIS (Teenage Engineering rule, applied literally):
  ALL-CAPS  → machine identifiers and band labels only: SLIPSTREAM, DEVNET, SOL-PERP, FIG. 1, L1, ER, SETTLED, UNRECOVERABLE, IN RING, NEXT.
  Sentence case → all prose.
  lowercase mono → endpoint hostnames and struct field names, because they are lowercase in the source: `owner`, `next_fill_sequence`, `active_order_count`, `api.devnet.solana.com`, `devnet.magicblock.app`.
  Nothing is uppercased for emphasis.

TABULAR FIGURES ARE MANDATORY on every changing number. Use the existing `.tnum` class (globals.css:254-257) or `font-variant-numeric: tabular-nums`. A digit change must never reflow a line.

=====================================================================
3. COLOUR — ROLE BY TOKEN
=====================================================================
Zero new tokens. Existing measured ratios carry over.

  --t-border         (#d5dbdf / #1d2224)  → the spine hairline, graticule ticks, table hairlines, section rules. Declared decorative; no WCAG bar.
  --t-border-strong  (#84919c / #5f696d)  → axis endpoints, segment strokes, the DEVNET box, the ≠ / = glyphs, link underline decoration. 3.23:1 light / 3.01:1 dark — already audited to WCAG 1.4.11 for non-text graphics, which is exactly what these are.
  --t-text           (#0e1417 / #e6e9ea)  → h1, readout values, wordmark. 18.57:1 measured on white.
  --t-text-2         (#46515b / #a2abb1)  → lede, figure prose, spec bodies, trust paragraph, disclaimer. 8.11:1 measured.
  --t-text-3         (#5f6a74 / #838c92)  → rail ordinals, method lines, captions, band labels, field names. 5.53:1 measured.
  --t-up             (#047857 / #22c55e)  → the SETTLED segment; live price when both gates pass. 4.8:1 light.
  --t-up-3           (#025c42 / #16794f)  → CTA fill only, with --t-on-fill ink. 8.04:1. Dark in both themes by design; do not "fix" this.
  --t-on-fill        (#ffffff / #ffffff)  → ink on the CTA only.
  --t-down           (#be123c / #ef4444)  → the UNRECOVERABLE segment stroke and its hatch; the blocked-mirror marker in Fig. 2. 6.4:1 light.
  --t-warn           (#a2490a / #f59e0b)  → ONE meaning only: a measurement that has aged past a threshold the SYSTEM defines. In practice: oracle age in 45-60s.
  --t-link           (#0369a1 / #58a6ff)  → explorer links. 5.6:1 light.

COLOUR IS NEVER THE ONLY CHANNEL. The destroyed segment is also hatched AND labelled with its count. The oracle bar also prints its age in seconds. If a reader is fully colourblind or the page is printed, no information is lost.

THE HATCH. Do not use a colour utility for it and do not use a gradient stop (a gradient stop is a `--tw-gradient-*` custom property and is structurally unremappable). Add exactly one class to globals.css, adjacent to the `--t-*` block:
    .hatch-down { background-image: repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 6px); }
and set `color: var(--t-down)` on its container. `currentColor` inherits an already-token-set colour, so it flips with the theme for free. For the SVG variant, define `<pattern>` whose lines use `stroke="currentColor"` and set `color: var(--t-down)` on the parent `<g>` — NEVER a hardcoded hex inside the SVG, or the figure quietly keeps its dark colours in light mode.

FIX THE ONE EXISTING VIOLATION. theme-toggle.tsx:36 currently ships `border-white/15 text-white/70 hover:text-white hover:bg-white/10` — four bare palette utilities that survive only because they happen to be on the remap list. Rewrite as:
    `border-[var(--t-border)] text-[var(--t-text-2)] hover:text-[var(--t-text)] hover:bg-[var(--t-surface-2)]`
After this change, nothing on `/` depends on the remap block.

=====================================================================
4. MOTION — THREE THINGS MOVE, AND EACH IS A FACT CHANGING
=====================================================================
4.1 THE ORACLE SWEEP (the only continuous motion). A 3px-tall, 180px-wide bar in the masthead. It fills left→right in proportion to the age of the last Pyth publish, against a hard 1px tick at the 60s mark — because `oracle.rs:22` sets `MAX_STALENESS_SECS: i64 = 60`, so this bar is the literal program constant that gates whether a trade can settle. `--t-up` under 45s, `--t-warn` 45-60s, `--t-down` past 60s with the fill continuing past the tick. The age prints beside it in mono: `PYTH +324s / 60s`. Implementation: `transform: scaleX()` with `transform-origin: left` on a composited layer, `linear`, re-evaluated by the price ticker's EXISTING 1s interval. No new socket, no new poll, no new timer.
4.2 FIG. 1 DRAWS ONCE. 460ms `stroke-dashoffset` across the four segments, `cubic-bezier(0.2, 0, 0, 1)`, NO stagger delay — one continuous left-to-right stroke so the eye is dragged along the axis and stops in the hatched gap. Fires on mount only. Never on scroll. Never again.
4.3 HOVER A FIG. 1 SEGMENT → the 11px caption slot swaps to that segment's own method line. Reserved height, zero layout shift, 120ms opacity crossfade. No tooltip, no popover, no card.
Everything else: hover colour and hover opacity transitions only.

`@media (prefers-reduced-motion: reduce)`:
  - the sweep renders as a static filled bar at its current age, same colour state, same numeric readout — no information lost, only the animation;
  - Fig. 1 renders complete with no dashoffset animation;
  - the caption swap becomes an instant switch.
The page must be fully legible and fully accurate with zero animation, because that is exactly what the crawler and a JS-blocked reader get.

EXPLICITLY FORBIDDEN MOTION: entrance fades, scroll-triggered reveals, staggered section arrivals, count-up numerals (actively dishonest about a live value), odometer digit rolls, hover lift, parallax, marquee, and any pulsing dot anywhere on this page.

=====================================================================
5. SECTION BY SECTION — WITH SETTLED COPY AND DATA SOURCE
=====================================================================

--- 00 · MASTHEAD (44px, full bleed, 1px bottom border in --t-border) ---
LEFT:  `SLIPSTREAM` — Geist Mono, 13px, 500, tracking 0.14em, --t-text. Links to `/`.
       Immediately right of it: `DEVNET` in a hard 1px box (`border-[var(--t-border-strong)]`, no fill, no radius, 4px 8px padding), 11px mono caps, --t-text.
       The devnet condition is PROMOTED out of 12px footer fine print into the masthead, stated the way an exchange states market hours. It is the second thing read on the page.
RIGHT: the live mark `SOL-PERP 103.76` (L5, tabular, --t-up) — em dash in --t-text-3 when either gate fails.
       Below/beside it the 180px oracle sweep with `PYTH +324s / 60s` (L6).
       Then the theme toggle (with the colour fix from §3).
       `Docs` link stays, L5, --t-text-2.
DATA: mark = existing client WebSocket, both gates unchanged. Pyth age = server-stamped publish_time, ticked client-side.
NOTE: the two numbers are labelled by SOURCE (`SOL-PERP` = ER Lazer display feed; `PYTH` = the L1 oracle the program actually gates on). They are different feeds and may differ. Labelling them is the honesty requirement; do not merge them into one number.

--- 01 · FIG. 1 — SEQUENCE STATE (full bleed, ~250px tall, crosses the spine) ---
This is the hero. There is NO headline above it. The visitor sees the machine's state before reading one word of claim.
A horizontal number line with four segments and 72px mono numerals above the boundaries:

  0 ──[SETTLED]──▸ 49,784  //  49,785 ─╱╱╱╱╱─ 52,720  ──[IN RING]── 56,816 ▏56,817 NEXT

  Segment 1 SETTLED (--t-up):        `0 → 49,784`, label `SETTLED (L1)`
  Segment 2 UNRECOVERABLE (--t-down stroke + .hatch-down fill, hard 1px stop each side):
                                     `49,785 → 52,720`, label `UNRECOVERABLE · 2,936 fills`
  Segment 3 IN RING (--t-text-2):    `52,721 → 56,816`, label `IN RING (ER) · 4,096 / 4,096 · head == tail`
  Segment 4 NEXT (--t-border-strong tick): `56,817`, label `NEXT`

BROKEN AXIS — MANDATORY AND MUST BE DISCLOSED. To true linear scale, SETTLED is ~96% of the range and the gap is 5.7%, which renders the hero as one long green bar with a sliver. So: SETTLED is a FIXED-WIDTH STUB (18% of the figure) terminated by a `//` axis-break glyph in --t-border-strong; the remaining 82% is shared proportionally by segments 2, 3 and 4. The caption states `AXIS BROKEN AFTER SETTLED · SEGMENTS 2-4 TO SCALE`. A page that breaks an axis without saying so is doing the thing this page exists to refuse.

Under the figure, one 11px mono caption line (L6), reserved height, swapped on segment hover:
  `ORDERBOOK 83zMFL…ENMQE · SLICE[0,48] · MAXFILLEVENTS U16LE@12 · FILLEVENTCOUNT U16LE@24 · NEXTFILLSEQUENCE U64LE@40 · MARKET ECUP8P…8MPY · LASTSETTLEDSEQUENCE U32LE@2058 · SLOT <context.slot>`

DERIVATION (printed, and computed at render — never hardcoded):
  oldestSurviving = nextFillSequence − fillEventCount
  unrecoverable   = max(0, oldestSurviving − 1 − lastSettledSequence)
GUARD — DO NOT SKIP: draw the hatched segment ONLY when `fillEventCount === maxFillEvents && fillEventHead === fillEventTail` (the exact measured overwrite signature). Otherwise the ring is not full, no fills have been destroyed, and segment 2 must NOT be drawn — render segment 3 as an open-ended dashed span with no count. The arithmetic must degrade to zero on its own; it must never fabricate a gap.
FAILURE: if the read fails, render the figure's frame with dashed segments and the caption `NO READ`. Never an error string, never a 500.
DATA: all of it from the single ER `getAccountInfo(ORDER_BOOK, dataSlice{0,48})` plus `lastSettledSequence` from the L1 market. Both are reads the page already makes. `context.slot` comes free in the getAccountInfo envelope and is currently discarded.

--- 02 · STATEMENT (two columns: prose cols 2-6, readout cols 8-12) ---
LEFT, h1 (L2), settled copy, two sentences:
  "A perpetual-futures order book that settles on Solana. Right now, it is not settling."
LEFT, lede (L3), settled copy:
  "Matching runs in a MagicBlock Ephemeral Rollup. Your collateral and positions stay on Solana L1, where the rollup cannot reach them. The fill log between them is where it is failing, and the number above is how far behind it is."
LEFT, CTAs — one filled, one text link, shared optical baseline, unchanged behaviour:
  `Launch the app` → /trade, `bg-[var(--t-up-3)] text-[var(--t-on-fill)]`, rounded-lg, L4 weight 600.
  `Read the docs` → /docs, L4, --t-text-2, underline `decoration-[var(--t-border-strong)]` underline-offset-4.
  Two buttons at identical weight is two primary actions, which is none. Do not add a second filled button.
RIGHT, a four-row mono readout, right-aligned tabular, 1px hairline between rows, each row carrying its 11px method line beneath:
  SETTLED        49,784   ·  `market@2058 u32le · L1`
  UNRECOVERABLE   2,936   ·  `nextFill − count − 1 − settled`
  IN RING         4,096   ·  `book@24 of book@12 · ER`
  NEXT           56,817   ·  `book@40 u64le · ER`

--- 03 · FIG. 2 — ONE ACCOUNT, TWO ANSWERS (grafted; see §6) ---
Band label (L6): `FIG. 2 — ONE ACCOUNT, TWO ANSWERS`
The order-book pubkey `83zMFL6cHjgXkQ7KRNcgtHaZ1fhyNgxhM8aMpPpEnMqe` spans the full content width as a single row — it is the same 32 bytes on both layers, so it is the only row allowed to span.
Beneath it, a struct diff: field name on the left in lowercase mono (--t-text-3), the L1 value and the ER value in two right-aligned mono columns (--t-text), with a `≠` or `=` glyph in --t-border-strong on the centre rule between them. Column headers are the endpoint hostnames, lowercase mono, --t-text-3: `l1 · api.devnet.solana.com` and `er · devnet.magicblock.app`.

  owner                DELeGG…SaeSh   ≠   7qujfsb4…XbVwz
  next_fill_sequence              10   ≠   56,817
  active_order_count              11   ≠   38
  data size                  626,736   =   626,736
  rent                     4.363 SOL   =   4.363 SOL

Figure prose beneath (L4, settled copy):
  "The same account, read on both endpoints. On the layer that holds your money it is owned by the delegation program. On the layer that matches your orders it is owned by Slipstream. That one field is the whole custody argument, and it is one getAccountInfo away from being checked."
Caption (L6): `getAccountInfo(83zMFL…, dataSlice{0,48}) ON EACH ENDPOINT · OWNER SHIPS IN THE ENVELOPE · SLOT <context.slot>`
DATA: the ER header the page already reads, plus the L1 copy of the same account, which is folded into the L1 batch (§7) at zero extra round trip. `owner` arrives in the getAccountInfo envelope regardless of dataSlice, so it costs zero extra bytes.
FAILURE: if the L1 read fails, render the ER column and an em dash in the L1 column with the line "L1 did not answer this read." — this string is CONTENT and must be reviewed as content, not left as an error placeholder.
RULE: if any row cannot cite a file or a read, DELETE the row rather than balance the figure.

--- 04 · SPEC (the hairline <dl>, kept as a <dl>, mono labels at L6, bodies at L4) ---
Keep the three-row structure and `sm:grid-cols-[128px_1fr]`. Rewrite two of the three bodies.

  MATCHING — REWRITTEN, and the "roughly 10 ms" number is DELETED, not restyled:
  "Orders place, cancel and match inside a MagicBlock Ephemeral Rollup. This repo has never measured match latency, so this page does not claim one. Fig. 2 shows the same account's fill counter on both layers instead: 10 on L1, 56,817 on the rollup."

  CUSTODY — REWRITTEN. The current copy ("Only the order book is delegated to the rollup") is FALSE: delegate_orderbook.rs, delegate_trading_credit.rs and delegate_fill_log.rs all exist, and PRODUCT.md states TradingCredit — a value-bearing, user-capped allowance — is delegated. It would also visibly contradict Fig. 2. Replace with:
  "The order book, the fill log and a user-capped TradingCredit allowance are delegated to the rollup. The vault, your free collateral and your positions are not — every path that moves them requires the owner's signature on L1."

  SIGNING — PRESERVE VERBATIM. It is verified in-program (TradingCredit::is_authorized_signer, referenced only by place_order.rs and cancel_order.rs):
  "A scoped, expiring session key signs your orders locally. No wallet popup per trade, and it can never move your funds."

--- 05 · TRUST BOUNDARY (widest measure on the page, 64ch; most air, 112px above) ---
PRESERVE VERBATIM. Not one word softened, shortened, turned into a badge, or demoted below --t-text-2. Set at L4 (15px), an increase from the current 13px, because it is the strongest paragraph on the page:
  "What the rollup can and cannot do: it orders and matches your orders, so a faulty or malicious operator could in principle reorder or delay them. It cannot move collateral, mint, or settle a position against a price it chose — those paths live in the L1 program. There are no fraud proofs, and on devnet the rollup operator is trusted."

--- 06 · FIG. 3 — VERIFY IT YOURSELF ---
Band label (L6): `FIG. 3 — VERIFY IT YOURSELF`. (The heading style is L6 mono caps, same as every other band label — the page now has ONE section-heading treatment used consistently, rather than the current 12px-uppercase pattern used twice as if it were two different ideas.)
Rows, L5 mono, address middle-truncated with full value in `title`, a copy button, and an explorer link on the CORRECT cluster via the existing `explorerAddress(address, layer)`:
  PROGRAM        7qujfsb4…XbVwz   ⧉  ↗  (?cluster=devnet)
  MARKET         ECUp8pXz…y8MPy   ⧉  ↗  (?cluster=devnet)
  ORDER BOOK     83zMFL6c…EnMqe   ⧉  ↗  (?cluster=custom&customUrl=<ER RPC>)
  LAST UPGRADE   3Utrg…jV9c       ⧉  ↗  (tx link)
Then two free rows from the market buffer already fetched in full (zero extra network), each with its method line:
  OPEN INTEREST  long 85.8 / short 1.0   ·  `market@176 / @184 u64le · BASE_SCALE 1e9`
  MAX LEVERAGE   20x                     ·  `market@4 u8`
On LAST UPGRADE, render the SIGNATURE, never `deploy.json.deployedAt` — that field says 2026-05-30 and is stale; the chain reports the last deploy at slot 484,488,785 = 2026-08-16T15:38:54Z. Caption it: `deploy.json's own date field is stale; the block time behind this signature is the real one.` A page that refuses to print a number it knows is wrong is the thesis in miniature.

--- 07 · FOOTER ---
`Slipstream · Devnet MVP` (L5, --t-text-3). Links App / Docs / GitHub (https://github.com/Ansh-699/SlipStream), unchanged.
DISCLAIMER — PRESERVE VERBATIM, at --t-text-2 (it was 11px at 2.46:1 once; that regression must not return). Bump to L4 (15px) — it is now duplicated in intent by the masthead DEVNET chip, and both must stay:
  "Devnet only. Trades use worthless test tokens. This is not production software — see the docs for the full trust model and the devnet concessions it makes."
One final mono line (L6): `READ AT SLOT <context.slot> · ISR 60s`.

=====================================================================
6. THE SIGNATURE MOVE
=====================================================================
Fig. 1: a full-bleed sequence rule, taller and louder than the headline, whose four boundaries are all derived from the ONE 48-byte header slice the page already fetches — and whose second segment is a hatched void labelled `UNRECOVERABLE · 2,936 fills`, drawn with a hard 1px stop on each side, sitting on a broken axis that says it is broken, captioned with every byte offset needed to reproduce it.

Verified in source before commissioning: `maxFillEvents` u16le@12, `activeOrderCount` u16le@14, `fillEventHead` u16le@20, `fillEventTail` u16le@22, `fillEventCount` u16le@24, `nextFillSequence` u64le@40 (accounts.ts decodeOrderBookHeader). All six live inside `dataSlice{0,48}`. The arithmetic is free.

Why this and nothing else: the hero slot on every page in this category holds decoration — a chrome torus, a particle field, a fabricated TVL counter. This one holds a measurement of the venue's own permanent data loss, with the derivation printed under it. It is the single claim on the internet that a competitor cannot cheaply copy, because copying it requires having a real pipeline and being willing to show it broken.

=====================================================================
7. DATA — EVERY NUMBER, ITS SOURCE, AND THE NETWORK BUDGET
=====================================================================
NET ROUND TRIPS STAY AT TWO. Today the page makes two. It still makes two.

CALL 1 — L1, one `getMultipleAccounts([MARKET, ORDER_BOOK, PYTH_FEED], { encoding:"base64", dataSlice:{offset:0,length:2064} })` through the existing `rpcPost()` with public fallback.
  - dataSlice length 2064 = the market's full size, so `decodeMarket` gets the complete buffer it expects. The order book and the Pyth account are both shorter than 2064 and clamp to their full length, so one slice serves all three.
  - Yields: `lastSettledSequence` (u32le@2058), open interest long/short (@176/@184), maxLeverage (@4), the L1 order-book header for Fig. 2, the L1 `owner` field (from the envelope), and Pyth `publish_time` for the oracle sweep.
CALL 2 — ER, `getAccountInfo(ORDER_BOOK, { dataSlice:{offset:0,length:48} })` — unchanged from today. Yields the whole Fig. 1 derivation plus the ER `owner` and `active_order_count` for Fig. 2.

CLIENT — the existing shared WebSocket only. Live SOL-PERP mark with BOTH existing gates intact (`connected` AND publishTime <= MAX_AGE_SECS 10) failing to an em dash, never a stale price. Plus the sweep's per-second re-evaluation on the ticker's existing interval. Still behind `ssr:false`.

STATIC BUT REAL: `lastUpgradeSignature` from the already-on-disk manifest. Program / market / order-book addresses from the manifest.

SANITY GATES THAT MUST SURVIVE: `nextFill < settled` → return null. Short buffer → return null. The `pending > 1000` threshold still gates the stalled-vs-healthy language anywhere prose describes the lag; below it the copy may say "will settle on the next keeper pass", above it it must not.

NOT USED, and the build must not add them: the depth ladder / decodeOrderBook (626,736 bytes, and the book is frozen — a 12x12 that never ticks is a lie by implication), /api/trades (structurally empty off-box, and its newest rows are ~3,000 sequences stale), /api/status (force-dynamic; would make `/` depend on it, and its keepers block reads heartbeat files that do not exist off-box), usePythCandles, useMarket, useMarkPrice, useOrderBook, StatusPanel, MarketBar.

=====================================================================
8. PRESERVE VERBATIM — DO NOT EDIT, SHORTEN, OR RESTYLE BELOW --t-text-2
=====================================================================
8.1 The trust-boundary paragraph (§05), word for word.
8.2 The devnet disclaimer (§07), word for word.
8.3 The SIGNING spec body (§04), word for word.
8.4 The price ticker's two gates and its em-dash failure. A wrong number is worse than no number.
8.5 The `pending > 1000` threshold gating settlement language.
8.6 `alt=""` on the wordmark image if any image survives, with its eslint-disable comment travelling with it. (If the wordmark becomes pure mono type per §2, the logo <img> may be dropped entirely — in which case the eslint-disable goes with it.)
8.7 `/landing` keeps redirecting to `/`.
8.8 The prebuild step (scripts/copy-manifest.mjs + copy-docs.mjs) is mandatory.

=====================================================================
9. SOURCE-COMMENT DISCIPLINE
=====================================================================
The current landing components carry 946 words of comment against 256 words of visible copy — 3.7x — written as all-caps rubric essays arguing with an absent reviewer, one of which misstates the file's own type ramp. That is the single most machine-authored artefact in the repo.

New rule for every file this brief touches: comments explain WHY a non-obvious constraint exists, in one or two lines, and nothing else. No all-caps rubric headers. No narration of what a previous version got wrong. No pre-empting objections. Total comment volume across all landing components must come in UNDER the visible page copy. The four load-bearing hazards (the manifest throw, the ssr:false requirement, the layer-ownership rule, the colour rule) get one line each. Everything else gets nothing.


=====================================================================
10. BUILD PLAN (ordered, file-scoped)
=====================================================================
1. frontend/src/components/landing/chain-read.ts (NEW). The single server-side read module. Exports one async `readChain()` returning a typed snapshot `{ settled, nextFill, ringCount, ringMax, ringHead, ringTail, l1Book:{owner,nextFill,activeOrders,size,lamports}|null, erBook:{owner,activeOrders,size,lamports}, oiLong, oiShort, maxLeverage, pythPublishTime, slot } | null`. Two calls only: L1 getMultipleAccounts([MARKET, ORDER_BOOK, PYTH_FEED], dataSlice{offset:0,length:2064}) and ER getAccountInfo(ORDER_BOOK, dataSlice{offset:0,length:48}), both through the existing rpcPost() from @/lib/rpc-failover. ALL @/lib/manifest and @/lib/slipstream/accounts imports go inside the try via `await import(...)`. Returns null on any throw, on a short buffer, and on the `nextFill < settled` gate. Never echoes upstream text. Compute `oldestSurviving` and `unrecoverable` here, applying the `ringCount === ringMax && ringHead === ringTail` guard — if the guard fails, `unrecoverable` is 0 and the caller must not draw segment 2.
2. frontend/src/app/globals.css. Add exactly one rule adjacent to the --t-* block: `.hatch-down { background-image: repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 6px); }`. Add NO tokens, change NO existing token value, touch the light-remap block at :581-713 not at all.
3. frontend/src/components/theme-toggle.tsx. Replace the four bare palette utilities at :36 with `border-[var(--t-border)] text-[var(--t-text-2)] hover:text-[var(--t-text)] hover:bg-[var(--t-surface-2)]`. One-line diff; it removes the route's last dependency on the remap block.
4. frontend/src/components/landing/fig-sequence.tsx (NEW). Pure server component taking the snapshot as props — no fetching, no imports of manifest. Renders the Fig. 1 SVG: broken axis (18% fixed SETTLED stub + `//` break glyph, remaining 82% proportional across segments 2-4), 72px mono numerals, the four segment labels, the reserved-height caption slot. Hatch via `<pattern>` with `stroke="currentColor"` and `color: var(--t-down)` on the parent `<g>` — NO hardcoded hex anywhere in the SVG. Draw-once dashoffset animation, 460ms, cubic-bezier(0.2,0,0,1), skipped under prefers-reduced-motion. Segment 2 renders only when the guard from step 1 passes.
5. frontend/src/components/landing/fig-two-answers.tsx (NEW). Pure server component, props only. The spanning pubkey row plus five diff rows with ≠ / = glyphs and hostname column headers. Renders the ER column with an em dash and the sentence "L1 did not answer this read." when `l1Book` is null. Middle-truncation helper for addresses lives here and is exported for reuse by step 7.
6. frontend/src/components/landing/oracle-sweep.tsx (NEW, 'use client'). Takes the server-stamped `pythPublishTime` as a prop and renders the 180px bar plus `PYTH +Ns / 60s`. scaleX on a composited layer, transform-origin left, linear. Reuses the price ticker's existing 1s interval pattern — do NOT open a new socket or add a second timer. Wall-clock stays in state via a lazy useState initializer, never in render scope (react-hooks/purity + the React Compiler will reject it otherwise). Static filled bar under prefers-reduced-motion.
7. frontend/src/components/landing/verify.tsx (NEW, replaces the VerifyLinks export). Fig. 3: four link rows with middle-truncation, `title` carrying the full address, a copy button, and explorerAddress(address, layer) for the cluster. Plus the two free market rows (open interest, max leverage) with method lines. Renders LAST UPGRADE as the signature, never deploy.json's deployedAt.
8. frontend/src/components/landing/hero-price.tsx + price-ticker.tsx. Styling only. Keep next/dynamic ssr:false. Keep BOTH gates and the em-dash failure. Keep the reserved fixed height so the masthead does not jump when the socket connects. Restyle to L5 mono tabular in the masthead position.
9. frontend/src/components/landing/landing-view.tsx. Rewrite as the page shell: the 12-column grid, the 96px rail with its full-height spine hairline and the 01-06 ordinals, the per-section arbitrary vertical rhythm (56/104/128/72/112/88/56), the masthead, the statement block with its two columns, the rewritten SPEC <dl> (Matching and Custody per §04; Signing verbatim), the trust paragraph verbatim at 15px, and the footer with the disclaimer verbatim at 15px. Calls readChain() once and threads the snapshot into every figure as props. Comment volume for this file: four lines maximum.
10. frontend/src/components/landing/settlement-status.tsx. DELETE. Its readLag() is absorbed by chain-read.ts and its VerifyLinks by verify.tsx. Confirm no other route imports it before removing (grep the repo, not just the landing directory).
11. VERIFY — build. Run the real build with the prebuild step (scripts/copy-manifest.mjs + copy-docs.mjs must run). Note the known environment traps: node_modules/.bin is absent so `npm run build` fails with 'next: command not found', and invoking the binary directly under the default sandbox dies with SIGBUS/135 — the build completes only with the Bash sandbox disabled. If a permission classifier refuses a command, REPORT the refusal; do not work around it. Confirm / is still ○ Static with Revalidate 1m.
12. VERIFY — the manifest-absent case, which is what the ssr:false split and the guarded imports exist for. Temporarily move src/lib/deploy-manifest.generated.json aside with no NEXT_PUBLIC_* overrides set, build, and confirm / renders HTTP 200 with figures degraded to their NO READ frames rather than 500-ing. Restore the file.
13. VERIFY — themes and viewports. Screenshot / at 390, 768, 1024 and 1440 in BOTH themes. The Fig. 1 hatch and every SVG stroke must be visually checked in light mode specifically — a hardcoded hex inside the SVG is the one failure this brief's colour rule cannot catch at code-review time. Confirm no horizontal body scroll at 390 and that addresses middle-truncate rather than break-all. Confirm the spine hairline survives at 90%, 110% and 125% zoom.
14. VERIFY — motion and bundle. Confirm with prefers-reduced-motion: reduce that the page is fully legible and every number still present. Grep the prerendered / chunks for 'phantom', 'PublicKey' and 'BN.' — must be zero hits in every chunk, same as the current baseline. Confirm the crawlable HTML now contains a real Pyth age rather than only the string 'connecting'. Run the test suite and confirm the 136 unit / 27 in-program baselines are unchanged — no test modified, renamed, weakened or ignored.

=====================================================================
11. EXPLICITLY REJECTED - do not helpfully re-add
=====================================================================
- A tinted background on one half of the page to carry L1-vs-ER identity. It needs two new surface tokens, it fails in one theme, it does not survive the 390px collapse, and it is decoration doing a job that a printed hostname does for free. Identity is carried by the hostname label and the side of the diff. Do not add a tint.
- Keeping 'roughly 10 ms' with a hedge or an attribution. Rejected outright. The repo has no benchmark, no latency harness, no p50/p99. A page that prints its own byte offsets cannot also carry one unsourced adjectival number without poisoning everything around it. If a reviewer wants a latency figure back, the answer is a measured p50 with a date and a method — not the restored adverb.
- The depth ladder / order-book visualisation. The account is 626,736 bytes and the book is currently frozen and full of stale resting orders, so a 12x12 that never ticks is a lie by implication. This was already argued in price-ticker.tsx and the argument still holds.
- /api/trades as a fill tape. Structurally empty on any frontend not co-located with the keepers (better-sqlite3 native module, walks up to <repo>/keepers/data/fills.db), and even where populated its newest rows are ~3,000 sequences stale. It becomes valuable only after the settlement redeploy, which is a human-authorised hold.
- /api/status in any form. It is force-dynamic, so consuming it makes the front door depend on a dynamic route; its keepers.fleet block reads heartbeat files that do not exist off-box; and indexer.lastFillAt is structurally null on a deployed frontend. Harvest its level thresholds if useful, never the route.
- A ticking 'server read age +41s' counter alongside the oracle sweep. Redundant — the sweep already establishes that the only number rising in real time is the staleness of the page's own measurement, and a second age counter dilutes that to noise. The read slot gets one static stamp in the footer: READ AT SLOT <n> · ISR 60s.
- Any new --t-* token. The palette below covers every role in this brief. A direction that needs a new hue to explain itself is decorating. If a build agent believes a token is missing, that is a signal to stop and report, not to add one.
- Drawing Fig. 1 to true linear scale. SETTLED would be ~96% of the axis and the destroyed gap a 5.7% sliver — the hero would read as one long green bar. The axis is broken after SETTLED and the caption says so. Equally rejected: breaking the axis silently.
- Any pulsing dot, anywhere, for any reason — including on the blocked-mirror marker in Fig. 2. A blinking error is decoration impersonating urgency, and this failure has been static for weeks. The marker sits still in --t-down and says so.
- Count-up numerals, scroll-triggered reveals, staggered section entrances, hover lift, parallax, entrance fades, and animated stat counters. All of them communicate that a library was installed. The settlement figure animating up from zero would additionally be dishonest about a live value.
- A stat band, a metrics strip, a logo wall, testimonials, a roadmap, an FAQ accordion, an 'audited by' row, a padlock icon, emoji anywhere, or a badge pill above the h1. PRODUCT.md's 'Absences future work must not fabricate' is a content floor: no users, no press, no audit, no mainnet, no volume/TVL/revenue. The only numbers permitted are ones read from chain at render.
- Glassmorphism, backdrop-blur, gradient meshes, aurora radials, floating 3D objects, particle fields, isometric UI mockups, and gradient text of any kind. Every one is a machine default; gradient text additionally cannot be remapped for light mode because a gradient stop is a custom property, not a colour utility, and that is exactly how the old wordmark measured 1.24:1.
- Three feature cards in a row, or any card at all. The SPEC block stays a hairline-ruled <dl>. A 1px rule does the same grouping work at a fraction of the visual noise, and it claims the content is reference material rather than marketing.
- Rounded corners on any container, figure, box or rule. The only radius on the page is the existing CTA's rounded-lg.
- break-all on addresses. Deleted from this route. It is what currently orphans 'Py' and 'e' onto their own lines at 390px. Middle-truncate with the full value in title, plus a copy affordance, everywhere — not just on mobile.
- Removing the Poppins import from layout.tsx to claim a bundle saving. next/font emits the face from the layout for every route; /trade and /docs use it. The wordmark moves to mono for register reasons only. No agent may state a woff2 saving from this change.
- A second filled CTA, or raising 'Read the docs' to button weight. Two buttons at identical weight is two primary actions, which is none.
- Re-adding the SettlementStatus 'healthy' branch language ('will settle on the next keeper pass') outside its pending <= 1000 gate. With the pipeline wedged that sentence is a promise the system cannot keep. The threshold stays.
- Softening, shortening, badge-ifying, or demoting the trust-boundary paragraph or the devnet disclaimer. Both are preserved verbatim and both go UP to 15px. Replacing any of it with the word 'secured' is a build failure.
- Printing deploy.json's `deployedAt` field. It says 2026-05-30; the chain says the last upgrade was slot 484,488,785 = 2026-08-16T15:38:54Z. Render the signature and let the reader click through.
- All-caps rubric comment blocks in the source ('THE REWRITE, in one line:', 'COLOUR RULE, non-negotiable:', 'TWO GATES, both required.'). The current 946 words of comment against 256 words of page copy is the most machine-authored thing in the repo. Total comment volume across the landing components must come in under the visible copy.

=====================================================================
12. ORCHESTRATOR RULINGS — these AMEND the brief above and WIN on conflict
=====================================================================

R1. BRAND RECORD MUST BE UPDATED, NOT SILENTLY CONTRADICTED.
    brand.md (status: active) says "treat this file as the source of truth" and commits the product to
    Poppins for all UI copy and to liquid-glass panels as "the signature surface". PRODUCT.md says brand.md
    "must not be contradicted". This brief drops Poppins, the panel material and the .app-bg aurora on this
    route. That decision is ACCEPTED — brand.md scopes glass to dense DATA PANELS, and this route has none;
    and the brief preserves every brand.md PRINCIPLE (emerald as load-bearing signal, tabular figures,
    uppercase micro-labels, mono for machine data, motion that only restates and is fully removable, plain
    active voice, dense/precise/calm, anti-reference = consumer finance app).
    BUT the record must stop being false. Add to brand.md a short "Route exceptions" section, and to
    DESIGN.md a matching note, recording: marketing surfaces (`/`) use Geist Mono + Inter with no panel
    material and no aurora; the reason (a measured-figure register cannot carry a decorative glow behind the
    figure); and that /trade and /docs are unchanged. Two short paragraphs. Do not rewrite either document.

R2. THE SELF-HEALING SCAR — CRITICAL, THE BRIEF'S ARITHMETIC IS UNSOUND OVER TIME.
    The brief computes  unrecoverable = max(0, oldestSurviving - 1 - lastSettledSequence).
    MEASURED FACT the brief did not have: the DEPLOYED bytecode is 2026-08-16 and predates the contiguity
    guards. Its settle_from_log advances the cursor to the batch MAXIMUM (a high-water mark), not across a
    contiguous prefix. The moment anything rotates the FillLog epoch, lastSettledSequence jumps to ~52,800,
    the subtraction goes negative, max(0,...) clamps it, and the hero silently reports ZERO loss while 2,936
    fills remain permanently unsettled. A page whose thesis is "nothing is asserted that cannot be
    re-derived" must not ship a figure that erases its own subject.
    REQUIRED: the caption must state the derivation's blind spot in one mono line - this figure measures the
    distance between the settlement cursor and the oldest surviving ring entry, and it cannot see loss the
    cursor has already stepped over. And when unrecoverable === 0, segment 2 is not drawn and the caption
    must say which of the two reasons applies (ring not full vs cursor past the gap) - never render an
    unlabelled clean axis. Solve it honestly; do not hardcode 2,936 anywhere.

R3. DIAGNOSED, NOT ABANDONED.
    "UNRECOVERABLE - 2,936 fills" as the hero is accepted: it is unforgeable and it is the thesis. But
    PRODUCT.md audience #1 is a grant reviewer in a short sitting, and loss with no disposition reads as
    incompetence rather than rigour. Add ONE sentence, in the Fig. 1 prose, that is true and checkable: the
    condition is diagnosed, the guard that prevents it exists in the repo (push_fill_event refusing when
    full; the mirror gap check), and it is not live because the deployed program is older than the fix.
    State it as a fact with its evidence, not as reassurance. No apology, no roadmap, no "coming soon".

R4. THE H1 MUST NOT HARDCODE A LIVE CONDITION.
    The brief's settled h1 is "A perpetual-futures order book that settles on Solana. Right now, it is not
    settling." The second sentence is a hardcoded claim about a value the page reads live. When settlement
    resumes, the page lies - in the largest prose on it, on the same page that deletes "roughly 10 ms" for
    being unsourced. Either derive that sentence from the snapshot, or reword it so it stays true in both
    states. The first sentence is preserved.

R5. NO NUMBER IN COPY IS HARDCODED. Every figure, count, sequence, address and timestamp renders from the
    snapshot or the manifest. If the read fails the page degrades to its NO READ frames. Grep your own diff
    for "2,936", "49,784", "56,817", "2936", "49784" before you report done.

R6. FROZEN. Do not modify, rename, weaken, delete or #[ignore] any existing test. Baselines: 136 tests/unit
    and 27 in-program. Do not deploy anything on-chain. Do not touch the keepers or the box.
    Do not edit docs/design/landing-fig1.md - it is the frozen brief.
