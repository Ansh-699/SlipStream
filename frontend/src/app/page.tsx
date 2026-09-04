import { LandingView } from "@/components/landing/landing-view";

// ISR rather than per-request: the only server-read values on this page are the
// settlement sequences, which move in minutes. Without this the account reads
// would run on every hit to the site's front door.
export const revalidate = 60;

export default function Home() {
  return <LandingView />;
}
