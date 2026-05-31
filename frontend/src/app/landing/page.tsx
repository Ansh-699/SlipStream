import type { Metadata } from "next";
import { LandingView } from "./landing-view";

export const metadata: Metadata = {
  title: "Slipstream",
  description:
    "A perpetual-futures CLOB on Solana. Sub-second order matching on MagicBlock Ephemeral Rollups; collateral and settlement secured on Solana L1.",
};

export default function LandingPage() {
  return <LandingView />;
}
