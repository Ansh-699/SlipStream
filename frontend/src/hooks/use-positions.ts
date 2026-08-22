"use client";

import { startPoll } from "@/lib/poll";
import { useConnection, useWallet } from "@/hooks/use-wallet-compat";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { findPositionPda } from "@/lib/slipstream";
import { PROGRAM_ID, MARKET_INDEX } from "@/lib/manifest";
import {
  SEED_USER,
  DISC_POSITION,
  PRICE_SCALE,
  decodeUserAccount,
  decodePosition,
} from "@/lib/slipstream";

export interface UserData {
  freeCollateral: bigint;
  creditOutstanding: bigint;
  pendingFills: number;
}

export interface PositionData {
  marketIndex: number;
  size: bigint;
  entryPrice: bigint;
  collateral: bigint;
  realizedPnl: bigint;
  isLong: boolean;
  unrealizedPnl: number;
}

export function useUserAccount() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [user, setUser] = useState<UserData | null>(null);

  const fetch = useCallback(async () => {
    if (!publicKey) return;
    try {
      const [pda] = PublicKey.findProgramAddressSync(
        [SEED_USER, publicKey.toBuffer()],
        PROGRAM_ID
      );
      const info = await connection.getAccountInfo(pda);
      if (info) {
        const u = decodeUserAccount(info.data as Buffer);
        setUser({
          freeCollateral: u.freeCollateral,
          creditOutstanding: u.creditOutstanding,
          pendingFills: u.pendingFills,
        });
      }
    } catch {
      // Will retry
    }
  }, [connection, publicKey]);

  useEffect(() => {
    fetch();
    return startPoll(fetch, 5_000);
  }, [fetch]);

  return { user, refresh: fetch };
}

export function usePositions(markPrice: bigint | null) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  // Positions WITHOUT the price-derived field. Pricing happens at render, not
  // at fetch: markPrice used to sit in the fetch's dependency array, so every
  // oracle tick rebuilt `fetch`, re-ran the effect, and fired an immediate
  // getProgramAccounts — while ALSO clearing the startPoll timer before it
  // could fire. With the live feed pushing ~20 prices/second that is ~20
  // unbounded program scans per second instead of one per five seconds, none
  // of them aborted. It is the whole of ERR_INSUFFICIENT_RESOURCES, and it was
  // introduced when this hook was switched from the 5s market mark to the live
  // reference price. The request never needed the price at all.
  const [raw, setRaw] = useState<Omit<PositionData, "unrealizedPnl">[]>([]);

  const fetch = useCallback(async () => {
    if (!publicKey) return;
    try {
      // The Position address is DERIVABLE, so scanning the program for it was
      // never necessary. getProgramAccounts reads every account the program
      // owns — including the 626 KiB order book and every other user's
      // accounts — and applies the memcmp filters node-side afterwards. It was
      // the single most expensive request this app made, it is the shape that
      // returns 429/502 first under load, and the proxy comment at
      // api/rpc/[layer]/route.ts:69-70 names it as how the project burned its
      // RPC quota once already.
      const [positionPda] = findPositionPda(publicKey, MARKET_INDEX, PROGRAM_ID);
      const info = await connection.getAccountInfo(positionPda);
      const accounts = info ? [{ account: info }] : [];

      const result: Omit<PositionData, "unrealizedPnl">[] = [];
      for (const { account } of accounts) {
        if (account.data[0] !== DISC_POSITION) continue;
        const pos = decodePosition(account.data as Buffer);
        if (pos.size === 0n) continue;

        result.push({
          marketIndex: pos.marketIndex,
          size: pos.size,
          entryPrice: pos.entryPrice,
          collateral: pos.collateral,
          realizedPnl: pos.realizedPnl,
          isLong: pos.size > 0n,
        });
      }
      setRaw(result);
    } catch {
      // Will retry
    }
  }, [connection, publicKey]);

  // Price them here instead. Recomputing this on every oracle tick is a cheap
  // pure map over a handful of positions; refetching on every oracle tick was
  // a program scan.
  const positions: PositionData[] = useMemo(
    () =>
      raw.map((p) => {
        let unrealizedPnl = 0;
        if (markPrice) {
          // Mirrors the on-chain compute_unrealized_pnl: size is 9-dp base
          // atoms, so (size * priceDiff) / BASE_SCALE (1e9) yields 6-dp quote
          // PnL; then / PRICE_SCALE (1e6) for a human dollar value.
          const priceDiff = markPrice - p.entryPrice;
          const rawPnl = (p.size * priceDiff) / 1_000_000_000n; // BASE_SCALE
          unrealizedPnl = Number(rawPnl) / PRICE_SCALE;
        }
        return { ...p, unrealizedPnl };
      }),
    [raw, markPrice]
  );

  useEffect(() => {
    fetch();
    return startPoll(fetch, 5_000);
  }, [fetch]);

  return { positions, refresh: fetch };
}
