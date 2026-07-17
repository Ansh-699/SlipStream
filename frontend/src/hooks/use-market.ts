"use client";

import { useConnection } from "@solana/wallet-adapter-react";
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
}

export function useMarket(marketIndex: number = 0) {
  const { connection } = useConnection();
  const [market, setMarket] = useState<MarketData | null>(null);
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
        });
      }
    } catch {
      // Will retry on next poll
    } finally {
      setLoading(false);
    }
  }, [connection, marketIndex]);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 5_000);
    return () => clearInterval(id);
  }, [fetch]);

  return { market, loading, refresh: fetch };
}
