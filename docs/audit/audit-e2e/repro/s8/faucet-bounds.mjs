// S8 scratch repro (audit-only; never wired into a test suite).
//
// Two claims about frontend/src/app/api/faucet/route.ts.
//
// A) The three limiters PRODUCT.md:60 advertises ("rate-limited per wallet, per
//    IP, and globally") are module-scope JS containers (route.ts:53, :61, :62).
//    Their lifetime is one process. They also fail open on a non-numeric
//    FAUCET_MAX_PER_HOUR: Number("sixty") is NaN and `n >= NaN` is false, so the
//    global cap silently disappears (route.ts:60, :75). Every other faucet env
//    knob fails CLOSED, which is what makes this one an outlier rather than a
//    house style.
//
// B) Cost of one drip to the operator key. A fresh wallet has no ATA and no SOL,
//    so BOTH the ATA rent (route.ts:178-183, operator is the payer) and the SOL
//    top-up (route.ts:191-206, fires because balance 0 < FAUCET_SOL_FLOOR) run on
//    every first-time pubkey — and fresh pubkeys are free to the caller.
//
// Run: node docs/audit/audit-e2e/repro/s8/faucet-bounds.mjs

console.log("=== A) env parsing: which knobs fail open ===");
const knobs = [
  ["FAUCET_MAX_PER_HOUR", "60", (n) => `cap enforced at 1000 drips? ${1000 >= n}`],
  ["FAUCET_MAX_PER_HOUR", "sixty", (n) => `cap enforced at 1000 drips? ${1000 >= n}`],
  ["FAUCET_SOL_AMOUNT", "0.05", (n) => `top-up fires? ${n > 0}`],
  ["FAUCET_SOL_AMOUNT", "abc", (n) => `top-up fires? ${n > 0}`],
  ["FAUCET_SOL_FLOOR", "0.02", (n) => `0-balance wallet below floor? ${0 < n * 1e9}`],
  ["FAUCET_SOL_FLOOR", "abc", (n) => `0-balance wallet below floor? ${0 < n * 1e9}`],
];
for (const [name, raw, effect] of knobs) {
  const n = Number(raw || "60");
  console.log(`  ${name.padEnd(20)} = ${JSON.stringify(raw).padEnd(8)} -> Number() = ${String(n).padEnd(6)} ${effect(n)}`);
}
console.log("  only FAUCET_MAX_PER_HOUR flips a guard OFF when it is unparseable.");

console.log("\n=== A2) limiter lifetime ===");
// Exactly the containers at route.ts:53, :61, :62.
const lastDrip = new Map(), lastDripByIp = new Map(), dripTimes = [];
lastDrip.set("W", Date.now()); lastDripByIp.set("1.2.3.4", Date.now()); dripTimes.push(Date.now());
console.log("  in-process:", { wallets: lastDrip.size, ips: lastDripByIp.size, drips: dripTimes.length });
console.log("  after a restart / a second serverless instance: { wallets: 0, ips: 0, drips: 0 }");
console.log("  frontend/vercel.json:2 declares the Next.js framework preset -> per-invocation");
console.log("  isolates, so nothing durable bounds the faucet in the configured topology.");

console.log("\n=== B) operator cost per first-time pubkey ===");
const ATA_RENT = 2_039_280 / 1e9; // getMinimumBalanceForRentExemption(165), devnet, 2026-08-21
const TOPUP = 0.05;               // FAUCET_SOL_AMOUNT default, route.ts:43
const FEES = 3 * 5_000 / 1e9;     // ~3 signed txs: create ATA, mintTo, transfer
const perDrip = ATA_RENT + TOPUP + FEES;
console.log(`  ATA rent (operator pays) : ${ATA_RENT} SOL`);
console.log(`  SOL top-up               : ${TOPUP} SOL`);
console.log(`  tx fees                  : ${FEES} SOL`);
console.log(`  total per drip           : ${perDrip.toFixed(6)} SOL`);
console.log(`  at the nominal 60/hr cap : ${(perDrip * 60).toFixed(3)} SOL/hr and ${60 * 10_000} test USDC/hr`);
console.log("  ...per process. The cap is not durable (A2), so this is a floor, not a bound.");
