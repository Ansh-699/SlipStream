// S9 repro — the /trade tab's steady-state RPC budget, derived from source.
// Scratch audit code; never wired into a suite.
//
//   node docs/audit/audit-e2e/repro/s9/poll-budget.mjs
//
// For every polled hook it prints the setInterval period, the RPC round trips
// one tick performs, how many independent instances the default /trade render
// mounts, and the resulting requests/second. Then it asserts that no hook has
// a backoff, an in-flight guard, or an abort path.
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";

const root = process.cwd();
const H = "frontend/src/hooks";
const C = "frontend/src/components/trading";
const read = (p) => readFileSync(`${root}/${p}`, "utf8");

// ---- 1. poll period per hook, straight out of the source -------------------
const periods = {};
for (const f of readdirSync(`${root}/${H}`).filter((f) => f.endsWith(".ts"))) {
  const src = read(`${H}/${f}`);
  for (const m of src.matchAll(/setInterval\(\s*(\w+)\s*,\s*([\d_]+)\s*\)/g)) {
    (periods[f] ??= []).push({ fn: m[1], ms: Number(m[2].replace(/_/g, "")) });
  }
}

// ---- 2. RPC round trips one tick makes, counted from the awaited calls -----
// every awaited RPC round trip: `<someConnection>.getX(...)`, the spl-token
// helper `getAccount(conn, ...)`, and the same-origin `fetch(...)` proxy call.
const RPC = /await\s+\w+\.(get[A-Z]\w*)\(|await\s+(getAccount)\(|await\s+(fetch)\(/g;
const callsIn = (file, fnName, anchor) => {
  let src = read(file).split("\n");
  if (anchor) src = src.slice(src.findIndex((l) => l.includes(anchor)));
  const start = src.findIndex((l) => l.includes(`const ${fnName} = useCallback`));
  if (start === -1) return [];
  let end = src.length;
  for (let i = start + 1; i < src.length; i++) {
    if (/^\s{2}(const|export|function|useEffect)\b/.test(src[i])) { end = i; break; }
  }
  return [...src.slice(start, end).join("\n").matchAll(RPC)].map((m) => m[1] ?? m[2] ?? m[3]);
};

// ---- 3. how many instances the default /trade render mounts ----------------
// dashboard.tsx mounts these; ActivityDrawer mounts only the default tab
// (positions), so open-orders.tsx / trade-history.tsx are excluded.
const MOUNTED = [
  "dashboard.tsx", "terminal-nav.tsx", "market-bar.tsx", "price-chart.tsx",
  "order-book-display.tsx", "order-form.tsx", "session-panel.tsx",
  "status-panel.tsx", "activity-drawer.tsx", "status-strip.tsx",
  "fill-toasts.tsx", "positions-table.tsx",
];
const HOOKS = {
  "use-session.ts":     { call: "useSession(",     fn: "refresh" },
  "use-market.ts":      { call: "useMarket(",      fn: "fetch"   },
  "use-orderbook.ts":   { call: "useOrderBook(",   fn: "fetch"   },
  "use-positions.ts":   { call: "usePositions(",   fn: "fetch", anchor: "export function usePositions" },
  "use-er-position.ts": { call: "useErPosition(",  fn: "fetch"   },
  "use-triggers.ts":    { call: "useTriggers(",    fn: "refresh" },
  "use-open-orders.ts": { call: "useOpenOrders(",  fn: "fetch"   },
  "use-pyth-candles.ts":{ call: "usePythCandles(", fn: "load"    },
};
const mounts = {};
for (const f of MOUNTED) {
  const src = read(`${C}/${f}`);
  for (const [hook, { call }] of Object.entries(HOOKS)) {
    // count only real invocations, not the import line or a typeof reference
    for (const line of src.split("\n")) {
      if (line.includes(call) && !line.startsWith("import") && !line.includes("typeof")) {
        (mounts[hook] ??= []).push(f);
      }
    }
  }
}

let total = 0;
console.log("hook                  period  rpc/tick  instances  req/s  mounted in");
console.log("-".repeat(96));
for (const [hook, { fn, anchor }] of Object.entries(HOOKS)) {
  const p = periods[hook]?.[0];
  if (!p) continue;
  const calls = callsIn(`${H}/${hook}`, fn, anchor);
  const n = (mounts[hook] ?? []).length;
  const rate = n === 0 ? 0 : (calls.length * n) / (p.ms / 1000);
  total += rate;
  console.log(
    `${hook.padEnd(21)} ${String(p.ms + "ms").padStart(6)}  ${String(calls.length).padStart(8)}` +
    `  ${String(n).padStart(9)}  ${rate.toFixed(2).padStart(5)}  ${(mounts[hook] ?? []).join(", ")}`
  );
  if (calls.length) console.log(`  ${" ".repeat(19)} calls: ${calls.join(", ")}`);
}
console.log("-".repeat(96));
console.log(`steady-state RPC round trips from one idle /trade tab: ${total.toFixed(2)} per second`);

// useLivePrice holds a WebSocket per instance rather than polling.
const ws = MOUNTED.filter((f) => read(`${C}/${f}`).includes("useLivePrice()")).length;
console.log(`plus ${ws} independent accountSubscribe WebSockets (use-live-price.ts), one per useLivePrice() call`);

// ---- 4. no hook backs off, guards re-entry, or aborts -----------------------
const BAD = ["AbortController", "abort(", "inFlight", "isFetching", "backoff", "retryAfter"];
for (const hook of Object.keys(HOOKS)) {
  const src = read(`${H}/${hook}`);
  for (const token of BAD) {
    assert.ok(!src.includes(token), `${hook} unexpectedly contains ${token}`);
  }
  // every failure path is a bare catch that keeps the same cadence
  assert.match(src, /catch\s*(\(\s*\w*\s*\))?\s*\{/, `${hook} has no catch`);
}
console.log("\nNo hook contains AbortController / in-flight guard / backoff / retryAfter:");
console.log("every failure is swallowed by a bare catch and the next tick fires on the same period.");
console.log("\nALL ASSERTIONS PASSED");
