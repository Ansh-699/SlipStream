import { WalletProvider } from "@/components/wallet/wallet-provider";

/**
 * The wallet provider lives here rather than in the root layout so the Phantom
 * + web3.js bundle (~740 KB uncompressed) is only in the client graph of the
 * routes that actually sign things. In the root layout it was a first-load
 * chunk on all seven routes, including /docs and /landing, which is a bare
 * redirect.
 *
 * No "use client" on this file: WalletProvider carries its own boundary, so
 * this layout stays a server component and everything above it — /docs, / —
 * keeps rendering on the server.
 */
export default function TradeLayout({ children }: { children: React.ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}
