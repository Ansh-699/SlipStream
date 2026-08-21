# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Confirmed by the user: **all four audiences at once**, none subordinate.

1. **Grant / hackathon reviewer** — evaluating engineering depth in a short sitting. Arrives from a submission link, reads the landing page and docs, may click through the live demo but will not create test funds or debug a broken flow.
2. **A trader who wants to trade** — wants to place a leveraged order without ceremony. Judges the terminal on density, latency, and whether numbers can be trusted.
3. **Recruiter / technical portfolio visitor** — judging craft and systems thinking. Reads the architecture writing as closely as the interface.
4. **Reference-implementation reader** — treating the repo and docs as a public worked example of ER-based CLOB design.

The union constrains the work more than any single audience would: the surface must be credible in ten seconds *and* genuinely operable. A demo that only looks real fails the reviewer; a working exchange with no legible explanation fails the recruiter and the reference reader.

## Product Purpose

Slipstream is an on-chain **perpetual-futures exchange** built on a **central-limit order book** with price-time-priority matching — the model real exchanges use, not an AMM. It tracks SOL/USD with leverage up to 20×, plus funding and liquidations.

It exists to resolve a specific conflict: a real CLOB needs thousands of fast, cheap order updates that Solana's base layer cannot host directly, while that same base layer is the only place money can be custodied safely. Slipstream splits the system rather than compromising either half.

Success spans all four definitions the user confirmed: a submission that survives scrutiny, strangers able to trade on devnet unaided, a path that stays open to mainnet, and a codebase durable enough to be read as a reference.

## Positioning

**Order matching at rollup speed, custody at L1 security** — and the split is capped, not merely asserted.

The claim a neighboring product cannot truthfully copy is the specific delegation boundary:

- The ~612 KB **OrderBook** is delegated to the MagicBlock Ephemeral Rollup permanently. It holds order metadata only — no value.
- The **only** value-bearing account ever delegated is **TradingCredit**: a per-market allowance the user explicitly funds and caps.
- `UserAccount.free_collateral`, `Position`, and the token vault stay on L1 and are never delegated.

The consequence is the positioning: a misbehaving rollup can at worst scramble order *ordering* or misuse an already-capped credit allowance. It can never reach the vault or an undelegated balance. Speed is bounded by an architecture, not by trust.

## Operating Context

- **Two signing tiers.** A managed embedded wallet (Phantom Connect — Google, Apple, or an injected extension) is the on-chain **owner** and signs the infrequent money-moving actions. A browser-local **session key** signs orders only, so trading costs zero popups. The program enforces this: every money-moving instruction hard-requires `owner.is_signer()`, and a session key can only sign `place_order` / `cancel_order`.
- **Onboarding is auto-pilot.** One action chains initialize → deposit → fund credit → delegate. Withdrawal reverses it: undelegate → poll for the base-layer ownership flip → withdraw credit → withdraw collateral. Undelegation is **asynchronous** — the validator performs the flip, so any UI that waits on it must poll, not assume.
- **Test funds come from an in-app faucet.** Devnet USDC plus a SOL top-up for network fees. Fresh embedded wallets have neither, so the faucet is load-bearing for first-run, not a convenience.
- **Off-chain keepers** (settlement, funding, liquidation, TWAP, expiry) and a market-maker bot run continuously under pm2. Liquidity on screen is real, not seeded fixtures.
- **All RPC is proxied same-origin** through the app's own routes to avoid CORS and to keep upstream keys server-side.
- Users arrive on desktop for the terminal and from links for the landing page and docs.

## Capabilities and Constraints

**Live capabilities:** limit and market orders with price-time-priority matching in the ER; margin × leverage up to 20×; ER→L1 settlement into real `Position` accounts via the FillLog pipeline; partial close and slippage-bounded close-at-market; keeper-executed stop-loss / take-profit triggers; funding rate on an 8h interval from a self-computed 30-min TWAP; liquidations with health factor and liquidation price; session keys; live Pyth price chart over SSE with real OHLC history; settled-trade history and a system-status panel.

**Economics:** a per-market **taker fee in basis points** (`Market.taker_fee_bps`), snapshotted onto each fill event. No maker fee is implemented.

**Constraints future work must preserve:**

