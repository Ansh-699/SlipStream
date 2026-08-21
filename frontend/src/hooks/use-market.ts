"use client";

import { useConnection } from "@/hooks/use-wallet-compat";
import { useCallback, useEffect, useState } from "react";
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
  const { connection } = useConnection();
  const [market, setMarket] = useState<MarketData | null>(null);
  const [status, setStatus] = useState<MarketStatus>("loading");
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try {
      let pda: PublicKey;
      if (marketIndex === MARKET_INDEX) {
        // Use the resolved market address from the Deploy_Manifest.
        pda = MARKET;
      } else {
        const buf = Buffer.alloc(2);
        buf.writeUInt16LE(marketIndex);
        [pda] = PublicKey.findProgramAddressSync([SEED_MARKET, buf], PROGRAM_ID);
      }
      const info = await connection.getAccountInfo(pda);
      if (info) {
        // decodeMarket validates the discriminator and account size, throwing
        // on a mismatch — so we always get the canonical on-chain layout.
        const m = decodeMarket(info.data as Buffer);
        setMarket({
          marketIndex: m.marketIndex,
          maxLeverage: m.maxLeverage,
          circuitBreakerActive: m.circuitBreakerActive,
          takerFeeBps: m.takerFeeBps,
          makerRebateBps: m.makerRebateBps,
          openInterestLong: m.openInterestLong,
          openInterestShort: m.openInterestShort,
          insuranceFundBalance: m.insuranceFundBalance,
          lastMarkPrice: m.lastMarkPrice,
          twapPrice: computeTwap(m),
          fundingRate: m.cumulativeFundingIndex,
          lastSettledSequence: m.lastSettledSequence,
          restrictedMode: m.restrictedMode,
        });
        setStatus("live");
      } else {
        // The RPC answered; the account really is absent.
        setStatus("missing");
      }
    } catch {
      // Unreachable or rate-limited. Keep the last good market on screen and
      // retry, but never report this as "not initialized".
      setStatus((prev) => (prev === "live" ? "live" : "unavailable"));
    } finally {
      setLoading(false);
    }
  }, [connection, marketIndex]);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 5_000);
    return () => clearInterval(id);
  }, [fetch]);

  return { market, status, loading, refresh: fetch };
}
