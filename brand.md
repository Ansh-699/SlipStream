# Brand — SlipStream

_Status: active_

This documents the identity the app already ships. It is written down so colour
and type decisions stop living only in `frontend/src/app/globals.css`. When
building UI, treat this file as the source of truth.

## Positioning

A perps CLOB that settles on a MagicBlock Ephemeral Rollup — the product claim
is speed you can feel. The interface should read as a professional trading
terminal, not a consumer finance app: dense, dark, precise, and calm under
motion.

## Palette

Dark is the default; light is an opt-in remap, not the primary design.

| Role | Value | Used for |
|---|---|---|
| Canvas | `#060a09` → `#020303` → `#000000` (vertical) | Page background |
| Aurora accent | `rgba(16,185,129,0.13)` / `rgba(45,212,191,0.07)` | Ambient radial glow behind the page |
| Brand / positive | `#10b981` emerald | Primary CTAs, live indicators, bids, gains |
| Secondary accent | `#2dd4bf` teal | Gradient partner to emerald, never on its own |
| Warning / pending | amber-400/500 | Committed margin, unmet preconditions |
| Negative | rose-400/500 | Errors, asks, losses |
| Surface | translucent, see "Material" | Panels |

Semantic rule: emerald means *working or up*, amber means *waiting or blocked*,
rose means *failed or down*. Never use emerald purely for decoration — it is
load-bearing signal in a trading UI.

## Material — liquid glass

Panels are the signature surface. The glass read comes from three stacked cues,
all defined on `.panel` / `.panel-bar`:

1. **Specular sheen** — a soft radial highlight in the top-left, carried as a
   background layer (not a pseudo-element, so it can never paint over content).
2. **Rim light** — bright inset edge on top and sides, darkened along the
   bottom. This bevel is what separates "glass" from "flat translucent card".
3. **Saturated blur** — `blur(22px) saturate(150%)` so the aurora behind the
   page bleeds through tinted rather than grey.

Radius is `18px` on panels. Deeper distortion — the real `feTurbulence` +
`feDisplacementMap` refraction in `LiquidGlassCard` — is reserved for marketing
and hero surfaces. It is deliberately kept off dense data panels, where
refracting live numbers costs legibility for no informational gain.

## Typography

- **Sans:** Poppins (`--font-sans`) for all UI copy.
- **Mono:** Geist Mono (`--font-geist-mono`) for code.
- **Numerics:** every price, size and balance uses `.tnum` (tabular figures) so
  digits do not jitter as values stream.
- **Panel headers:** `.panel-title` — 0.7rem, 600 weight, uppercase, `0.12em`
  tracking.

## Motion

Decorative only; all of it restates something already visible statically, so
`prefers-reduced-motion: reduce` removes it outright rather than shortening it.

| Tier | Duration | Use |
|---|---|---|
| Micro | 100ms | Hover, focus, press feedback |
| Short | 150ms | Tooltips, popovers |
| Medium | 200–250ms | Dialogs, toasts |
| Long | 400ms | Panel entrance (`.rise-in`) |

Value changes flash `.flash-up` / `.flash-down` for 600ms then return to
neutral — never leave a colour stuck on a number.

## Voice

Plain, specific, active. Say what happened and what to do next.

- "Cancel your 2 open orders before withdrawing." — not "Withdrawal failed."
- "Start trading" — not "Initialize trading session."
- "Returning funds from the rollup…" — name the actual step in progress.

Avoid crypto maximalism ("blazing fast", "revolutionary") and avoid hiding
mechanics the user is responsible for. The rollup, the session key and the
custody boundary are explained in plain words rather than concealed.
