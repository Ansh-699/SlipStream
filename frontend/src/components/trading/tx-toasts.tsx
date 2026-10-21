"use client";

import { useSyncExternalStore } from "react";
import { onTxToasts, serverTxToasts, txToasts } from "@/lib/tx-toasts";

/**
 * Order, cancel and close toasts: "sending…" the moment a button is pressed,
 * settled in place with the measured click -> processed time and an explorer
 * link. Rendered inside the dashboard's toast stack, above fill toasts.
 */
export function TxToasts() {
  const toasts = useSyncExternalStore(onTxToasts, txToasts, serverTxToasts);
  return (
    <div className="flex w-[300px] flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className="card-enter pointer-events-auto flex items-start gap-2.5 rounded-[8px] border border-[var(--t-border)] bg-[var(--t-surface)] px-3 py-2.5 shadow-lg"
        >
          <span
            aria-hidden
            className={`mt-[3px] h-2 w-2 flex-none rounded-full ${
              toast.pending ? "animate-pulse bg-[var(--t-text-3)]" : toast.ok ? "bg-[var(--t-up)]" : "bg-[var(--t-down)]"
            }`}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-medium text-[var(--t-text)]">{toast.title}</p>
            {toast.detail ? (
              <p className="tnum mt-0.5 line-clamp-3 text-[11.5px] text-[var(--t-text-2)]">{toast.detail}</p>
            ) : null}
          </div>
          {toast.href ? (
            <a
              href={toast.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-none text-[12px] font-medium text-[var(--t-text-2)] hover:text-[var(--t-text)]"
              aria-label="View transaction on Explorer"
            >
              View ↗
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}
