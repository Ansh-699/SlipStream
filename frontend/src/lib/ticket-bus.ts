/**
 * Clicking a ladder level fills the order ticket's limit price. The book and
 * the ticket are siblings in different columns, so a tiny event channel
 * connects them instead of lifting the ticket's state into the dashboard (which
 * would re-render the whole terminal on every keystroke).
 */
type Listener = (price: number) => void;
const listeners = new Set<Listener>();

export function pickBookPrice(price: number): void {
  listeners.forEach((l) => l(price));
}

export function onBookPricePick(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
