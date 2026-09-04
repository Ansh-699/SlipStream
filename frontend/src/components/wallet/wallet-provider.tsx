"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { RPC_URL } from "@/lib/manifest";

/**
 * Privy replaces the Phantom Connect SDK. Two kinds of wallet come through the
 * one provider: the Privy EMBEDDED wallet (created on Google sign-in; key held
 * in Privy's cross-origin iframe, never in app storage) and EXTERNAL wallets
 * (Phantom, Solflare, …) via Privy's Solana standard-wallet connectors.
 *
 * External wallets are not a courtesy. The TradingCredit PDA derives from the
 * OWNER pubkey (`[b"credit", owner, u16le(market_index)]`) and the program has
 * no owner-transfer instruction, so a user with an existing credit under their
 * Phantom pubkey can reach it ONLY by connecting that same wallet. That is also
 * why `createOnLogin` is `users-without-wallets` and not `all-users`: minting an
 * embedded wallet for an extension user would hand them a second, empty owner
 * and hide the one that holds their money.
 *
 * No `ConnectionProvider` here: RPC connections are handed out by
 * `useConnection()` in `@/hooks/use-wallet-compat`, because this app talks to
 * two clusters (base layer + MagicBlock ER) rather than one.
 */

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

  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) {
    // Fail at build/first render, loudly and by name. Phantom had an
    // "injected-only without an appId" fallback; Privy has no equivalent, and
    // a sign-in button that silently does nothing is worse than a build error.
    throw new Error("NEXT_PUBLIC_PRIVY_APP_ID is not set");
  }

  // Rebuilt only when the theme flips. Connectors and the kit RPC client must
  // not be recreated per render — each construction is a fresh object graph
  // the provider would treat as a config change.
  const config = useMemo<PrivyClientConfig>(
    () => ({
      loginMethods: ["google", "wallet"],
      appearance: {
        walletChainType: "solana-only",
        theme: dark ? ("dark") : ("light"),
        // Same pair the Phantom themes used: brand emerald on dark, --t-up on
        // light — emerald-500 under Privy's white button label is 2.1:1, and
        // #047857 is 4.8:1.
        accentColor: dark ? ("#10b981") : ("#047857"),
        logo: "/apple-icon.png",
        showWalletLoginFirst: false,
      },
      embeddedWallets: {
        solana: { createOnLogin: "users-without-wallets" },
      },
      externalWallets: {
        solana: { connectors: toSolanaWalletConnectors() },
      },
      solana: {
        rpcs: {
          // Privy's embedded-wallet modal simulates a transaction against this
          // before signing. Route it through the same-origin proxy so the
          // upstream key never reaches the browser and so a spent key fails
          // over instead of blanking the sign-in step.
          "solana:devnet": {
            rpc: createSolanaRpc(RPC_URL),
            // Required by the config type. Kit opens the socket lazily on the
            // first `.subscribe()`, and nothing in this app's Privy flows
            // subscribes, so this is never dialled. The proxy cannot serve WS.
            rpcSubscriptions: createSolanaRpcSubscriptions("wss://api.devnet.solana.com"),
            blockExplorerUrl: "https://explorer.solana.com?cluster=devnet",
          },
        },
      },
    }),
    [dark]
  );

  return (
    <PrivyProvider appId={appId} config={config}>
      {children}
    </PrivyProvider>
  );
}
