"use client";

import dynamic from "next/dynamic";
import { AddressType } from "@phantom/browser-sdk";

// Phantom's button reads browser/extension state on mount, so keep it client-only.
const PhantomConnectButton = dynamic(
  () => import("@phantom/react-sdk").then((mod) => mod.ConnectButton),
  { ssr: false }
);

export function ConnectButton() {
  return <PhantomConnectButton addressType={AddressType.solana} />;
}
