import { WalletProvider } from "@/components/wallet/wallet-provider";

/**
 * The OAuth landing page needs the provider too: ConnectBox finishes the
 * Google/Apple handoff, and `useWallet()` reads the resulting session through
 * usePhantom(), which throws without a PhantomProvider ancestor. Declared here
 * for the same reason as /trade/layout.tsx — the provider is no longer in the
 * root layout, so each route that touches the wallet declares it.
 */
export default function AuthCallbackLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <WalletProvider>{children}</WalletProvider>;
}
