/**
 * Self-rescheduling poll: the replacement for `setInterval(asyncFn, ms)`.
 *
 * `setInterval` fires on a fixed schedule regardless of whether the previous
 * call has returned. When a tick takes longer than its interval — which is the
 * normal case for an RPC under load — the calls pile up, and nothing bounds the
 * pile. Nine hooks in this app polled that way with no overlap guard between
 * them, one of them re-fetching a 612 KiB order book every 2s, and the browser
 * eventually refused to open more sockets:
 *
 *     POST /api/rpc/base  net::ERR_INSUFFICIENT_RESOURCES   (x1479)
 *
 * Once that starts, every request is affected — including the handful the
 * onboarding flow needs — so the symptom presents as "the button does nothing"
 * rather than as a polling problem.
 *
 * This schedules the next tick `ms` after the previous one COMPLETES, so there
 * is never more than one in flight per poller and the queue cannot grow. On
 * repeated failure it backs off geometrically to a cap, because a poller that
 * keeps its full rate through an outage is what turns a blip into a pile-up.
 *
 * Not a hook — call it inside useEffect and return its cleanup.
 */
export function startPoll(
  fn: () => Promise<unknown> | unknown,
  ms: number,
  opts: { maxBackoff?: number } = {}
): () => void {
  const maxBackoff = opts.maxBackoff ?? 8;
  let stopped = false;
  let fails = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      await fn();
      fails = 0;
    } catch {
      // Callers own their error reporting; this only affects the cadence.
      fails = Math.min(fails + 1, 4);
    }
    if (stopped) return;
    const factor = fails === 0 ? 1 : Math.min(2 ** fails, maxBackoff);
    timer = setTimeout(tick, ms * factor);
  };

  timer = setTimeout(tick, ms);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
