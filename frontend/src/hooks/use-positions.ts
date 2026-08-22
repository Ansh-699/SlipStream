"use client";

import { startPoll } from "@/lib/poll";
import { useConnection, useWallet } from "@/hooks/use-wallet-compat";
import { useCallback, useEffect, useState } from "react";
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
  const [positions, setPositions] = useState<PositionData[]>([]);

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

      const result: PositionData[] = [];
      for (const { account } of accounts) {
        const pos = decodePosition(account.data as Buffer);
        if (pos.size === 0n) continue;

        const isLong = pos.size > 0n;

        let unrealizedPnl = 0;
        if (markPrice) {
          // Mirror the on-chain compute_unrealized_pnl: size is 9-dp base atoms,
          // so (size * priceDiff) / BASE_SCALE (1e9) yields 6-dp quote PnL; then
          // divide by PRICE_SCALE (1e6) for a human dollar value.
          const priceDiff = markPrice - pos.entryPrice;
          const rawPnl = (pos.size * priceDiff) / 1_000_000_000n; // BASE_SCALE
          unrealizedPnl = Number(rawPnl) / PRICE_SCALE;
        }

        result.push({
          marketIndex: pos.marketIndex,
          size: pos.size,
          entryPrice: pos.entryPrice,
          collateral: pos.collateral,
          realizedPnl: pos.realizedPnl,
          isLong,
          unrealizedPnl,
        });
      }
      setPositions(result);
    } catch {
      // Will retry
    }
  }, [connection, publicKey, markPrice]);

  useEffect(() => {
    fetch();
    return startPoll(fetch, 5_000);
  }, [fetch]);

  return { positions, refresh: fetch };
}
