"use client";

import { startPoll } from "@/lib/poll";
import { useConnection, useWallet } from "@/hooks/use-wallet-compat";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { PROGRAM_ID } from "@/lib/manifest";
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
      const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
        filters: [
          // getProgramAccounts memcmp `bytes` decodes as base58 by default (no
          // `encoding` field here); base64 isn't valid base58, so this filter
          // used to throw and get silently swallowed by the catch below, making
          // every wallet's positions look empty regardless of actual state.
          { memcmp: { offset: 0, bytes: bs58.encode([DISC_POSITION]) } },
          { memcmp: { offset: 8, bytes: publicKey.toBase58() } },
        ],
      });

      const result: Omit<PositionData, "unrealizedPnl">[] = [];
      for (const { account } of accounts) {
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
