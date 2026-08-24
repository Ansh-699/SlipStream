import type { Metadata } from "next";
import { Poppins, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

// No WalletProvider here. It pulled the Phantom + web3.js chunk into the
// first load of every route, /docs and /landing included. It is declared in
// src/app/trade/layout.tsx and src/app/auth/callback/layout.tsx instead — the
// only two segments whose components call into `@/hooks/use-wallet-compat`.
// Any new route that needs a wallet must declare it the same way.

const poppins = Poppins({
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
});

// The /trade terminal is set in a neutral grotesque: Poppins is geometric and
// its round figures read poorly in a dense price ladder. Scoped to that surface.
const inter = Inter({
  variable: "--font-ui",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://slipstream.ansht.tech"),
  title: "Slipstream",
  description:
    "On-chain perpetual-futures CLOB on Solana. Sub-second order matching on MagicBlock Ephemeral Rollups; collateral and settlement on Solana L1.",
  applicationName: "Slipstream",
  openGraph: {
    title: "Slipstream",
    description:
      "Sub-second perps CLOB on MagicBlock Ephemeral Rollups, settled on Solana L1.",
    url: "https://slipstream.ansht.tech",
    siteName: "Slipstream",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Slipstream",
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
      className={`${poppins.variable} ${inter.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');if(t==='light'){document.documentElement.classList.remove('dark')}else{document.documentElement.classList.add('dark')}}catch(e){document.documentElement.classList.add('dark')}`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
