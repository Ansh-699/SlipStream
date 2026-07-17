import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { PROGRAM_ID } from "../../../client/src/constants";
import {
  findMarketPda,
  findOrderBookPda,
  findVaultAuthorityPda,
} from "../../../client/src/pda";
import { log } from "./connection";
import { PYTH_SOL_USD_FEED } from "./pyth";

/**
 * Shared loader for the Deploy_Manifest (`deploy.json`) emitted by
 * `scripts/deploy.ts`. Keepers resolve their live addresses (program ID,
 * market, orderbook, vault) from this manifest instead of hard-coded constants
 * (Requirement 6.1).
 *
 * Two distinct failure behaviors are implemented:
 *  - Req 6.3 (MISSING manifest): a hard, descriptive error naming the path that
 *    was tried. The keeper cannot start without the manifest.
 *  - Req 6.4 (per-address resolution failure): a soft, per-field fallback. If
 *    the manifest is present but a specific address is absent or not valid
 *    base58, the keeper continues with its configured fallback (the PDA derived
 *    from the client SDK, or the program-ID constant) and logs the fallback.
 *
 * The manifest path is resolvable via the `DEPLOY_MANIFEST` env var with a
 * sensible default pointing at the repo-root `deploy.json` (kept consistent with
 * how `connection.ts` reads `BASE_RPC`/`ER_RPC` from env).
 */

// Default points at the repo-root deploy.json. `__dirname` differs between the
// tsx (src/shared) and compiled (dist/src/shared) layouts, so walk upward until
// deploy.json is found instead of hard-coding a ../ depth. Override via
// DEPLOY_MANIFEST.
function findDefaultManifest(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "deploy.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Not found: return the repo-root guess so the "not found at <path>" error
  // names a sensible location.
  return path.resolve(startDir, "../../../deploy.json");
}
const DEFAULT_MANIFEST_PATH = findDefaultManifest(__dirname);

export const MANIFEST_PATH = process.env.DEPLOY_MANIFEST || DEFAULT_MANIFEST_PATH;

/** Shape of the manifest written by scripts/deploy.ts. All fields optional so a
 *  malformed/partial manifest still parses and falls through to 6.4 fallbacks. */
export interface DeployManifest {
  network?: string;
  erRpc?: string;
  programId?: string;
  authority?: string;
  globalState?: string;
  market?: string;
  orderBook?: string;
  usdcMint?: string;
  usdcVault?: string;
  pythFeed?: string;
  switchboardFeed?: string;
  marketIndex?: number;
  tickSize?: string;
  lotSize?: string;
  maxLeverage?: number;
  deployedAt?: string;
}

/** Address fields a keeper may resolve from the manifest. */
type ManifestAddressField =
  | "programId"
  | "market"
  | "orderBook"
  | "usdcVault"
  | "pythFeed";

/** Live addresses a keeper needs at runtime. */
export interface KeeperAddresses {
  programId: PublicKey;
  market: PublicKey;
  orderBook: PublicKey;
  usdcVault: PublicKey;
  pythFeed: PublicKey;
  marketIndex: number;
}

/**
 * Load + parse the Deploy_Manifest.
 *
 * Req 6.3: if the manifest file is missing, throw a descriptive error that
 * identifies the exact path that was tried so the operator knows what to fix.
 */
export function loadManifest(manifestPath: string = MANIFEST_PATH): DeployManifest {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Deploy manifest not found at "${manifestPath}". Run \`tsx scripts/deploy.ts\` ` +
        `to generate it, or set the DEPLOY_MANIFEST env var to the manifest path.`
    );
  }
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf-8");
  } catch (e: any) {
    throw new Error(
      `Failed to read deploy manifest at "${manifestPath}": ${e?.message ?? e}`
    );
  }
  try {
    return JSON.parse(raw) as DeployManifest;
  } catch (e: any) {
    throw new Error(
      `Deploy manifest at "${manifestPath}" is not valid JSON: ${e?.message ?? e}`
    );
  }
}

/**
 * Resolve a single base58 address field from the manifest, falling back to a
 * configured default when the field is missing or fails to parse (Req 6.4).
 * The fallback is always logged so operators can see when a manifest value was
 * not used.
 */
