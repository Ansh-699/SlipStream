"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useWallet } from "@/hooks/use-wallet-compat";

// Redirect target for Google/Apple sign-in. ConnectBox finishes the OAuth
// handoff and stores the session; this URL must be allowlisted in the Phantom
// Portal app settings or the redirect is rejected.
const ConnectBox = dynamic(
  () => import("@phantom/react-sdk").then((mod) => mod.ConnectBox),
  { ssr: false }
);

export default function AuthCallbackPage() {
  const { connected } = useWallet();
  const router = useRouter();

  // The page used to say "Finishing sign-in" and then finish nothing: on
  // success it just sat there showing the connected address, and on cancel or
  // provider error it showed an empty chooser. Either way the only way out was
  // the back button, which returns to the OAuth provider. Complete the flow
  // ourselves. `replace`, not `push`, so back doesn't land here again and
  // bounce straight back to /trade.
  useEffect(() => {
    if (connected) router.replace("/trade");
  }, [connected, router]);

  return (
    <main className="app-bg min-h-screen flex items-center justify-center p-6">
      <div className="relative z-10 w-full max-w-md space-y-4 text-center">
        <h1 className="panel-title">Finishing sign-in</h1>
        <ConnectBox maxWidth="420px" transparent />
        {/* Permanent, unconditional exit. The cancel/error path renders no
            message of its own, so without this the page is a trap. */}
        <Link
          href="/trade"
          className="inline-block px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Continue to the terminal →
        </Link>
      </div>
    </main>
  );
}
