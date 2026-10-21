---
name: Slipstream
description: A perps CLOB terminal read like a glass cockpit — dark canvas, rim-lit glass instruments, emerald as signal.
colors:
  emerald-signal: "#10b981"
  emerald-lift: "#34d399"
  teal-partner: "#2dd4bf"
  amber-pending: "#fbbf24"
  rose-negative: "#fb7185"
  rose-ask: "#f43f5e"
  canvas-horizon: "#060a09"
  canvas-deep: "#020303"
  canvas-void: "#000000"
  glass-panel-top: "rgba(26, 36, 33, 0.62)"
  glass-panel-base: "rgba(9, 13, 12, 0.74)"
  ink-primary: "oklch(0.985 0 0)"
  ink-muted: "oklch(0.708 0 0)"
  rim-light: "rgba(255, 255, 255, 0.07)"
  ink-primary-light: "rgba(15, 23, 23, 0.95)"
  canvas-light: "oklch(0.98 0 0)"
typography:
  display:
    fontFamily: "Poppins, ui-sans-serif, system-ui, sans-serif"
    fontSize: "3.05rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Poppins, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.9rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Poppins, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Poppins, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: "Poppins, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.7rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.12em"
  numeric:
    fontFamily: "Poppins, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.3
    fontFeature: "\"tnum\" 1, \"ss01\" 1"
  mono:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
  panel: "18px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  section: "40px"
components:
  button-primary:
    backgroundColor: "{colors.emerald-signal}"
    textColor: "#04140e"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
    typography: "{typography.title}"
  button-primary-hover:
    backgroundColor: "{colors.emerald-lift}"
    textColor: "#04140e"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "rgba(255, 255, 255, 0.06)"
    textColor: "{colors.ink-primary}"
  panel:
    backgroundColor: "{colors.glass-panel-base}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.panel}"
    padding: "12px 14px"
  panel-title:
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
  input-field:
    backgroundColor: "rgba(255, 255, 255, 0.04)"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
    typography: "{typography.numeric}"
---

# Design System: Slipstream

## Overview

**Creative North Star: "The Instrument Panel"**

Slipstream is read the way a glass cockpit is read at night. The canvas is not styled darkness for fashion; it is an unlit cabin, so the only bright things in the field of view are the readings that matter. Panels are instruments: rim-lit glass housings floating over an aurora that suggests the world outside the canopy. Nothing on the surface is inert decoration — a glow means a system is live, a colour means a direction, a number that moves means a market moved.

The consequence is a discipline, not a mood. Density is high because instruments are read in a single sweep, not scrolled. Numbers use tabular figures so a column of prices reads as a ruler rather than as ragged text. Motion exists only to restate a change the eye could already have caught, which is why `prefers-reduced-motion: reduce` deletes it outright instead of shortening it: a shortened animation still moves, and movement is the thing being opted out of.

The anti-reference is the consumer finance app — oversized friendly headings, illustrated mascots, gradient buttons that promise rather than report, and crypto maximalism in the copy. Slipstream is calm under motion. Its confidence comes from precision, not from volume. Light mode exists as an opt-in remap for daylight and printing; every design decision is made in the dark first.

**Key Characteristics:**

- Dark-first canvas (`#060a09` → `#000000`) with an emerald/teal aurora, never a flat black
- Liquid-glass panels at 18px radius: specular sheen, rim light, saturated blur
- Emerald as load-bearing signal, never as decoration
- Tabular figures on every price, size, and balance
- Uppercase micro-labels at `0.12em` tracking as the only ornamental typography
- Motion is decorative-only and fully removable

## Colors

A near-black cabin lit by one emerald signal, with amber and rose reserved so strictly that seeing them is itself information.

### Primary

