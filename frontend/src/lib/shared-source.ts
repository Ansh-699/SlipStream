"use client";

import { useEffect, useReducer, useRef } from "react";
import { startPoll } from "@/lib/poll";

/**
 * One poller per KEY, not one per mount.
 *
 * Every `useX()` in this app is a plain hook with its own useState and its own
 * poll loop. There is no context and no cache, so N components mounting the
 * same hook produce N independent loops fetching the same account. On the
 * default /trade view that is measurably expensive:
 *
 *   useOrderBook  x3 mounts  (order-book-display, status-panel, fill-toasts)
 *   useMarket     x5 mounts  (dashboard, market-bar, status-panel, order-form,
 *                             use-mark-price)
 *   useLivePrice  x5 mounts  -> five separate WebSockets to the same feed
 *
 * The OrderBook account is 626,736 bytes (835,900 on the wire as base64), so
 * three redundant copies every 2s is ~1.25 MB/s of pure duplication — about
 * three quarters of everything this tab moves. One of those three consumers
 * reads eight bytes of it.
 *
 * `startPoll` guarantees one in-flight tick PER POLLER; it has no visibility
 * across pollers, which is exactly the gap this closes. Subscribers share one
 * loop keyed by a string that must encode every input the fetcher depends on.
 * The loop starts with the first subscriber and stops with the last, so an
 * unmounted tab costs nothing.
 */

interface Entry<T> {
  data: T | null;
  error: unknown;
  subscribers: Set<() => void>;
  stop?: () => void;
}

const registry = new Map<string, Entry<unknown>>();

function entryFor<T>(key: string): Entry<T> {
  let e = registry.get(key) as Entry<T> | undefined;
  if (!e) {
    e = { data: null, error: null, subscribers: new Set() };
    registry.set(key, e as Entry<unknown>);
  }
  return e;
}

/**
 * Subscribe to a shared, polled value.
 *
 * @param key      Falsy (null or "") disables the subscription entirely, e.g.
 *                 before a wallet connects.
 *                 MUST encode every input `fetcher` closes over, or two callers
 *                 with different inputs will silently share one result.
 * @param fetcher  Captured once PER KEY, from whichever subscriber opens that
 *                 key's loop, and held until the last subscriber leaves. Once
 *                 the loop is running no later render can swap it out, so the
 *                 key contract above is what actually keeps callers honest.
 * @param intervalMs Gap after each completed fetch, not a fixed period.
 */
export function useSharedSource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  intervalMs: number
): { data: T | null; error: unknown } {
  const [, rerender] = useReducer((c: number) => c + 1, 0);
  const fetcherRef = useRef(fetcher);

  // Tracking the latest fetcher belongs in an effect, not in the render body:
  // writing a ref during render is a react-hooks/refs error and is unsafe under
  // concurrent rendering, where a render can be thrown away after mutating it.
  // This effect is declared BEFORE the subscribe effect on purpose. React runs
  // setups in declaration order, so on the render where `key` changes this has
  // already stored the fetcher belonging to the NEW key by the time the
  // subscribe effect below reads it — otherwise a component that switched
  // markets would open the new key's loop with the old market's fetcher and
  // file one market's data under the other's key.
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (!key) return;
    const e = entryFor<T>(key);
    const notify = () => rerender();
    e.subscribers.add(notify);

    if (e.subscribers.size === 1) {
      // Captured once, here. It used to call fetcherRef.current(), and that ref
      // is rewritten on every render of whichever instance happened to
      // subscribe first — so the owning instance could swap the shared fetcher
      // for a DIFFERENT input's fetcher while other subscribers still held the
      // old key, storing one market's data under another market's key. Not
      // reachable while every call site passes a constant index, but the
      // docstring promised a guarantee the code did not provide.
      const capturedFetcher = fetcherRef.current;
      const run = async () => {
        try {
          e.data = await capturedFetcher();
          e.error = null;
        } catch (err) {
          // Keep the last good value on screen; a transient RPC failure should
          // not blank a book that was correct a second ago. But tell the
          // subscribers AND rethrow: startPoll's geometric backoff keys off a
          // rejected promise, and swallowing it here left the backoff dead —
          // during an outage this loop held its full rate, re-issuing an
          // 836 KB getAccountInfo every 2s that the proxy multiplies into up to
          // three upstream attempts. That is precisely the pile-up poll.ts was
          // written for. Rethrowing decays it to one attempt every 16s.
          e.error = err;
          e.subscribers.forEach((f) => f());
          throw err;
        }
        e.subscribers.forEach((f) => f());
      };
      // The first tick is not run by startPoll, so it has no catch of its own.
      // Its rejection is already recorded on the entry above; the .catch only
      // keeps it from surfacing as an unhandled rejection.
      void run().catch(() => {});
      e.stop = startPoll(run, intervalMs);
    }

    return () => {
      e.subscribers.delete(notify);
      if (e.subscribers.size === 0) {
        e.stop?.();
        registry.delete(key);
      }
    };
  }, [key, intervalMs]);

  // Read WITHOUT creating. entryFor() inserts into the registry as a side
  // effect, and calling it here ran that mutation during the render phase —
  // leaking an entry for any key that renders but never subscribes (a key that
  // changes before the effect commits, or a component that unmounts first).
  const e = key ? (registry.get(key) as Entry<T> | undefined) : undefined;
  return { data: e?.data ?? null, error: e?.error ?? null };
}
