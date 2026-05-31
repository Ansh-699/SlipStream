import type { Metadata } from "next";
import { Poppins, Geist_Mono } from "next/font/google";
import { WalletProvider } from "@/components/wallet/wallet-provider";
import "./globals.css";

const poppins = Poppins({
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://slipstream.ansht.tech"),
  title: "Slipstream — On-chain Perpetual Futures on Solana",
  description:
    "On-chain perpetual-futures CLOB on Solana. Sub-second order matching on MagicBlock Ephemeral Rollups; collateral and settlement on Solana L1.",
  applicationName: "Slipstream",
  openGraph: {
    title: "Slipstream — On-chain Perpetual Futures on Solana",
    description:
      "Sub-second perps CLOB on MagicBlock Ephemeral Rollups, settled on Solana L1.",
    url: "https://slipstream.ansht.tech",
    siteName: "Slipstream",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Slipstream — On-chain Perpetual Futures on Solana",
    description:
      "Sub-second perps CLOB on MagicBlock Ephemeral Rollups, settled on Solana L1.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${poppins.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `document.documentElement.classList.add('dark');try{localStorage.setItem('theme','dark')}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
