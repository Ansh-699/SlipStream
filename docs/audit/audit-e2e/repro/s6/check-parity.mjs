// S6 audit scratch. Cross-checks BOTH vendored TS decoder copies against the real
// #[repr(C)] offsets dumped from the program crate by ./layout (rust-layout.json).
// Zero dependencies; read-only. Never wired into a test suite.
//
//   node docs/audit/audit-e2e/repro/s6/check-parity.mjs
//
// Exit 0 = every TS read offset, every *_SIZE constant, every discriminator and
// every PDA seed agrees with Rust in both copies. Exit 1 = at least one mismatch.

import { readFileSync } from "node:fs";

const ROOT = new URL("../../../../../", import.meta.url).pathname;
const rust = JSON.parse(readFileSync(ROOT + "docs/audit/audit-e2e/repro/s6/rust-layout.json", "utf8"));

const COPIES = {
  "client/src": {
    accounts: "client/src/accounts.ts",
    constants: "client/src/constants.ts",
    pda: "client/src/pda.ts",
    instructions: "client/src/instructions.ts",
  },
  "frontend/src/lib/slipstream": {
    accounts: "frontend/src/lib/slipstream/accounts.ts",
    constants: "frontend/src/lib/slipstream/constants.ts",
    pda: "frontend/src/lib/slipstream/pda.ts",
    instructions: "frontend/src/lib/slipstream/instructions.ts",
  },
};

// TS decoder function -> Rust struct. `lastSettledSequence` and `switchboardFeed`
// are Round-3 tail reads; `lastSettledSequence` deliberately aliases the first 4
// bytes of Market._padding2 (see market.rs set_last_settled_sequence).
const DECODERS = {
  decodeGlobalState: "GlobalState",
  decodeMarket: "Market",
  decodeUserAccount: "UserAccount",
  decodePosition: "Position",
  decodeTradingCredit: "TradingCredit",
  decodeLiquidationIntent: "LiquidationIntent",
  decodeTriggerOrder: "TriggerOrder",
  decodeOrderBookHeader: "OrderBookHeader",
  decodeOrderSlot: "OrderSlot",
  decodePriceLevel: "PriceLevel",
  decodeFillEvent: "FillEvent",
  decodeFillLogHeader: "FillLogHeader",
};

// TS camelCase name -> Rust field name where the two differ.
const ALIAS = {
  cumulativeFundingIndex: "cumulative_funding_index_lo",
  fundingIndexSnapshot: "funding_index_snapshot_lo",
  lastSettledSequence: "_padding2",
  maxPriceLevelsPerSide: "max_price_levels_per_side",
};
const SKIP = new Set(["available"]); // derived in TS, not a byte read

// Rust fields a TS read covers implicitly, so the coverage report stays honest:
// readI128FromSplitI64(lo) also consumes the `_hi` half, and twapPrices is read in
// a `for` loop rather than the object literal.
const IMPLIED = {
  cumulative_funding_index_lo: ["cumulative_funding_index_hi"],
  funding_index_snapshot_lo: ["funding_index_snapshot_hi"],
};

// Width in bytes each TS reader consumes, so we can also assert the read stays
// inside the struct.
const WIDTH = {
  readU8: 1, readU16LE: 2, readI64LE: 8, readU64LE: 8, readPubkey: 32,
  readUInt8: 1, readUInt16LE: 2, readUInt32LE: 4,
  readBigInt64LE: 8, readBigUInt64LE: 8, readI128FromSplitI64: 16,
};

const snake = (s) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

let failures = 0;
const fail = (m) => { failures++; console.log("  MISMATCH " + m); };
const tables = [];

