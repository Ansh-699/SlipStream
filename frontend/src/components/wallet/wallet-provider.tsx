"use client";

import { useMemo, type ReactNode } from "react";
import { PhantomProvider, type PhantomTheme } from "@phantom/react-sdk";
import { AddressType, type AuthProviderType } from "@phantom/browser-sdk";

/**
 * Phantom Connect replaces `@solana/wallet-adapter-*`. It covers both the
 * embedded wallet (Google/Apple — key held by Phantom, never in app storage)
 * and the Phantom browser extension via the "injected" provider, so extension
 * users keep working under a single provider.
 *
 * No `ConnectionProvider` here: RPC connections are handed out by
 * `useConnection()` in `@/hooks/use-wallet-compat`, because this app talks to
 * two clusters (base layer + MagicBlock ER) rather than one.
 */

/** Phantom-hosted theme, matched to the app's dark aurora + emerald accent. */
const slipstreamTheme: Partial<PhantomTheme> = {
  background: "#0a0f0e",
  text: "#ffffff",
  secondary: "#98979C",
  brand: "#10b981",
  error: "#f43f5e",
  success: "#10b981",
  borderRadius: "16px",
  overlay: "rgba(0, 0, 0, 0.8)",
};

export function WalletProvider({ children }: { children: ReactNode }) {
  const config = useMemo(() => {
    const appId = process.env.NEXT_PUBLIC_PHANTOM_APP_ID;
    const redirectUrl =
      process.env.NEXT_PUBLIC_PHANTOM_REDIRECT_URL ??
      (typeof window !== "undefined"
        ? `${window.location.origin}/auth/callback`
        : undefined);

    return {
      // "injected" keeps working without an appId; Google/Apple require one.
      providers: (appId
        ? ["google", "apple", "injected"]
        : ["injected"]) as AuthProviderType[],
      appId,
      addressTypes: [AddressType.solana],
      // App-scoped wallet: created for SlipStream rather than the user's
      // personal Phantom account, which is what makes it feel "in-app".
      embeddedWalletType: "app-wallet" as const,
      autoConnect: true,
      ...(redirectUrl ? { authOptions: { redirectUrl } } : {}),
    };
  }, []);

  return (
    <PhantomProvider
      config={config}
      theme={slipstreamTheme}
      appName="SlipStream"
    >
      {children}
    </PhantomProvider>
  );
}
