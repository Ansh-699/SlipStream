#!/usr/bin/env tsx

/**
 * Property 2 — Manifest well-formedness  (spec task 6.2)
 * ======================================================
 *
 * Property (design.md "Correctness Properties / Property 2"):
 *
 *   For ANY Deploy_Manifest produced by the Bootstrap_Script, every address
 *   field SHALL parse as a valid base58 Solana public key (constructing a
 *   `PublicKey` from it does not throw), AND every numeric-as-string field
 *   (`tickSize`, `lotSize`) SHALL round-trip without precision loss
 *   (`BigInt(String(value)) === value`).
 *
 *   Validates: Requirements 5.4, 5.5
 *
 * This is one of the two genuine universal properties in the spec, so it is
 * implemented as a property-based test with fast-check:
 *
 *   1. GENERATED MANIFESTS — fast-check synthesises DeployManifest-shaped
 *      objects whose address fields are real, randomly-derived Solana public
 *      keys and whose tickSize/lotSize come from arbitrary (possibly huge,
 *      beyond Number.MAX_SAFE_INTEGER) bigints stringified into the manifest.
 *      The well-formedness predicate is asserted across ~100 iterations.
 *
 *   2. REAL ARTIFACT — the ACTUAL emitted ../../../deploy.json is loaded and
 *      the same predicate is asserted against it, so the test validates the
 *      real deployed artifact, not just synthetic data.
 *
 * Run (fully offline, no SOL required):
 *   npx tsx manifest_wellformedness.test.ts
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import * as fc from "fast-check";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// DeployManifest shape (design.md "Core Interfaces/Types").
// ---------------------------------------------------------------------------
interface DeployManifest {
  network: string;
  erRpc: string;
  programId: string;
  authority: string;
  globalState: string;
  market: string;
  orderBook: string;
  usdcMint: string;
  usdcVault: string;
  pythFeed: string;
  switchboardFeed: string;
  marketIndex: number;
  tickSize: string;
  lotSize: string;
  maxLeverage: number;
  deployedAt: string;
}

/** Every field that MUST parse as a valid base58 Solana public key (Req 5.4). */
const ADDRESS_FIELDS = [
  "programId",
  "authority",
  "globalState",
  "market",
  "orderBook",
  "usdcMint",
  "usdcVault",
  "pythFeed",
  "switchboardFeed",
] as const;

/** Every numeric-as-string field that MUST round-trip via BigInt (Req 5.5). */
const NUMERIC_STRING_FIELDS = ["tickSize", "lotSize"] as const;

const NUM_RUNS = 100;
const REPO_ROOT_MANIFEST = path.resolve(__dirname, "../../../deploy.json");

// ---------------------------------------------------------------------------
// The well-formedness predicate (the formal statement of Property 2).
//
// Returns the list of violations; an empty list means the manifest satisfies
// Property 2. We collect ALL violations (rather than throwing on the first) so
// failure reports — for both generated counterexamples and the real artifact —
// pinpoint every offending field.
// ---------------------------------------------------------------------------
function wellFormednessViolations(m: DeployManifest): string[] {
  const violations: string[] = [];

  // Req 5.4 — every address field parses as a valid base58 Solana public key
  // (constructing a PublicKey from it does not throw).
  for (const field of ADDRESS_FIELDS) {
    const value = (m as any)[field];
    try {
      // Guard against the lenient PublicKey(number[]) / Buffer paths: the
      // manifest stores base58 STRINGS, so a non-string is itself a violation.
      if (typeof value !== "string") {
        violations.push(`${field}: expected base58 string, got ${typeof value}`);
        continue;
      }
      // eslint-disable-next-line no-new
      new PublicKey(value);
    } catch (e: any) {
      violations.push(`${field}="${value}" did not parse as a PublicKey (${e?.message ?? e})`);
    }
  }

  // Req 5.5 — tickSize/lotSize round-trip without precision loss. The manifest
  // stores them as decimal strings; parsing to BigInt and re-stringifying MUST
  // be the identity (no precision loss, no lossy Number coercion).
  for (const field of NUMERIC_STRING_FIELDS) {
    const value = (m as any)[field];
    if (typeof value !== "string") {
      violations.push(`${field}: expected decimal string, got ${typeof value}`);
      continue;
    }
    try {
      const parsed = BigInt(value);
      if (String(parsed) !== value) {
        violations.push(`${field}="${value}" did not round-trip (BigInt->String = "${String(parsed)}")`);
      }
    } catch (e: any) {
      violations.push(`${field}="${value}" is not a valid BigInt (${e?.message ?? e})`);
    }
  }

  return violations;
}

function assertWellFormed(m: DeployManifest, context: string): void {
  const violations = wellFormednessViolations(m);
  if (violations.length > 0) {
    throw new Error(`${context} violates Property 2:\n  - ${violations.join("\n  - ")}`);
  }
}

// ---------------------------------------------------------------------------
// Generators (smart, constrained to the DeployManifest input space).
// ---------------------------------------------------------------------------

/**
 * A valid Solana public-key string, derived deterministically from fast-check's
 * own 32-byte seed. Deriving from the seed (rather than Keypair.generate())
 * keeps generated addresses tied to fast-check's data so any counterexample is
 * reproducible/shrinkable, while still producing genuine on-curve-agnostic
 * base58 pubkeys exactly as deploy.ts would emit.
 */
