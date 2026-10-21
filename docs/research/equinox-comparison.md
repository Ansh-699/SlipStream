# Slipstream vs Equinox: trading terminal comparison

A side-by-side of the two MagicBlock-rollup perp CLOBs, written to decide what
to merge. Ansh-699/Equinox was read at `d794c65`; this repo at the commit that
adds this file. Landing pages are out of scope. The terminal, the order book,
the matching flow and the real-time rollup path are what is compared.

## At a glance

| | Slipstream (before this change) | Equinox | Slipstream (now) |
|---|---|---|---|
| Book account layout | One 626,736 B PDA: 2,048 order slots, 2x512 sorted price levels (binary search + FIFO slot list per level), 4,096-entry fill ring | 27 delegated accounts per market: core, 18 book pages (critbit trees: fixed + oracle-pegged), 4 seat shards, 4 event shards | unchanged (program not touched) |
| Order types | limit, market (slippage-bounded), IOC close, keeper-run SL/TP | limit, IOC, post-only, reduce-only, expiry, oracle-pegged | unchanged |
| Where value lives | L1 (`UserAccount`, `Position`, vault); only a capped `TradingCredit` is delegated; fills settle to L1 via FillLog | Seats (collateral, position, PnL) live in the rollup; vault on L1; commit every 30 min; inbox/outbox custody | unchanged |
| Book transport to the browser | HTTP `getAccountInfo` every 2 s through the Next proxy: 836 KB base64 per read upstream, ~40 KB gzipped to the browser, plus up to 16 s backoff | Direct rollup websocket `accountSubscribe`, `base64+zstd`, processed commitment; 1 s poll only when the socket goes quiet | **Direct rollup websocket push, `base64+zstd` (~26-35 KB per change), processed; direct compressed read as a heartbeat every 15 s; proxy poll only when the socket is down** |
| Render pipeline | Every read: full decode (~10k objects, 10,240 PublicKeys) then re-render; rows not memoised; depth bars animate `width` | Pushes coalesced to one decode per frame, at most 20/s; identical payloads skipped; per-account decode cache; memo rows; `scaleX` bars | **Same coalescing (rAF, 50 ms floor), identical payloads skipped, incremental decode that reuses every unchanged record, memo rows, `scaleX` bars, shared `Intl` formatters, referentially stable fill arrays** |
| Order path | Fresh blockhash via proxy, send via proxy, poll `getSignatureStatuses` every 600 ms to `confirmed` | Warm blockhash (2 s), direct send, `signatureSubscribe` push raced against a 15 ms poll, to processed | **Warm blockhash (2 s refresh, 5 s reuse; ER blockhashes stay valid ~50 s), direct send with proxy fallback, `signatureSubscribe` (opened before the send) raced against a 40 ms poll, to processed; duplicate-message guard** |
| Concurrency | Button blocked until the order confirms | Several orders in flight | Several session-key orders in flight; wallet-signed orders still wait for their prompt |
| Feedback | Explorer link under the button; fill toasts | Pending→settled tx toasts with ms-from-click; live rollup tx panel with p50 and RTT | **Both: pending→settled toasts with measured time; "Rollup · live" panel with your p50 and RTT; fill toasts kept** |
| Book UX | 20 levels/side, no click-to-price, no own-order mark, empty state while loading | 100 levels, click-to-price, own-order dot + edge, skeleton, depth chart tab | **All of these** |

## Measured

All numbers come from this container: Node 22 and headless Chromium against
devnet. The network round trip to `devnet.magicblock.app` from here is about
230 ms, so absolute times are dominated by distance. The ratios carry over.

**Order path, click → rollup answer.** The same harmless transaction was sent
5 times per run (a compute-budget instruction signed by a throwaway key; the
rollup is gasless).

| | runs | warm times |
|---|---|---|
| Original flow (blockhash → send → 600 ms poll to confirmed), minus the proxy hop the browser also paid | 2 x 5 | 716 - 798 ms (first, cold: ~1.85 s) |
| `lib/er-exec.ts` | 3 x 5 | 238 - 248 ms (one round trip) |

