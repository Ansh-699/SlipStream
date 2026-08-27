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
  /** The poller's own fetch, exposed so `revalidate` can run it off-schedule. */
  run?: () => Promise<void>;
  /**
   * Issue order for reads of this key. A manual revalidate can overlap a
   * scheduled tick -- startPoll only serialises ITS OWN loop -- so without this
   * the slower of the two wins by finishing last and an older book can overwrite
   * a newer one. Same defect that had to be fixed in useSession and usePositions.
   */
  seq: number;
}

const registry = new Map<string, Entry<unknown>>();

function entryFor<T>(key: string): Entry<T> {
  let e = registry.get(key) as Entry<T> | undefined;
  if (!e) {
    e = { data: null, error: null, subscribers: new Set(), seq: 0 };
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
        const my = ++e.seq;
        try {
          const next = await capturedFetcher();
          // A newer read already landed. Drop this one rather than applying a
          // stale book over a fresh one, and stay silent -- the newer read
          // notified, or is about to.
          if (my !== e.seq) return;
          e.data = next;
          e.error = null;
        } catch (err) {
          if (my !== e.seq) return;
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
      e.run = run;
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

/**
 * Re-read a shared key NOW, off the poll schedule.
 *
 * WHY: the poller is the only thing that refreshes a shared source, and its gap
 * is `intervalMs` AFTER the previous fetch completes -- plus startPoll's
 * geometric backoff, which reaches 16s for a 2s source. Measured on production:
 * the book's render gaps were 2.3s, 2.5s, 2.5s, 2.8s and then 12.3s. So a user
 * who cancels an order sees the row sit there for anything up to ~16s, having
 * just watched a confirmation succeed. A comment in open-orders.tsx claimed
 * that wait was "within 2s"; it is not, and the cancel path was left with no
 * way to ask for a read at all.
 *
 * Deliberately narrow:
 *  - never CREATES an entry, so it cannot resurrect a key nothing is watching
 *    and start an orphan poller;
 *  - no-ops when the last subscriber has unmounted;
 *  - runs the poller's own fetch, so there is exactly one code path writing
 *    the entry, and the seq guard above keeps a slow manual read from
 *    overwriting a fast scheduled one.
 * Call it AFTER a confirmation, from an event handler -- never during render.
 */
export function revalidate(key: string): void {
  const e = registry.get(key);
  if (!e || e.subscribers.size === 0 || !e.run) return;
  // The rejection is already recorded on the entry by run(); this only stops it
  // surfacing as an unhandled rejection.
  void e.run().catch(() => {});
}