const arbAddress: fc.Arbitrary<string> = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((seed) => Keypair.fromSeed(seed).publicKey.toBase58());

/**
 * A non-negative bigint covering the full manifest range, including values far
 * beyond Number.MAX_SAFE_INTEGER (2^53) where naive Number-based JSON handling
 * would silently lose precision — the exact failure Req 5.5 guards against.
 */
const arbScaledBigInt: fc.Arbitrary<bigint> = fc.bigInt({ min: 0n, max: 2n ** 128n });

/** A DeployManifest-shaped object plus the ORIGINAL bigints used to build it. */
const arbManifest: fc.Arbitrary<{ manifest: DeployManifest; tick: bigint; lot: bigint }> =
  fc
    .record({
      programId: arbAddress,
      authority: arbAddress,
      globalState: arbAddress,
      market: arbAddress,
      orderBook: arbAddress,
      usdcMint: arbAddress,
      usdcVault: arbAddress,
      pythFeed: arbAddress,
      switchboardFeed: arbAddress,
      tick: arbScaledBigInt,
      lot: arbScaledBigInt,
      marketIndex: fc.nat({ max: 1024 }),
      maxLeverage: fc.integer({ min: 1, max: 100 }),
    })
    .map((r) => ({
      tick: r.tick,
      lot: r.lot,
      manifest: {
        network: "https://api.devnet.solana.com",
        erRpc: "https://devnet.magicblock.app",
        programId: r.programId,
        authority: r.authority,
        globalState: r.globalState,
        market: r.market,
        orderBook: r.orderBook,
        usdcMint: r.usdcMint,
        usdcVault: r.usdcVault,
        pythFeed: r.pythFeed,
        switchboardFeed: r.switchboardFeed,
        marketIndex: r.marketIndex,
        // The manifest stores stringified bigints (preserve precision in JSON).
        tickSize: String(r.tick),
        lotSize: String(r.lot),
        maxLeverage: r.maxLeverage,
        deployedAt: new Date().toISOString(),
      },
    }));

// ===========================================================================
// Main
// ===========================================================================
function main(): void {
  console.log("\n=== Property 2 — Manifest well-formedness (task 6.2) ===\n");
  console.log("Library: fast-check");
  console.log(`Iterations (numRuns): ${NUM_RUNS}\n`);

  let generatedRuns = 0;

  // -------------------------------------------------------------------------
  // PART 1 — Property over generated DeployManifest-shaped objects.
  // -------------------------------------------------------------------------
  fc.assert(
    fc.property(arbManifest, ({ manifest, tick, lot }) => {
      generatedRuns += 1;

      // (a) Req 5.4 + 5.5: the manifest must satisfy the well-formedness predicate.
      const violations = wellFormednessViolations(manifest);
      if (violations.length > 0) {
        throw new Error(`generated manifest violated Property 2: ${violations.join("; ")}`);
      }

      // (b) The exact round-trip stated in the property/task:
      //     BigInt(String(value)) === value  for the ORIGINAL bigints.
      if (BigInt(String(tick)) !== tick) return false;
      if (BigInt(String(lot)) !== lot) return false;

      // (c) Every generated address truly constructs a PublicKey AND survives a
      //     base58 -> bytes -> base58 round-trip (defensive, beyond the predicate).
      for (const field of ADDRESS_FIELDS) {
        const v = (manifest as any)[field] as string;
        const pk = new PublicKey(v);
        if (pk.toBase58() !== v) return false;
      }
      return true;
    }),
    { numRuns: NUM_RUNS }
  );

  console.log(`[generated] PASS — ${generatedRuns} generated manifests all well-formed`);
  console.log(
    "            (every address PublicKey-parses; tickSize/lotSize round-trip via BigInt,\n" +
      "             including values beyond Number.MAX_SAFE_INTEGER)\n"
  );

  // -------------------------------------------------------------------------
  // PART 2 — The REAL emitted artifact: ../../../deploy.json.
  // -------------------------------------------------------------------------
  console.log(`[real artifact] validating ${REPO_ROOT_MANIFEST}`);
  let raw: string;
  try {
    raw = fs.readFileSync(REPO_ROOT_MANIFEST, "utf-8");
  } catch (e: any) {
    throw new Error(
      `[real artifact] could not read deploy.json at ${REPO_ROOT_MANIFEST} (${e?.message ?? e}). ` +
        `Run the bootstrap deploy (scripts/deploy.ts) first.`
    );
  }
  const real = JSON.parse(raw) as DeployManifest;

  // Echo the fields under test so the validation is auditable, not opaque.
  for (const field of ADDRESS_FIELDS) {
    console.log(`  ${field} = ${(real as any)[field]}`);
  }
  for (const field of NUMERIC_STRING_FIELDS) {
    console.log(`  ${field} = "${(real as any)[field]}"`);
  }

  assertWellFormed(real, "[real artifact] deploy.json");
  console.log("\n[real artifact] PASS — emitted deploy.json is well-formed\n");

  console.log("=== Property 2 RESULT: PASS ===");
  console.log(`  generated manifests : ${generatedRuns}/${NUM_RUNS} well-formed`);
  console.log("  real deploy.json    : well-formed");
}

try {
  main();
  process.exit(0);
} catch (err: any) {
  console.error("\n=== Property 2 RESULT: FAIL ===");
  console.error(err?.message ?? err);
  process.exit(1);
}
