import type { Metadata } from "next";
import { TradingDashboard } from "@/components/trading/dashboard";

export const metadata: Metadata = {
  title: "Trade · Slipstream",
  description:
    "SOL-PERP order book, margin × leverage order entry, positions, and settled fills. Matching runs on the MagicBlock Ephemeral Rollup; collateral stays on Solana L1.",
};

export default function TradePage() {
  return <TradingDashboard />;
}
