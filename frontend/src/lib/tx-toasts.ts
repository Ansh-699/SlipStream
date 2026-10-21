/**
 * Transaction toasts: one card per order/cancel/close, pushed as "sending…"
 * the moment it is clicked and settled IN PLACE (same card, no flicker) with
 * its measured time and an explorer link. A module store rather than React
 * state so any panel can push and one <TxToasts/> renders them.
 */
export interface TxToast {
  id: number;
  ok: boolean;
  pending: boolean;
  title: string;
  detail?: string;
  href?: string;
}

const MAX_TOASTS = 5;
let toasts: readonly TxToast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function dismissLater(id: number, ok: boolean) {
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, ok ? 4_000 : 8_000);
}

export function pushTxToast(toast: Omit<TxToast, "id">): number {
  const id = nextId++;
  toasts = [{ ...toast, id }, ...toasts].slice(0, MAX_TOASTS);
  if (!toast.pending) dismissLater(id, toast.ok);
  emit();
  return id;
}

export function settleTxToast(id: number, patch: Omit<TxToast, "id" | "pending">): void {
  toasts = toasts.map((t) => (t.id === id ? { ...t, ...patch, pending: false } : t));
  dismissLater(id, patch.ok);
  emit();
}

export function txToasts(): readonly TxToast[] {
  return toasts;
}

export function onTxToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const EMPTY: readonly TxToast[] = [];
export function serverTxToasts(): readonly TxToast[] {
  return EMPTY;
}
