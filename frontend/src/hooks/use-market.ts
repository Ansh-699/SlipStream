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

  const fetcher = useCallback(async (): Promise<{ market: MarketData | null }> => {
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
    // Wrapped, not bare null. useSharedSource uses `null` to mean "no value
    // yet", so returning bare null here made a genuinely ABSENT market
    // indistinguishable from one that simply had not loaded — collapsing
    // MarketStatus's "missing" into "loading". That is exactly the distinction
    // this file was written to preserve.
    if (!info) return { market: null };
    // decodeMarket validates the discriminator and account size, throwing on a
    // mismatch — so we always get the canonical on-chain layout.
    const m = decodeMarket(info.data as Buffer);
    return { market: {
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
    } };
  }, [marketIndex]);

  const { data, error } = useSharedSource<{ market: MarketData | null }>(key, fetcher, 5_000);

  const market = data?.market ?? null;

  // Four genuinely different states, kept apart:
  //   loading      — no fetch has resolved yet
  //   live         — we hold a market (even if the latest poll just failed;
  //                  a blip must not relabel a good market as broken)
  //   missing      — the RPC answered and the account is absent
  //   unavailable  — we could not reach the chain and have nothing cached
  const status: MarketStatus = market
    ? "live"
    : data
      ? "missing"
      : error
        ? "unavailable"
        : "loading";

  return { market, status, loading: status === "loading" };
}