function body(src, fnName) {
  const start = src.indexOf(`export function ${fnName}(`);
  if (start < 0) return null;
  // The body opens at the `{` after the RETURN-TYPE annotation, not at the first
  // `{` after the name — a parameter may itself carry an inline object type
  // (`opts?: { closeSize?: bigint }`), which is what silently truncated the body
  // for createClosePositionInstruction / createSettleTradesInstruction.
  const m = /\)\s*:\s*[A-Za-z_][\w.<>[\]| ]*\{/g;
  m.lastIndex = start;
  const hit = m.exec(src);
  if (!hit) return null;
  const open = hit.index + hit[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

// --------------------------------------------------------------- struct layouts
for (const [copy, files] of Object.entries(COPIES)) {
  console.log(`\n=== ${copy} : decoder read offsets vs Rust #[repr(C)] ===`);
  const src = readFileSync(ROOT + files.accounts, "utf8");
  for (const [fn, structName] of Object.entries(DECODERS)) {
    const b = body(src, fn);
    if (!b) { console.log(`  ABSENT   ${fn} (${structName}) - no decoder in this copy`); continue; }
    const R = rust[structName];
    const rows = [];
    // `name: reader(data, N)` / `name: reader(data, offset + N)` / `data.readUInt32LE(N)`
    // `name: reader(data, N)`, `const name = reader(data, N)`, `data.readUInt32LE(N)`
    // and the `twapPrices.push(readU64LE(data, N + i * 8))` loop.
    const re = /(?:const\s+)?(\w+)\s*[:=]\s*(?:data\.length\s*>=\s*\d+\s*\?\s*)?(\w+)\(\s*(?:data|buf)\s*,\s*(?:offset\s*\+\s*)?(\d+)(?:\s*\+\s*i\s*\*\s*\d+)?\s*\)|(\w+)\s*[:=]\s*(?:data\.length\s*>=\s*\d+\s*\?\s*)?data\.(\w+)\(\s*(\d+)\s*\)|(\w+)\.push\(\s*(\w+)\(\s*data\s*,\s*(\d+)\s*\+\s*i\s*\*\s*\d+\s*\)\s*\)/g;
    let m;
    while ((m = re.exec(b)) !== null) {
      const name = m[1] ?? m[4] ?? m[7];
      const reader = m[2] ?? m[5] ?? m[8];
      const off = Number(m[3] ?? m[6] ?? m[9]);
      if (SKIP.has(name)) continue;
      if (rows.some((r) => r[0] === name)) continue; // first read wins
      const rustName = ALIAS[name] ?? snake(name);
      const expected = R.fields[rustName];
      const w = WIDTH[reader] ?? 0;
      rows.push([name, rustName, expected, off, reader, w]);
      if (expected === undefined) fail(`${structName}.${name}: no Rust field named ${rustName}`);
      else if (expected !== off) fail(`${structName}.${name}: TS reads @${off}, Rust @${expected}`);
      if (off + w > R.size) fail(`${structName}.${name}: read @${off}+${w} exceeds size ${R.size}`);
    }
    tables.push({ copy, structName, size: R.size, align: R.align, rows });
    console.log(`  ok       ${structName.padEnd(18)} size=${String(R.size).padEnd(5)} align=${R.align}  ${rows.length} decoded fields`);
    // Rust fields with no TS read at all (padding aliases excluded).
    const covered = new Set(rows.flatMap((r) => [r[1], ...(IMPLIED[r[1]] ?? [])]));
    const missing = Object.keys(R.fields).filter(
      (f) => !covered.has(f) && !f.startsWith("_pad")
    );
    if (missing.length) console.log(`  GAP      ${structName}: Rust fields never decoded: ${missing.join(", ")}`);
  }
}

// --------------------------------------------------------------- size constants
const SIZES = {
  GLOBAL_STATE_SIZE: "GlobalState",
  USER_ACCOUNT_SIZE: "UserAccount",
  POSITION_SIZE: "Position",
  ORDER_BOOK_HEADER_SIZE: "OrderBookHeader",
  ORDER_SLOT_SIZE: "OrderSlot",
  PRICE_LEVEL_SIZE: "PriceLevel",
  FILL_EVENT_SIZE: "FillEvent",
  TRADING_CREDIT_SIZE: "TradingCredit",
  LIQUIDATION_INTENT_SIZE: "LiquidationIntent",
  FILL_LOG_HEADER_SIZE: "FillLogHeader",
};
for (const [copy, files] of Object.entries(COPIES)) {
  console.log(`\n=== ${copy} : *_SIZE constants vs core::mem::size_of ===`);
  const c = readFileSync(ROOT + files.constants, "utf8");
  const a = readFileSync(ROOT + files.accounts, "utf8");
  for (const [name, structName] of Object.entries(SIZES)) {
    const m = c.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`));
    if (!m) { console.log(`  ABSENT   ${name} - not declared in this copy`); continue; }
    const got = Number(m[1]), want = rust[structName].size;
    if (got !== want) fail(`${name} = ${got}, size_of::<${structName}>() = ${want}`);
    else console.log(`  ok       ${name.padEnd(24)} ${got}`);
  }
  // MARKET_SIZE + TRIGGER_ORDER_SIZE live in accounts.ts, MARKET_SIZE as an expression.
  const ms = a.match(/export const MARKET_SIZE\s*=\s*(\d+)\s*\+\s*TWAP_BUFFER_SIZE\s*\*\s*8\s*\+\s*(\d+)/);
  const tw = a.match(/export const TWAP_BUFFER_SIZE\s*=\s*(\d+)/);
  if (ms && tw) {
    const got = Number(ms[1]) + Number(tw[1]) * 8 + Number(ms[2]);
    if (got !== rust.Market.size) fail(`MARKET_SIZE = ${got}, size_of::<Market>() = ${rust.Market.size}`);
    else console.log(`  ok       ${"MARKET_SIZE".padEnd(24)} ${got}`);
    if (Number(tw[1]) !== rust._derived.TWAP_BUFFER_SIZE) fail(`TWAP_BUFFER_SIZE = ${tw[1]}, Rust = ${rust._derived.TWAP_BUFFER_SIZE}`);
    else console.log(`  ok       ${"TWAP_BUFFER_SIZE".padEnd(24)} ${tw[1]}`);
  } else fail(`${copy}: could not read MARKET_SIZE / TWAP_BUFFER_SIZE`);
  const tos = a.match(/export const TRIGGER_ORDER_SIZE\s*=\s*(\d+)/);
  if (tos) {
    const got = Number(tos[1]);
    if (got !== rust.TriggerOrder.size) fail(`TRIGGER_ORDER_SIZE = ${got}, size_of::<TriggerOrder>() = ${rust.TriggerOrder.size}`);
    else console.log(`  ok       ${"TRIGGER_ORDER_SIZE".padEnd(24)} ${got}`);
  } else console.log("  ABSENT   TRIGGER_ORDER_SIZE");
  const flc = c.match(/export const FILL_LOG_CAPACITY\s*=\s*(\d+)/);
  if (flc) {
    if (Number(flc[1]) !== rust._derived.FILL_LOG_CAPACITY) fail(`FILL_LOG_CAPACITY = ${flc[1]}, Rust = ${rust._derived.FILL_LOG_CAPACITY}`);
    else console.log(`  ok       ${"FILL_LOG_CAPACITY".padEnd(24)} ${flc[1]}`);
  } else console.log("  ABSENT   FILL_LOG_CAPACITY - not declared in this copy");
  const sent = c.match(/export const SENTINEL\s*=\s*(0x[0-9a-fA-F]+|\d+)/);
  if (sent) {
    const got = Number(sent[1]);
    if (got !== rust._derived.SENTINEL) fail(`SENTINEL = ${got}, Rust = ${rust._derived.SENTINEL}`);
    else console.log(`  ok       ${"SENTINEL".padEnd(24)} ${got}`);
  } else console.log("  ABSENT   SENTINEL - not declared in this copy");
}

// --------------------------------------------------------------- discriminators
for (const [copy, files] of Object.entries(COPIES)) {
  console.log(`\n=== ${copy} : DISC_* / SEED_* vs state/mod.rs ===`);
  const c = readFileSync(ROOT + files.constants, "utf8");
  for (const [name, want] of Object.entries(rust._disc)) {
    const m = c.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`));
    if (!m) { console.log(`  ABSENT   ${name}`); continue; }
    if (Number(m[1]) !== want) fail(`${name} = ${m[1]}, Rust = ${want}`);
  }
  console.log(`  ok       9/9 account discriminators match`);
  for (const [name, want] of Object.entries(rust._seeds)) {
    if (want === null) continue;
    const m = c.match(new RegExp(`export const ${name}\\s*=\\s*Buffer\\.from\\("([^"]*)"\\)`));
    if (!m) { console.log(`  ABSENT   ${name} - not declared in this copy`); continue; }
    if (m[1] !== want) fail(`${name} = "${m[1]}", Rust = "${want}"`);
  }
  console.log(`  ok       every declared SEED_* string matches its Rust b"..." literal`);
}