- **Emerald Signal** (`#10b981`): The one accent. Primary CTAs, live indicators, bids, gains, the focus ring, the caret, the top hairline on every panel, and the scrollbar thumb on hover. Its meaning is fixed: *working, or up*.
- **Emerald Lift** (`#34d399`): The upward value flash and primary-button hover only. It is Emerald Signal caught mid-motion, not a second accent.

### Secondary

- **Teal Partner** (`#2dd4bf`): The gradient partner to emerald in the aurora and in brand gradients. It never appears alone, never labels state, and never carries a number.

### Tertiary

- **Amber Pending** (`#fbbf24`, with amber-500 for fills): *Waiting or blocked* — committed margin, unmet preconditions, in-flight settlement. Amber is a request for patience, never an error.
- **Rose Negative** (`#fb7185`, with `#f43f5e` for ask depth): *Failed or down* — errors, asks, losses, liquidation risk.

### Neutral

- **Canvas Horizon → Void** (`#060a09` → `#020303` → `#000000`, vertical): The page ground. The gradient is what keeps the aurora legible; a flat black flattens the glass with it.
- **Glass Panel** (`rgba(26,36,33,0.62)` → `rgba(9,13,12,0.74)`): The panel body. Always translucent — the aurora must bleed through tinted, not grey.
- **Rim Light** (`rgba(255,255,255,0.07)` border, `rgba(255,255,255,0.10)` inset top): The bevel that separates glass from a flat translucent card.
- **Ink Primary** (`oklch(0.985 0 0)`) and **Ink Muted** (`oklch(0.708 0 0)`): Body copy and secondary/label copy. Opacity-stepped whites (`/80`, `/60`, `/45`) carry the intermediate ranks.
- **Ink Primary Light** (`rgba(15,23,23,0.95)`): The light-mode remap of every white text step.

### Named Rules

**The Load-Bearing Colour Rule.** Emerald, amber and rose are vocabulary, not palette. Emerald means working or up, amber means waiting or blocked, rose means failed or down. If a colour is being used because the element looked plain, it is the wrong colour — reach for a rim light, a rank of white, or spacing instead.

**The Never Colour-Only Rule.** Colour already carries state, so live-updating values must also signal direction with a sign, an arrow, or position. A red number and a green number must still be distinguishable in greyscale.

**The Aurora Stays Behind Rule.** The emerald/teal radial glow is fixed to the page background (`background-attachment: fixed`) at ≤0.16 alpha. It never enters a panel, never sits behind a number, and never animates.

## Typography

**Display / Body Font:** Poppins (`--font-sans`, with `ui-sans-serif, system-ui` fallback)
**Label/Mono Font:** Geist Mono (`--font-geist-mono`) for code, hashes, and addresses

**Character:** One geometric sans doing all the work, tightened hard at display sizes (`-0.035em`) so headlines read as engineered rather than friendly, and left at normal tracking for body so prose stays readable. The system's typographic personality lives almost entirely in two places: the negative tracking on headlines and the wide uppercase micro-label.

### Hierarchy

- **Display** (600, `3.05rem`, `1.1`, `-0.035em`): The landing hero claim. One per page, never on an operating surface.
- **Headline** (600, `1.9rem`, `-0.03em`): Section openers on marketing and docs surfaces.
- **Title** (600, `0.9375rem`): Panel-internal headings, dialog titles, row group headings.
- **Body** (400, `0.875rem`, `1.6`): Explanatory copy. Docs prose runs `0.95rem/1.7` capped at `46rem` (~70ch).
- **Label** (600, `0.7rem`, `0.12em`, uppercase): Panel headers and column headers. This is the only uppercase in the system.
- **Numeric** (500, `0.8125rem`, tabular): Every price, size, balance, and percentage.

### Named Rules

**The Tabular Figures Rule.** Any number that can change while the user is looking at it carries `.tnum`. Digits must not jitter as values stream; a column of prices is an instrument scale, and a scale that shifts is broken.

