/**
 * This browser's own rollup transactions with their measured timings, for the
 * latency panel. A tiny external store (read with useSyncExternalStore) so
 * er-exec.ts can record from outside React.
 *
 * `ms`:    click -> the rollup reported the transaction processed.
 * `sendMs`: send -> processed, i.e. what the rollup and the network cost
 *          without the signing and building around it.
 * `netMs`: one plain network round trip to the rollup at that moment (the
 *          signatureSubscribe acknowledgement), so `sendMs - netMs` is roughly
 *          the rollup's own share.
 */
export interface ErTxSample {
  kind: string;
  ms: number | null;
  sendMs: number | null;
  netMs: number | null;
  ok: boolean;
  /** Epoch ms when the click happened. */
  at: number;
  signature: string;
  /** How "processed" was learned: the websocket push or the HTTP poll. */
  via: "push" | "poll" | "proxy" | null;
}

const MAX_SAMPLES = 30;
let samples: readonly ErTxSample[] = [];
const listeners = new Set<() => void>();

export function recordErTx(sample: ErTxSample): void {
  // A new array each time: useSyncExternalStore compares snapshots by reference.
  samples = [sample, ...samples].slice(0, MAX_SAMPLES);
  listeners.forEach((l) => l());
}

export function erTxSamples(): readonly ErTxSample[] {
  return samples;
}

export function onErTx(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const EMPTY: readonly ErTxSample[] = [];
export function serverErTxSamples(): readonly ErTxSample[] {
  return EMPTY;
}

/** Median of the successful samples' `pick`, or null with none. */
export function medianOf(list: readonly ErTxSample[], pick: (s: ErTxSample) => number | null): number | null {
  const values = list
    .flatMap((s) => {
      const v = s.ok ? pick(s) : null;
      return v === null ? [] : [v];
    })
    .sort((a, b) => a - b);
  return values.length ? values[Math.floor(values.length / 2)] : null;
}
