"use client";

import { useEffect, useState } from "react";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false)
        )
      }
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className="font-mono text-[13px] leading-none text-[var(--t-text-3)] transition-colors hover:text-[var(--t-text)]"
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}