**The One Uppercase Rule.** Uppercase is reserved for the `0.7rem` micro-label. Buttons, headings, and body copy are never uppercased — the moment uppercase spreads, the labels stop reading as instrument nomenclature.

## Layout

A viewport-locked terminal on operating surfaces and a centred single-column narrative on reading and marketing surfaces. The trading surface is a three-column composition — order book, chart/positions, order form — where each column owns its own scroll (`.slim-scroll`) so no control is ever pushed out of reach; the page itself does not scroll. Panels are separated by 8–12px gutters, not by whitespace: the gaps are seams between instruments, not breathing room.

Rhythm runs on a 4px base (`4 / 8 / 12 / 16 / 24 / 40`). Panel padding is `12px 14px` on data panels and up to `24px` on marketing panels. Row height in dense tables is 20–24px with `0.8125rem` numerics.

Below `lg`, the three columns stack in trading-priority order (form → book → chart) and the viewport lock is released so the page scrolls normally. Marketing and docs surfaces are max-width constrained (`46rem` prose, `72rem` sections) and centred at every width.

## Elevation & Depth

Hybrid, and the hybrid is the signature. Depth comes first from **translucency and blur** — panels sit over a fixed aurora, so a panel's ground changes with its position on the page — and second from a **rim-light bevel**: bright inset edge on the top and sides, darkened along the bottom. That bevel is the entire difference between "glass" and "flat translucent card". Drop shadows exist but are ambient, never structural: they place the panel above the canvas and do nothing else.

### Shadow Vocabulary

- **Panel rest** (`inset 0 1px 0 rgba(255,255,255,0.1), inset 1px 0 0 rgba(255,255,255,0.04), inset -1px 0 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.28), 0 14px 44px rgba(0,0,0,0.46)`): Every `.panel` and `.panel-bar`.
- **Glass surface** (`inset 0 1px 0 rgba(255,255,255,0.06), inset 0 0 0 1px rgba(16,185,129,0.10), 0 12px 44px rgba(0,0,0,0.6)`): Lighter overlay chrome — menus, floating bars.
- **Emerald glow** (`0 0 0 1px rgba(16,185,129,0.35), 0 8px 30px rgba(16,185,129,0.28)`): Primary CTAs only. It is the one place a shadow carries meaning.

### Named Rules

**The Blur Stays Saturated Rule.** Every backdrop-filter pairs `blur(20–22px)` with `saturate(130–150%)`. Blur alone greys the aurora out and the glass dies; saturation is what keeps the light behind the panel coloured.

**The Sheen Is A Background Rule.** The specular highlight is a background layer, never a pseudo-element overlay. A `::before` sheen paints over live numbers, and no decoration is allowed in front of a reading.

## Shapes

Soft-rectangular throughout. Panels are `18px` — noticeably rounder than the controls inside them, which is what makes a panel read as a housing rather than as a bigger control. Controls step down: `0.625rem` (`lg`) for buttons and inputs, `0.5rem` (`md`) for compact and grouped controls, `0.375rem` for chips and inline tags. Only status dots, avatars, and the scrollbar thumb are fully round (`9999px`).

Borders are hairlines at low alpha (`rgba(255,255,255,0.05–0.10)` dark, `rgba(15,23,23,0.07–0.14)` light) and always paired with an inset highlight; a border alone reads as a wireframe. Panels clip their content (`overflow: hidden`); bars that host popovers use `.panel-bar`, the identical surface without clipping.

The recurring silhouette is a hairline-bordered translucent rectangle with a single emerald gradient hairline across its top edge — the panel's "power on" indicator, present on every `.panel`.

## Components

### Buttons

