"use client";

import dynamic from "next/dynamic";

// Redirect target for Google/Apple sign-in. ConnectBox finishes the OAuth
// handoff and stores the session; this URL must be allowlisted in the Phantom
// Portal app settings or the redirect is rejected.
const ConnectBox = dynamic(
  () => import("@phantom/react-sdk").then((mod) => mod.ConnectBox),
  { ssr: false }
);

export default function AuthCallbackPage() {
  return (
    <main className="app-bg min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="panel-title">Finishing sign-in</h1>
        <ConnectBox maxWidth="420px" transparent />
      </div>
    </main>
  );
}
