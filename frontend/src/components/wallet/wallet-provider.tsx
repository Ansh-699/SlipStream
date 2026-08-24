"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
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

/**
 * The same theme with its surfaces and signals swapped for the app's light
 * tokens. Phantom's modal renders with its own inline styles outside our CSS,
 * so it cannot pick up `.dark` on <html> — without this it stayed a #0a0f0e
 * panel under an 80%-black scrim over a white page, i.e. the sign-in step was
 * the one surface in the app that never followed the theme.
 *
 * `brand` and `error` move too, because they are not decoration here: the SDK
 * paints `brand` as the "Continue with Phantom" button fill under a hardcoded
 * #FFFFFF label (emerald-500 under white is 2.1:1; --t-up's #047857 is 4.8:1),
 * and `error` as the "Failed to disconnect" caption directly on `background`
 * (rose-500 on white is 3.4:1; --t-down's #be123c is 6.4:1). `success` is
 * declared by the type but the SDK never reads it, so it rides along unchanged.
 *
 * `secondary` must stay a "#" hex string: mergeTheme derives its aux colour
 * with hexToRgba and throws "Secondary color must be a hex color..." otherwise,
 * during PhantomProvider render at layout level — that takes the whole app
 * down, not just the modal. The SDK's own exported `lightTheme` is not used
 * because it carries Phantom's purple brand (#7C63E7) and would drop the
 * emerald accent.
 */
const slipstreamThemeLight: Partial<PhantomTheme> = {
  ...slipstreamTheme,
  background: "#ffffff", // --t-bg
  text: "#0e1417", // --t-text
  secondary: "#5f6a74", // --t-text-3
  brand: "#047857", // --t-up
  error: "#be123c", // --t-down
  overlay: "rgba(15, 23, 23, 0.5)",
};

export function WalletProvider({ children }: { children: ReactNode }) {
  // Read the class the ThemeToggle flips, and re-read it on the event it
  // dispatches. The first read MUST be inside the effect: there is no
  // `document` during SSR, and layout.tsx's inline <head> script has already
  // set the class before hydration, so mount is the correct moment. `true` as
  // the initial value matches that script's dark fallback, so no mismatch.
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const read = () => setDark(document.documentElement.classList.contains("dark"));
    read();
    window.addEventListener("themechange", read);
    return () => window.removeEventListener("themechange", read);
  }, []);

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
      // Must be "user-wallet": Phantom rejects "app-wallet" at provider init
      // ("app-wallet type is not currently supported"), which takes the whole
      // page down rather than degrading. The sign-in experience is the same --
      // Google/Apple, no extension -- the wallet is just the user's Phantom
      // account rather than one scoped to this app.
      embeddedWalletType: "user-wallet" as const,
      autoConnect: true,
      ...(redirectUrl ? { authOptions: { redirectUrl } } : {}),
    };
  }, []);

  return (
    <PhantomProvider
      config={config}
      theme={dark ? slipstreamTheme : slipstreamThemeLight}
      appName="SlipStream"
    >
      {children}
    </PhantomProvider>
  );
}