- **Shape:** Gently curved (`0.625rem`; `0.5rem` on `xs`/`sm` sizes), height-driven — `32px` default, `28px` sm, `24px` xs, `36px` lg.
- **Primary:** Emerald Signal fill with near-black text, `text-sm/500`, paired with the emerald glow shadow on hero CTAs.
- **Hover / Focus:** Hover lifts to Emerald Lift; press translates `1px` down (`active:translate-y-px`); focus-visible draws a `2px` emerald outline at `2px` offset. Transitions run at 100ms.
- **Ghost / Outline:** Ghost fills `rgba(255,255,255,0.06)` on hover only. Outline carries a hairline border over `bg-input/30`. Destructive is a tinted rose surface (`destructive/10`), never a solid red fill — a solid red button reads as the primary action.

### Cards / Containers

- **Corner Style:** `18px` (`.panel`, `.panel-bar`).
- **Background:** Radial sheen top-left over a vertical glass gradient; light mode swaps to white translucency.
- **Shadow Strategy:** Panel rest, always. Panels do not change elevation on hover — instruments do not lift.
- **Border:** `1px` rim light, plus the emerald gradient hairline on the top edge at 0.7 opacity.
- **Internal Padding:** `12px 14px` dense, `16–24px` on marketing surfaces.

### Inputs / Fields

- **Style:** `rgba(255,255,255,0.04)` fill, hairline border, `0.5rem` radius, `32px` height, tabular numerics for anything numeric.
- **Focus:** Emerald outline (`2px`, `0.75` alpha) at `2px` offset; caret is Emerald Signal.
- **Error / Disabled:** Error borders and rings use destructive at low alpha with a text message beside the field. Disabled drops to `0.5` opacity and removes pointer events. Native number spinners are removed — users type, or use quick-pick chips and the leverage slider.

### Navigation

Hairline-separated glass bar (`.panel-bar`) with `text-sm` links at `rgba(255,255,255,0.7)`, rising to full white on hover with a 100ms transition. The active route is marked by full-white text plus an emerald underline hairline, never by a filled pill. On mobile the bar collapses to logo + primary action; secondary links move into a sheet.

### Live Indicators (signature)

- **Live dot:** `7px` emerald circle with a 2s expanding `pulse-ring` box-shadow. It means a stream is connected — never used as a bullet.
- **Value flash:** `.flash-up` (`#34d399`) / `.flash-down` (`#fb7185`) animate colour for 600ms and return to `inherit`. A colour is never left stuck on a number.
- **Depth bars:** Horizontal gradient fills behind order-book rows — `rgba(16,185,129,0.14)` for bids, `rgba(244,63,94,0.13)` for asks — drawn behind the text, never over it.

## Do's and Don'ts

### Do:

- **Do** put every price, size, balance, and percentage in `.tnum`.
- **Do** keep panels translucent and blurred at `saturate(130–150%)` so the aurora reads through tinted.
- **Do** reserve emerald for *working or up*, amber for *waiting or blocked*, rose for *failed or down*.
- **Do** pair every colour-coded value with a non-colour cue (sign, arrow, or position).
- **Do** name the step in progress in UI copy ("Returning funds from the rollup…"), and name the next action in errors ("Cancel your 2 open orders before withdrawing.").
- **Do** design dark first and treat light mode as a remap of the same structure.
- **Do** keep decorative motion fully removable under `prefers-reduced-motion: reduce`.

### Don't:

- **Don't** use emerald as decoration — a green rule, a green divider, or a green icon with no state meaning breaks the signal vocabulary.
- **Don't** put a `feTurbulence`/`feDisplacementMap` refraction on a data panel. Deep distortion is reserved for marketing and hero surfaces; refracting live numbers costs legibility for no informational gain.
- **Don't** overlay a sheen, gradient, or glow in front of a live value.
- **Don't** uppercase anything except the `0.7rem` micro-label.
- **Don't** introduce a new hue or a second typeface; the system is one sans, one mono, one accent plus two state colours.
- **Don't** write crypto maximalism ("blazing fast", "revolutionary") or conceal mechanics the user is responsible for.
- **Don't** flatten the canvas to solid black or drop the aurora — the glass has nothing to refract without it.
