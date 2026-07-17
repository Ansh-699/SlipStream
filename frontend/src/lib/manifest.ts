// Slipstream frontend configuration module.
//
// Resolves the on-chain addresses the frontend needs (program ID, SOL-PERP
// market, and orderbook) from the Deploy_Manifest emitted by scripts/deploy.ts.
//
// Resolution strategy (Requirement 6.2):
//   1. NEXT_PUBLIC_* environment variables, when set (build-time injection).
//   2. The deploy.json manifest copied into the package at build time by
//      scripts/copy-manifest.mjs (see predev/prebuild in package.json).
//
// Missing-manifest handling (Requirement 6.3):
//   If the real deploy.json was not found at build time AND no NEXT_PUBLIC_*
//   override is supplied for a required address, the manifest is considered
//   missing. resolveAddress() throws a descriptive error naming exactly what is
//   missing, and `manifestError` carries a human-readable message that the UI
//   surfaces as a visible banner. A last-known-good fallback keeps the build
//   green in CI without a deploy.json (see scripts/copy-manifest.mjs).

import { PublicKey } from "@solana/web3.js";
import rawManifest from "./deploy-manifest.generated.json";

interface GeneratedManifest {
  network?: string;
  erRpc?: string;
  programId?: string;
  market?: string;
  orderBook?: string;
  usdcMint?: string;
  usdcVault?: string;
  marketIndex?: number;
  /** Market params — string bigints for tick/lot, number for leverage. */
  tickSize?: string;
  lotSize?: string;
  maxLeverage?: number;
  /** false when scripts/copy-manifest.mjs fell back because deploy.json was absent. */
  __manifestPresent__?: boolean;
}

const manifest = rawManifest as GeneratedManifest;

/** True iff a real deploy.json was found and copied at build time. */
export const MANIFEST_PRESENT = manifest.__manifestPresent__ === true;

const ENV = {
  programId: process.env.NEXT_PUBLIC_PROGRAM_ID,
  market: process.env.NEXT_PUBLIC_MARKET,
  orderBook: process.env.NEXT_PUBLIC_ORDER_BOOK,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,
  erRpc: process.env.NEXT_PUBLIC_ER_RPC,
};

/**
 * Resolve a required address from the env override or the manifest, then verify
 * it is a valid base58 Solana public key. Throws a descriptive error that names
 * the missing field and points at the manifest when it cannot be resolved.
 */
function resolveAddress(
  field: "programId" | "market" | "orderBook",
  envName: string,
  envValue: string | undefined,
  manifestValue: string | undefined
): PublicKey {
  const value = envValue ?? manifestValue;

  if (!value) {
    const reason = MANIFEST_PRESENT
      ? `the Deploy_Manifest (deploy.json) has no "${field}" field`
      : `the Deploy_Manifest (deploy.json) is missing`;
    throw new Error(
      `Slipstream config: cannot resolve ${field} — ${reason}. ` +
        `Run scripts/deploy.ts to emit deploy.json, or set ${envName} at build time.`
    );
  }

  try {
    return new PublicKey(value);
  } catch {
    throw new Error(
      `Slipstream config: ${field} value "${value}" is not a valid base58 public key ` +
        `(source: ${envValue ? envName : "deploy.json"}).`
    );
  }
}

/**
 * A descriptive, user-facing message when the manifest is missing and no env
 * overrides were supplied, or `null` when configuration resolved cleanly.
 * Drives the visible error banner in the dashboard (Requirement 6.3).
 */
export const manifestError: string | null = (() => {
  if (MANIFEST_PRESENT) return null;
  // The build wrote a fallback manifest. If every required address is supplied
  // via env, treat config as resolved; otherwise report the missing manifest.
  const allFromEnv = ENV.programId && ENV.market && ENV.orderBook;
  if (allFromEnv) return null;
  return (
    "Deploy manifest not found: deploy.json was absent at build time, so the " +
    "frontend is using last-known-good fallback addresses. Run scripts/deploy.ts " +
    "to emit deploy.json (or set NEXT_PUBLIC_PROGRAM_ID / NEXT_PUBLIC_MARKET / " +
    "NEXT_PUBLIC_ORDER_BOOK) to load live addresses."
  );
})();