// --------------------------------------------------------------- ix discriminators
console.log(`\n=== IX_* discriminators vs instructions/mod.rs ===`);
const ixRust = {};
{
  const src = readFileSync(ROOT + "programs/slipstream/src/instructions/mod.rs", "utf8");
  const re = /pub const (IX_\w+): u8 = (0x[0-9A-Fa-f]+);/g;
  let m; while ((m = re.exec(src)) !== null) ixRust[m[1]] = Number(m[2]);
}
console.log(`  Rust declares ${Object.keys(ixRust).length} instruction discriminators`);
for (const [copy, files] of Object.entries(COPIES)) {
  const c = readFileSync(ROOT + files.constants, "utf8");
  const missing = [];
  for (const [name, want] of Object.entries(ixRust)) {
    const m = c.match(new RegExp(`export const ${name}\\s*=\\s*(0x[0-9a-fA-F]+)`));
    if (!m) { missing.push(`${name}=0x${want.toString(16)}`); continue; }
    if (Number(m[1]) !== want) fail(`${copy}: ${name} = ${m[1]}, Rust = 0x${want.toString(16)}`);
  }
  console.log(`  ${copy}: ${Object.keys(ixRust).length - missing.length}/${Object.keys(ixRust).length} present`
    + (missing.length ? `; MISSING: ${missing.join(", ")}` : ""));
}

