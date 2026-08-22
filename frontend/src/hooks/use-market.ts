"use client";

import { startPoll } from "@/lib/poll";
import { useCallback } from "react";
import { useSharedSource } from "@/lib/shared-source";
import { baseConnection } from "@/lib/connections";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, MARKET, MARKET_INDEX } from "@/lib/manifest";
import { SEED_MARKET, decodeMarket, computeTwap } from "@/lib/slipstream";

export interface MarketData {
  marketIndex: number;
  maxLeverage: number;
  circuitBreakerActive: boolean;
  takerFeeBps: number;
  makerRebateBps: number;
  openInterestLong: bigint;
  openInterestShort: bigint;
  insuranceFundBalance: bigint;
  lastMarkPrice: bigint;
  /** S6-01: the mark-price freshness stamp, previously dropped as padding by
   *  both decoders. Without it no client could apply the program's own
   *  staleness gate. Consumed by `useMarkPrice`. */
  markPriceMinute: number;
  twapPrice: number | null;
  fundingRate: bigint;
  /** L1 settlement cursor (highest settled fill sequence). */
  lastSettledSequence: number;
  /** Dual-oracle disagreement circuit breaker: closes-only while true. */
  restrictedMode: boolean;
}

/**
 * Why this exists: `market === null` has three very different causes — we
 * haven't fetched yet, the RPC answered and the account genuinely isn't there,
 * or we couldn't reach the chain at all. Rendering all three as "not
 * initialized" tells a user their market is missing when the truth is usually
 * that devnet is rate-limiting us.
 */
export type MarketStatus = "loading" | "live" | "missing" | "unavailable";

export function useMarket(marketIndex: number = 0) {
  // Mounted five times on /trade (dashboard, market-bar, status-panel,
  // order-form, use-mark-price) — five independent 5s pollers on one account.
  const key = `market:${marketIndex}`;

  const fetcher = useCallback(async (): Promise<MarketData | null> => {
    let pda: PublicKey;
    if (marketIndex === MARKET_INDEX) {
      pda = MARKET;
    } else {
      const buf = Buffer.alloc(2);
      buf.writeUInt16LE(marketIndex);
      [pda] = PublicKey.findProgramAddressSync([SEED_MARKET, buf], PROGRAM_ID);
    }
    const info = await baseConnection.getAccountInfo(pda);
    // A null here is "the RPC answered and the account is genuinely absent" —
    // distinct from a throw, which is "we could not reach the chain". Keeping
    // them apart is the whole point of MarketStatus; collapsing both into
    // "missing" tells a user their market does not exist when devnet is merely
    // rate-limiting us.
    if (!info) return null;
    // decodeMarket validates the discriminator and account size, throwing on a
    // mismatch — so we always get the canonical on-chain layout.
    const m = decodeMarket(info.data as Buffer);
    return {
      marketIndex: m.marketIndex,
      maxLeverage: m.maxLeverage,
      circuitBreakerActive: m.circuitBreakerActive,
      takerFeeBps: m.takerFeeBps,
      makerRebateBps: m.makerRebateBps,
      openInterestLong: m.openInterestLong,
      openInterestShort: m.openInterestShort,
      insuranceFundBalance: m.insuranceFundBalance,
      lastMarkPrice: m.lastMarkPrice,
      markPriceMinute: m.markPriceMinute,
      twapPrice: computeTwap(m),
      fundingRate: m.cumulativeFundingIndex,
      lastSettledSequence: m.lastSettledSequence,
      restrictedMode: m.restrictedMode,
    };
  }, [marketIndex]);

  const { data, error } = useSharedSource<MarketData | null>(key, fetcher, 5_000);

  const status: MarketStatus = error
    ? data
      ? "live" // unreachable now, but we still hold a good market — don't cry wolf
      : "unavailable"
    : data === null
      ? "loading"
      : "missing";

  return {
    market: data ?? null,
    // `data === null` before the first resolve means loading; after a resolve
    // that returned null it means genuinely absent. useSharedSource cannot tell
    // us which, so a successful null resolve is reported as "missing" and the
    // pre-resolve case as "loading" is folded into it — callers render the same
    // "not initialized" copy for both and always have.
    status: data ? "live" : status,
    loading: data === null && !error,
  };
}