function resolveAddress(
  manifest: DeployManifest,
  field: ManifestAddressField,
  fallback: PublicKey,
  manifestPath: string
): PublicKey {
  const value = manifest[field];
  if (value === undefined || value === null || value === "") {
    log(
      "manifest",
      `field "${field}" missing in ${manifestPath}; using fallback ${fallback.toBase58()}`
    );
    return fallback;
  }
  try {
    return new PublicKey(value);
  } catch {
    log(
      "manifest",
      `field "${field}" ("${value}") in ${manifestPath} is not a valid base58 address; ` +
        `using fallback ${fallback.toBase58()}`
    );
    return fallback;
  }
}

/**
 * Configured fallback for the USDC vault. Unlike the market/orderbook, the vault
 * is a freshly-created token account (not a PDA), so it has no deterministic
 * derivation. The configured fallback is the `USDC_VAULT` env var if set,
 * otherwise the program's vault-authority PDA — a valid PublicKey that keeps the
 * keeper running per Req 6.4.
 */
function defaultVaultFallback(programId: PublicKey): PublicKey {
  const envVault = process.env.USDC_VAULT;
  if (envVault) {
    try {
      return new PublicKey(envVault);
    } catch {
      log(
        "manifest",
        `USDC_VAULT env ("${envVault}") is not valid base58; ignoring`
      );
    }
  }
  return findVaultAuthorityPda(programId)[0];
}

/**
 * Resolve the keeper's live addresses from the Deploy_Manifest (Req 6.1).
 *
 * Behavior:
 *  - Loads the manifest, throwing a descriptive error if it is missing (Req 6.3).
 *  - Resolves each address with a per-field fallback (Req 6.4): programId →
 *    `PROGRAM_ID` constant; market/orderBook → client-SDK PDAs derived from the
 *    resolved programId; usdcVault → `USDC_VAULT` env or the vault-authority PDA.
 */
export function resolveKeeperAddresses(opts?: {
  manifestPath?: string;
  marketIndex?: number;
}): KeeperAddresses {
  const manifestPath = opts?.manifestPath ?? MANIFEST_PATH;

  // Req 6.3: hard error if the manifest is missing.
  const manifest = loadManifest(manifestPath);

  const marketIndex =
    opts?.marketIndex ??
    (typeof manifest.marketIndex === "number" ? manifest.marketIndex : 0);

  // Req 6.4: resolve each field independently with a configured fallback.
  const programId = resolveAddress(manifest, "programId", PROGRAM_ID, manifestPath);
  const market = resolveAddress(
    manifest,
    "market",
    findMarketPda(marketIndex, programId)[0],
    manifestPath
  );
  const orderBook = resolveAddress(
    manifest,
    "orderBook",
    findOrderBookPda(marketIndex, programId)[0],
    manifestPath
  );
  const usdcVault = resolveAddress(
    manifest,
    "usdcVault",
    defaultVaultFallback(programId),
    manifestPath
  );

  // Live SOL/USD Pyth Receiver PriceUpdateV2 feed. Preferred source is the
  // manifest's `pythFeed`; the configured fallback is `PYTH_SOL_USD_FEED` from
  // shared/pyth.ts, which itself honors the PYTH_FEED env override and defaults
  // to the live `7UVi…` feed. This keeps a single source of truth for the live
  // feed and avoids the legacy frozen `PYTH_SOL_USD_DEVNET` constant.
  const pythFeed = resolveAddress(
    manifest,
    "pythFeed",
    PYTH_SOL_USD_FEED,
    manifestPath
  );

  return { programId, market, orderBook, usdcVault, pythFeed, marketIndex };
}

// Cache so repeated lookups (e.g. shared/accounts.ts) don't re-read the file or
// re-log the resolution on every fetch.
let cached: KeeperAddresses | null = null;

/**
 * Resolve + cache the keeper addresses. The manifest is loaded (and validated
 * per Req 6.3/6.4) on first call; subsequent calls return the cached result.
 */
export function getKeeperAddresses(): KeeperAddresses {
  if (cached === null) {
    cached = resolveKeeperAddresses();
  }
  return cached;
}

/** Convenience accessor for the resolved program ID. */
export function getProgramId(): PublicKey {
  return getKeeperAddresses().programId;
}

/** Reset the cached resolution (used in tests). */
export function resetManifestCache(): void {
  cached = null;
}
