"use client";

import { useEffect, useState } from "react";

/** oracle.rs:22 — the program refuses a price older than this. */
const MAX_STALENESS_SECS = 60;
const WARN_SECS = 45;
/** Wider than the gate so the 60s tick sits inboard and overruns stay visible. */
const TRACK_SECS = 80;

type Tone = "up" | "warn" | "down";

const FILL: Record<Tone, string> = {
  up: "bg-[var(--t-up)]",
  warn: "bg-[var(--t-warn)]",
  down: "bg-[var(--t-down)]",
};
const INK: Record<Tone, string> = {
  up: "text-[var(--t-up)]",
  warn: "text-[var(--t-warn)]",
  down: "text-[var(--t-down)]",
};

export function OracleSweep({ publishTime }: { publishTime: number | null }) {
  // Lazy initializer: Date.now() in render scope is impure and the compiler rejects it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const age = publishTime === null ? null : Math.max(0, Math.floor(now / 1000 - publishTime));
  const tone: Tone | null =
    age === null ? null : age < WARN_SECS ? "up" : age <= MAX_STALENESS_SECS ? "warn" : "down";

  return (
    <span className="inline-flex flex-col gap-1.5">
      <span
        aria-hidden="true"
        className="relative block h-[3px] w-[180px] shrink-0 bg-[var(--t-border)]"
      >
        <span
          suppressHydrationWarning
          className={`absolute inset-0 origin-left transition-transform duration-1000 ease-linear will-change-transform motion-reduce:transition-none ${tone ? FILL[tone] : ""}`}
          style={{ transform: `scaleX(${age === null ? 0 : Math.min(age / TRACK_SECS, 1)})` }}
        />
        <span
          className="absolute inset-y-0 w-px bg-[var(--t-border-strong)]"
          style={{ left: `${(MAX_STALENESS_SECS / TRACK_SECS) * 100}%` }}
        />
      </span>
      <span className="font-mono text-[11px] font-medium tracking-[0.08em] text-[var(--t-text-3)]">
        PYTH{" "}
        <span
          suppressHydrationWarning
          className={`tnum ${tone ? INK[tone] : "text-[var(--t-text-3)]"}`}
        >
          {age === null ? "—" : `+${age}s`}
        </span>{" "}
        / {MAX_STALENESS_SECS}s
      </span>
    </span>
  );
}