- **The authorization model is not negotiable.** Only the owner moves money or (un)delegates. A session key trades and nothing else.
- **Withdrawal requires an idle account** — no active orders, no committed margin. The UI blocks with a clear instruction rather than silently failing.
- **Devnet today, mainnet not foreclosed.** The user confirmed a mainnet path as one success definition, so work must not paint the product into devnet-only corners: faucet-dependent first-run, a single operator key, and test-token copy are all things a mainnet build has to shed.
- **The faucet mints worthless devnet test tokens.** It is rate-limited per wallet, per IP, and globally, and must never echo raw RPC error text to clients — upstream URLs can carry private keys.
- **Undelegation cannot be treated as synchronous.**
- Terminology is fixed and defined in `docs/08-glossary.md` (trading, Solana, MagicBlock/ER, Slipstream-specific accounts, tooling). Future copy uses those terms as written.

**Open / undecided:** whether the frontend stays on the pm2 + nginx VM or moves to Vercel; whether the operator key (currently program upgrade authority, USDC mint authority, and faucet signer in one) is split before any further deployment.

## Brand Commitments

- Name: **Slipstream**. MIT licensed, © 2026 Ansh Tyagi.
- **`brand.md` at the repo root is the binding identity record**, marked active and explicitly the source of truth for palette, material, typography, motion, and voice. It is not restated here and must not be contradicted or duplicated.
- Two commitments from it are product-level, not decorative, and bind future work regardless of visual direction:
  - **Colour is load-bearing signal.** Emerald means working or up, amber means waiting or blocked, rose means failed or down. Emerald is never decoration in a trading UI.
  - **Voice is plain, specific, active** — name the step in progress and the next action. No crypto maximalism, no concealing mechanics the user is responsible for.
- **Mechanism disclosure, as decided this session:** the default path is one-click and silent; the rollup, session key, and custody split are disclosed in a secondary or on-demand layer for anyone who looks. Auto-pilot and `brand.md`'s transparency rule both hold — the mechanism is available, not absent, and never buried in docs alone.
- Assets on hand: `frontend/public/logo.png`, `logo-32.png`, `banner.png`.

## Evidence on Hand

**Real and verifiable:**

- Program deployed to Solana devnet (`deploy.json`), written in Pinocchio; 612 KB order book as one flat zero-copy PDA.
- A live ER order book carrying real market-maker liquidity — two-sided, six levels per side, verified against the live rollup.
- 123 passing Rust tests (25 unit + 98 Mollusk) as the regression baseline.
- CI green on clippy `-D warnings`, `cargo audit`, SBF build, and Mollusk tests.
- Nine architecture documents (`docs/00`–`08` plus research), mirrored into `frontend/src/content/docs/` and rendered at `/docs`.
- A client SDK (`client/`) and an integration test suite (`tests/integration/`).
- Live demo at `slipstream.ansht.tech`.

**Absences future work must not fabricate:** there are no real users, no testimonials, no case studies, no press, no security audit, no mainnet deployment, and no trading-volume, TVL, or revenue figures. The market-maker liquidity is a bot the project runs itself and must be described as such. `docs/` and `README.md` currently describe a three-step onboarding flow the UI no longer has; they are stale, not authoritative.

## Product Principles

1. **Verifiable over impressive.** Every claim on screen traces to something a reader can check — a deployed program, a passing test, a live account. The reviewer audience makes an unverifiable claim worse than no claim.
2. **The custody boundary is the product.** Speed is the headline, but the capped-delegation split is what makes it defensible. It gets explained, never assumed.
3. **One click to trade, one look to understand.** Friction belongs to neither audience: the trader gets auto-pilot, the reader gets the mechanism a layer down.
4. **Numbers are instruments.** Prices, sizes, and balances are read under time pressure. Legibility and stability outrank expression wherever live values are displayed.
5. **Don't foreclose mainnet.** Devnet affordances are scaffolding, marked as such, and never load-bearing in a way that a real-money build would have to unwind.

## Accessibility & Inclusion

No formal standard was set by the user, but the project's own behavior establishes a floor that future work should hold rather than re-litigate:

- **WCAG AA contrast** on interactive elements — a prior CTA was deliberately corrected from a ~3.6:1 to a measured 5.09:1 pairing.
- **`prefers-reduced-motion: reduce` removes decorative motion outright** rather than shortening it, which is safe precisely because `brand.md` requires all motion to restate something already visible statically.
- Live-updating numbers must not rely on colour alone to convey direction, given colour is already carrying working/waiting/failed state.
