import { Loader2 } from "lucide-react";

/** Inline loading indicator; inherits the surrounding text colour and size. */
export function Spinner({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return <Loader2 aria-hidden className={`${className} shrink-0 animate-spin`} strokeWidth={2} />;
}
