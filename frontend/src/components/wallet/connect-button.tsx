"use client";

import { useWallet } from "@/hooks/use-wallet-compat";

/**
 * Sign-in / identity control for the terminal nav. Reads only React context, so
 * unlike the old vendor button it needs no `dynamic({ ssr: false })` split and
 * no `!important` overrides in globals.css to reach its inline styles.
 */
export function ConnectButton() {
  const { publicKey, connected, connecting, connect, disconnect } = useWallet();

  if (!connected) {
    return (
      <button
        type="button"
        onClick={connect}
        disabled={connecting}
        className="rounded-lg bg-[var(--t-up-3)] px-3.5 py-1.5 text-[13px] font-semibold text-[var(--t-on-fill)] transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {connecting ? "Connecting…" : "Sign in"}
      </button>
    );
  }

  const a = publicKey!.toBase58();
  return (
    <button
      type="button"
      onClick={() => void disconnect()}
      title="Sign out"
      className="tnum rounded-lg border border-[var(--t-border-strong)] px-3 py-1.5 text-[13px] text-[var(--t-text-2)] transition-colors hover:text-[var(--t-text)]"
    >
      {a.slice(0, 4)}…{a.slice(-4)}
    </button>
  );
}