export const PROGRAM_ID = resolveAddress(
  "programId",
  "NEXT_PUBLIC_PROGRAM_ID",
  ENV.programId,
  manifest.programId
);

export const MARKET = resolveAddress(
  "market",
  "NEXT_PUBLIC_MARKET",
  ENV.market,
  manifest.market
);

export const ORDER_BOOK = resolveAddress(
  "orderBook",
  "NEXT_PUBLIC_ORDER_BOOK",
  ENV.orderBook,
  manifest.orderBook
);

/** USDC mint + protocol vault (needed for deposit_collateral). Optional: only
 *  present when deploy.json carries them. */
export const USDC_MINT: PublicKey | null = manifest.usdcMint
  ? new PublicKey(manifest.usdcMint)
  : null;

export const USDC_VAULT: PublicKey | null = manifest.usdcVault
  ? new PublicKey(manifest.usdcVault)
  : null;

export const MARKET_INDEX: number = manifest.marketIndex ?? 0;

/** SOL-PERP market params, sourced from the Deploy_Manifest (initialize_market
 *  wrote these). Fall back to the known SOL-PERP defaults so the UI still
 *  renders if a partial manifest omits them. Keep these authoritative — do NOT
 *  hardcode tick/lot/leverage in components. */
export const TICK_SIZE: bigint = manifest.tickSize ? BigInt(manifest.tickSize) : 1_000n;
export const LOT_SIZE: bigint = manifest.lotSize ? BigInt(manifest.lotSize) : 100_000_000n;
export const MAX_LEVERAGE: number = manifest.maxLeverage ?? 20;
/** Human lot size in SOL (LOT_SIZE is 9-dp base atoms). */
export const LOT_SOL: number = Number(LOT_SIZE) / 1e9;

/** Direct upstream RPC URLs (used server-side, and as the source the API proxy
 *  forwards to). The BROWSER does NOT call these directly — calling the
 *  MagicBlock ER cross-origin fails with "Failed to fetch" (CORS). Instead the
 *  browser uses the same-origin /api/rpc/* proxy (see RPC_URL / ER_RPC below). */
export const BASE_RPC_DIRECT: string =
  ENV.rpcUrl ?? manifest.network ?? "https://api.devnet.solana.com";

export const ER_RPC_DIRECT: string =
  ENV.erRpc ?? manifest.erRpc ?? "https://devnet.magicblock.app";

/** Resolve the RPC endpoint the client should use. In the browser we route
 *  through the same-origin Next API proxy (/api/rpc/base|er) to avoid CORS and
 *  add retries; during SSR/prerender (no window) we use the direct upstream. */
function clientRpc(layer: "base" | "er", direct: string): string {
  if (typeof window !== "undefined") {
    return `${window.location.origin}/api/rpc/${layer}`;
  }
  return direct;
}

export const RPC_URL: string = clientRpc("base", BASE_RPC_DIRECT);

export const ER_RPC: string = clientRpc("er", ER_RPC_DIRECT);


/**
 * Build a Solana Explorer URL for a tx signature or account, pointed at the
 * right cluster. ER (MagicBlock) activity isn't on the default devnet index, so
 * we use the custom-cluster form (?cluster=custom&customUrl=<ER RPC>) for ER
 * links and plain devnet for base-layer links.
 *
 * NOTE: we link to the DIRECT upstream RPC (not the same-origin proxy), since
 * the Explorer needs a real reachable RPC URL.
 */
export function explorerTx(signature: string, layer: "base" | "er" = "er"): string {
  if (layer === "er") {
    return `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${encodeURIComponent(
      ER_RPC_DIRECT
    )}`;
  }
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function explorerAddress(address: string, layer: "base" | "er" = "er"): string {
  if (layer === "er") {
    return `https://explorer.solana.com/address/${address}?cluster=custom&customUrl=${encodeURIComponent(
      ER_RPC_DIRECT
    )}`;
  }
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}
