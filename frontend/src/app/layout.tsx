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
  title: "Slipstream",
  description: "On-chain perpetual futures CLOB on Solana with MagicBlock Ephemeral Rollups",
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
