import { redirect } from "next/navigation";

// The landing page moved to the root. Kept so any shared /landing link resolves.
export default function LegacyLandingPage() {
  redirect("/");
}