Close to the rollup (Equinox's market maker sits ~2 ms away), the new path is
one RTT plus a ~10 ms block. The old one was three RTTs plus up to 600 ms of
polling granularity.

**Main-thread work per book update** (live devnet book, Node):

| | before | after |
|---|---|---|
| Decode on a push (1 slot + 1 fill changed) | 4.90 ms (full decode) | 1.03 ms (incremental) |
| zstd decompress of the push | n/a | ~5 ms (fzstd, pure JS) |
| Pending-position replay | 28 ms on **every oracle tick** (~20/s, so ~566 ms/s with the Positions tab open and a wallet connected) | 0.34 ms, and only when fills change; pricing per tick is a few bigint ops |

**Network, 30 s on `/trade` with no wallet connected** (CDP byte counts, two
runs each):

| | before | after |
|---|---|---|
| Book reads | 14-15 proxied reads, 382-428 KB to the browser; the server pulled 836 KB per read from MagicBlock | 0 proxied; ~2 direct compressed heartbeats; pushes only when the book changes |
| Whole tab | 21.8-23.4 KB/s | 10.8 KB/s (most of it is the unchanged 20 Hz oracle socket) |
| First book paint | 2.1-2.8 s | 2.3-2.4 s, with a skeleton instead of an empty panel |

The book was idle during these runs, so the push path was verified separately:
the shared socket received and decoded `base64+zstd` pushes from a rollup
account updating every ~50 ms.

## What changed in this repo

- `lib/er-socket.ts`: one multiplexed rollup websocket (account and signature
  subscriptions), with reconnect and backoff. It drops the socket after 30 s
  hidden and resubscribes on visible.
- `hooks/use-orderbook.ts`: the push feed, frame coalescing, the requote-gap
  hold (as Equinox has), a slot guard between pushes and reads, direct
  compressed reads with the old proxy chain as fallback, and referentially
  stable fill and slot arrays.
- `lib/shared-source.ts`: an optional `LiveFeed`. While it is fresh, the
  poller's ticks are skipped; `revalidate` still forces a read.
- `lib/slipstream/orderbook.ts`: `decodeOrderBookIncremental`. The vendored
  `accounts.ts` is untouched.
- `hooks/use-er-position.ts`: the replay is split from the pricing; owners are
  compared by bytes, not base58.
- `lib/er-exec.ts`, `lib/er-latency.ts`, `lib/tx-toasts.ts`: the order, cancel
  and pending-close fast path, the latency store and the toast store. Used by
  `order-form.tsx`, `open-orders.tsx` and `positions-table.tsx`.
- UI: the Equinox-style ladder (`order-book-display.tsx`), `depth-chart.tsx`,
  `er-tx-panel.tsx`, `tx-toasts.tsx`, click-to-price (`lib/ticket-bus.ts`),
  book tokens in `globals.css`.

All of Slipstream's existing behaviour is kept: the stale/unavailable states,
the market-order slippage and thin-book checks, the margin pre-flight, the
landed-despite-timeout check and the settlement-cursor gating. Preflight still
runs, so a rejected order fails at send with its program error.

## What remains / merge candidates

1. **Move decode into a Web Worker.** zstd plus incremental decode is about
   6 ms per changed push on the main thread. Equinox's accounts are ~12 KB
   each, so the same cost is smaller there. Slipstream's single 612 KB account
   is the structural reason.
2. **Shard the book account** (Equinox's page/seat/event split). A trade
   rewrites, and the rollup re-sends, the whole 612 KB account. Equinox pushes
   only the shard that changed. This is a program and migration change.
3. **Critbit trees, oracle-pegged orders, post-only, reduce-only enforced on
   chain, expiry.** Equinox's `book.rs` has them. Slipstream parses
   `reduce_only` and ignores it (`place_order.rs`).
4. **Risk in the rollup vs on L1.** Equinox keeps seats in the ER and commits
   periodically. Slipstream keeps positions on L1 and delegates only a capped
   credit. This is the main design fork to settle before merging: it trades
   custody exposure against no settlement lag.
5. **One socket for everything.** `use-live-price.ts` still opens its own
   rollup socket. Folding it into `er-socket.ts` would save a connection.
6. **Market-maker telemetry.** Equinox's tx panel also streams the bot's
   transactions with block times from its service. Slipstream's keepers expose
   no such feed, so the panel shows only this browser's own transactions.
7. **Wallet-signed order concurrency.** These orders still serialise on the
   wallet prompt. Only session-key orders pipeline.
