// S8 scratch repro (audit-only; never wired into a test suite).
//
// Two claims about frontend/src/app/api/pyth/history/route.ts:
//   A) route.ts:54 interpolates String(lastErr) into the client-visible JSON body.
//      Does that string carry the upstream URL (which PYTH_BENCHMARKS_UPSTREAM may
//      key)? PRODUCT.md forbids echoing raw upstream error text for exactly this
//      reason.
//   B) route.ts:30-32 encodeURIComponent()s `symbol` and `resolution` but NOT
//      `from`/`to`, so those two caller-controlled values are spliced raw into the
//      upstream query string.
//
// Run: node docs/audit/audit-e2e/repro/s8/pyth-history-leak.mjs

const KEYED = "https://benchmarks.example.invalid/v1/shims/tradingview?api-key=SECRET123";

console.log("=== A) what String(lastErr) actually contains ===");

// A1 — DNS failure (the shape of a misconfigured or down upstream).
try {
  await fetch(`${KEYED}/history?symbol=x`, { signal: AbortSignal.timeout(5_000) });
} catch (e) {
  const s = String(e);
  console.log("A1 String(err)            :", s);
  console.log("A1 String(err.cause)      :", String(e.cause));
  console.log("A1 leaks 'SECRET123'?     :", s.includes("SECRET123") || String(e.cause).includes("SECRET123"));
}

// A2 — the same error object rendered the way route.ts:54 renders it.
try {
  await fetch(`${KEYED}/history`, { signal: AbortSignal.timeout(5_000) });
} catch (e) {
  const body = { s: "error", errmsg: `benchmarks proxy failed: ${String(e)}` };
  console.log("A2 client-visible body    :", JSON.stringify(body));
}

console.log("\n=== B) from/to are spliced unencoded into the upstream URL ===");

// Verbatim from route.ts:30-32.
function buildUrl(BASE, symbol, resolution, from, to) {
  return (
    `${BASE}/history?symbol=${encodeURIComponent(symbol)}` +
    `&resolution=${encodeURIComponent(resolution)}&from=${from}&to=${to}`
  );
}

const BASE = "https://benchmarks.pyth.network/v1/shims/tradingview";
const cases = [
  ["benign", "0", "1"],
  ["param injection via &", "0", "1&symbol=Crypto.BTC/USD"],
  ["fragment truncation via #", "0", "1#"],
  ["huge unbounded range", "0", String(2 ** 53 - 1)],
];
for (const [name, from, to] of cases) {
  console.log(`B ${name.padEnd(24)} -> ${buildUrl(BASE, "Crypto.SOL/USD", "60", from, to)}`);
}

// The route never bounds from/to, so the upstream is asked for an arbitrary span.
console.log(
  "\nB no numeric parse, no range bound, no ordering check on from/to:",
  "route.ts:23-28 only checks both are non-empty strings."
);