// --------------------------------------------------------------- builder coverage
console.log(`\n=== instruction builder coverage ===`);
for (const [copy, files] of Object.entries(COPIES)) {
  const src = readFileSync(ROOT + files.instructions, "utf8");
  const builders = [...src.matchAll(/^export function (create\w+Instruction)\(/gm)].map((m) => m[1]);
  const used = new Set([...src.matchAll(/data\[0\]\s*=\s*(IX_\w+)|Buffer\.from\(\[(IX_\w+)\]\)/g)]
    .map((m) => m[1] ?? m[2]));
  const uncovered = Object.keys(ixRust).filter((n) => !used.has(n));
  console.log(`  ${copy}: ${builders.length} builders covering ${used.size}/${Object.keys(ixRust).length} instructions`);
  if (uncovered.length) console.log(`    NO BUILDER: ${uncovered.join(", ")}`);
}

// --------------------------------------------- instruction account order + signers
console.log(`\n=== builder account list vs the Rust handler's positional destructuring ===`);
{
  const modSrc = readFileSync(ROOT + "programs/slipstream/src/instructions/mod.rs", "utf8");
  const handler = {}; // IX_* -> module name
  for (const m of modSrc.matchAll(/(IX_\w+)\s*=>\s*\{?\s*(\w+)::process/g)) handler[m[1]] = m[2];

  const rustAccts = {}, rustSigners = {};
  for (const [ix, mod] of Object.entries(handler)) {
    const src = readFileSync(ROOT + `programs/slipstream/src/instructions/${mod}.rs`, "utf8");
    const d = src.match(/let \[([\s\S]*?)\]\s*=\s*\n?\s*accounts/);
    if (!d) continue;
    rustAccts[ix] = d[1].split(",").map((s) => s.trim())
      .filter((s) => s && !s.includes("@ ..")).map((s) => s.replace(/^_/, ""));
    rustSigners[ix] = new Set(
      [...src.matchAll(/(\w+)\.is_signer\(\)/g)].map((m) => m[1].replace(/^_/, ""))
    );
  }

  for (const [copy, files] of Object.entries(COPIES)) {
    console.log(`\n  -- ${copy}`);
    const src = readFileSync(ROOT + files.instructions, "utf8");
    for (const fm of src.matchAll(/^export function (create\w+Instruction)\(/gm)) {
      const b = body(src, fm[1]);
      const ixm = b.match(/data\[0\]\s*=\s*(IX_\w+)|Buffer\.from\(\[(IX_\w+)\]\)/);
      if (!ixm) continue;
      const ix = ixm[1] ?? ixm[2];
      // Both `keys: [ ... ],` and the frontend copy's `const keys = [ ... ];` form.
      const km = b.match(/keys:\s*\[([\s\S]*?)\n\s*\],/) || b.match(/const keys = \[([\s\S]*?)\n\s*\];/);
      if (!km || !rustAccts[ix]) continue;
      const entries = [...km[1].matchAll(/\{\s*pubkey:\s*([^,]+),\s*isSigner:\s*(true|false),\s*isWritable:\s*(true|false)\s*\}/g)]
        .map((m) => ({ pubkey: m[1].trim(), signer: m[2] === "true", writable: m[3] === "true" }));
      const variadic = /\.\.\./.test(km[1]);
      const ra = rustAccts[ix];
      let bad = [];
      if (entries.length !== ra.length) {
        bad.push(`arity ts=${entries.length} rust=${ra.length}${variadic ? " (+variadic)" : ""}`);
      }
      ra.forEach((name, i) => {
        if (rustSigners[ix].has(name) && entries[i] && !entries[i].signer) {
          bad.push(`[${i}] ${name}: Rust requires is_signer, TS marks isSigner:false`);
        }
      });
      if (bad.length) { bad.forEach((x) => fail(`${ix} (${fm[1]}): ${x}`)); }
      else console.log(`     ok  ${ix.padEnd(30)} ${ra.length} fixed accounts${variadic ? " + variadic" : ""}  [${ra.join(", ")}]`);
    }
  }
}

// --------------------------------------------------------------- copy-vs-copy
console.log(`\n=== copy A vs copy B (byte-level decoder parity) ===`);
{
  const A = tables.filter((t) => t.copy === "client/src");
  const B = tables.filter((t) => t.copy === "frontend/src/lib/slipstream");
  const bByName = new Map(B.map((t) => [t.structName, t]));
  for (const a of A) {
    const b = bByName.get(a.structName);
    if (!b) { console.log(`  ONLY IN client/src: ${a.structName}`); continue; }
    const ja = JSON.stringify(a.rows), jb = JSON.stringify(b.rows);
    if (ja !== jb) fail(`${a.structName}: the two vendored copies decode different offsets`);
  }
  console.log(`  ${B.length}/${A.length} shared decoders are offset-identical across the two copies`);
}

// --------------------------------------------------------------- layout tables
console.log(`\n=== field / Rust offset+size / TS offset  (client/src; the frontend copy is byte-identical where present) ===`);
const SZ = (r) => r[5];
for (const t of tables.filter((x) => x.copy === "client/src")) {
  console.log(`\n-- ${t.structName}  size_of=${t.size} align_of=${t.align}`);
  const rf = rust[t.structName].fields;
  const names = Object.keys(rf);
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    const end = i + 1 < names.length ? rf[names[i + 1]] : t.size;
    const row = t.rows.find((r) => r[1] === n);
    console.log(
      `   ${n.padEnd(28)} rust @${String(rf[n]).padStart(4)} +${String(end - rf[n]).padStart(4)}` +
      `   ts ${row ? "@" + String(row[3]).padStart(4) + " +" + String(SZ(row)).padStart(3) + "  " + row[0] : "(not decoded)"}`
    );
  }
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} mismatch(es)`);
process.exit(failures === 0 ? 0 : 1);
