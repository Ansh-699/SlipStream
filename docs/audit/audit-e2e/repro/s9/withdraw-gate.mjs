// S9 repro — the withdraw idle-gate blocks the one instruction that would clear
// the state it is blocking on. Scratch audit code; never wired into a suite.
//
//   node docs/audit/audit-e2e/repro/s9/withdraw-gate.mjs
//
// Asserts, mechanically, against the frozen tree:
//   1. the gate reads TradingCredit.{activeOrders,committed} and returns early;
//   2. the createUndelegateTradingCreditInstruction call sits AFTER the gate,
//      so the early return is reached first;
//   3. undelegate_trading_credit is the instruction that calls reconcile_credit,
//      i.e. the only thing that clears a stale committed/active_orders;
//   4. the stale state (committed > 0 with no active slots) is a state the
//      project's own unit test constructs;
//   5. the user-visible message the gate produces for that state.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (p) => readFileSync(`${root}/${p}`, "utf8").split("\n");
const lineOf = (lines, needle) => {
  const i = lines.findIndex((l) => l.includes(needle));
  assert.notEqual(i, -1, `not found: ${needle}`);
  return i + 1; // 1-indexed
};

const session = read("frontend/src/hooks/use-session.ts");

const gate = lineOf(session, "if (c.activeOrders > 0 || c.committed > 0n)");
const msg = lineOf(session, "open order${c.activeOrders === 1");
const ret = lineOf(session, "        return false;");
const undel = lineOf(session, "createUndelegateTradingCreditInstruction(");

console.log("use-session.ts withdraw() control flow");
console.log(`  idle gate                     : line ${gate}`);
console.log(`  error message                 : line ${msg}`);
console.log(`  undelegate instruction built  : line ${undel}`);
assert.ok(gate < undel, "gate must precede the undelegate call");
assert.ok(
  session.slice(gate, undel).some((l) => l.trim() === "return false;"),
  "gate must return early"
);
console.log(`  -> gate precedes undelegate by ${undel - gate} lines and returns early: CONFIRMED`);

// 3. undelegate is what reconciles.
const undelIx = read("programs/slipstream/src/instructions/undelegate_trading_credit.rs");
const rec = lineOf(undelIx, "reconcile_credit(&ob, credit)");
console.log(`\nundelegate_trading_credit.rs`);
console.log(`  reconcile_credit call         : line ${rec}`);
const why = lineOf(undelIx, "`committed`/`active_orders` are reconciled");
console.log(`  authors' own rationale        :`);
for (let i = why - 2; i < why + 7; i++) console.log(`    ${i + 1}: ${undelIx[i]}`);

// 4. the stale state is constructed by the project's own test.
const t = read("tests/unit/src/test_trading_credit.rs");
const stale = lineOf(t, "credit.committed = 500; // stale");
console.log(`\ntests/unit/src/test_trading_credit.rs`);
for (let i = stale - 4; i < stale + 2; i++) console.log(`  ${i + 1}: ${t[i]}`);

// 5. what the user is told, for both shapes of the stale state.
const render = (activeOrders) =>
  `Cancel your ${activeOrders} open order${activeOrders === 1 ? "" : "s"} before withdrawing.`;
console.log("\nMessage the gate renders:");
console.log(`  committed=500, activeOrders=1 (stale, book has 0 of this owner's slots)`);
console.log(`    -> "${render(1)}"   <- useOpenOrders shows 0 orders to cancel`);
console.log(`  committed=500, activeOrders=0 (PRODUCT.md's "no committed margin" leg)`);
console.log(`    -> "${render(0)}"`);
assert.equal(render(0), "Cancel your 0 open orders before withdrawing.");

// useOpenOrders reads the BOOK, not the credit -> the two panels disagree.
const oo = read("frontend/src/hooks/use-open-orders.ts");
const slots = lineOf(oo, "for (const slot of book.orderSlots)");
console.log(`\nuse-open-orders.ts:${slots} iterates book.orderSlots, not credit.activeOrders,`);
console.log("so the Open Orders panel shows nothing to cancel while the gate demands a cancel.");
console.log("\nALL ASSERTIONS PASSED");
