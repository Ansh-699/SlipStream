"use client";

import dynamic from "next/dynamic";
import { AddressType } from "@phantom/browser-sdk";

// Phantom's button reads browser/extension state on mount, so keep it client-only.
const PhantomConnectButton = dynamic(
  () => import("@phantom/react-sdk").then((mod) => mod.ConnectButton),
  { ssr: false }
);

export function ConnectButton() {
  // Wrapped so globals.css can reach the vendor button: it hardcodes
  // white-on-translucent-grey via inline styles, which disappears on the light
  // canvas and can only be overridden with !important.
  return (
    <span className="phantom-connect">
      <PhantomConnectButton addressType={AddressType.solana} />
    </span>
  );
}
