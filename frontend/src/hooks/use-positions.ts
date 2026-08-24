"use client";

import { startPoll } from "@/lib/poll";
import { useConnection, useWallet } from "@/hooks/use-wallet-compat";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
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
  /**
   * The position's last-realized funding index (18-dp, i128). Needed to price
   * the funding the position has accrued but not yet paid: `collateral` is only
   * debited when something realizes the accrual (settle_trades.rs:355-384,
   * claim_funding), so between those the chain counts a debt against this
   * position that the collateral figure alone cannot see. Paired with
   * `useMarket().fundingRate` (the market's cumulative index) at the render
   * site, exactly as liquidate_position.rs:129-158 pairs them.
   */
  fundingIndexSnapshot: bigint;
  isLong: boolean;
  /**
   * Mark-to-market PnL in dollars, or null when there is no trustworthy price
   * to mark against. Null is not 0: the two used to be collapsed here, and the
   * row printed a confident green "+$0.00" beside Mark/Liq./Health cells that
   * were honestly rendering "—".
   */
  unrealizedPnl: number | null;
}

export function useUserAccount() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [user, setUser] = useState<UserData | null>(null);

  const fetch = useCallback(async () => {
    if (!publicKey) {
      // No wallet is not "keep showing the last one's balances". Same defect as
      // usePositions below: without this, a disconnect (or a switch to a wallet
      // that has never deposited) leaves the previous wallet's free collateral
      // and credit on screen, attributed to nobody.
      setUser(null);
      return;
    }
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
      } else {
        // A definitive answer, not a transient failure: this wallet has no
        // UserAccount. Holding the previous wallet's numbers here would be a
        // lie the chain contradicts.
        setUser(null);
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
  // A read that FAILED and a read that came back empty are different answers.
  // Both used to leave `raw` at [], which the panel renders as "No open
  // positions" — so a trader reloading during a devnet rate-limit (the proxy
  // answers every getAccountInfo with -32005 for 10-30s) was told they were
  // flat while their leveraged position was live and moving. The poll still
  // swallows the throw (cadence is startPoll's job); it just stops pretending
  // the failure was an answer.
  const [err, setErr] = useState(false);
  // ...and a read that has NOT HAPPENED YET is a third answer again. Without
  // it `raw = []` on mount is indistinguishable from "flat", so the panel
  // asserts "0 open" / "No open positions" for the whole first round trip —
  // the same lie as above, just earlier. True only until the first resolve or
  // throw for the current wallet. Starts TRUE: the effect below only runs
  // after the first commit, so initialising it to false would paint one frame
  // of "No open positions" before "checking" - the same claim, briefly.
  const [loading, setLoading] = useState(true);

  // Base58 of the wallet `raw` describes. A fetch is a network round trip: the
  // one launched for wallet A can resolve AFTER the user switched to B or
  // disconnected, and writing its result then puts A's position in B's table.
  // Compared after the await instead of trusting that the closure is current.
  const owner = publicKey ? publicKey.toBase58() : null;
  const ownerRef = useRef<string | null>(null);
  // The SAME wallet has the same race: `refresh` is called after a flatten and
  // after a close, concurrently with the 5s poll, and the owner check cannot
  // separate two reads of one wallet. Results were applied in completion
  // order, so a poll issued before a close resolved after it and put the
  // closed row back — with live Close / ½ / SL-TP buttons on a zero position.
  // Only the newest read may write.
  const seqRef = useRef(0);

  const fetch = useCallback(async () => {
    const seq = ++seqRef.current;
    if (!owner) {
      // Disconnected is neither "no positions" nor "the read failed" — it is
      // "this row belongs to a wallet we are no longer connected to". Leaving
      // it up left the previous wallet's LONG on screen with enabled Close, ½
      // and SL/TP buttons whose handlers all bail on `!publicKey` before they
      // even set an error, so the click did nothing at all: no spinner, no
      // message. Clearing the rows is what makes those buttons unreachable.
      setRaw([]);
      setErr(false);
      setLoading(false);
      return;
    }
    try {
      // The Position address is DERIVABLE, so scanning the program for it was
      // never necessary. getProgramAccounts reads every account the program
      // owns — including the 626 KiB order book and every other user's
      // accounts — and applies the memcmp filters node-side afterwards. It was
      // the single most expensive request this app made, it is the shape that
      // returns 429/502 first under load, and the proxy comment at
      // api/rpc/[layer]/route.ts:69-70 names it as how the project burned its
      // RPC quota once already.
      const [positionPda] = findPositionPda(
        new PublicKey(owner),
        MARKET_INDEX,
        PROGRAM_ID
      );
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
          fundingIndexSnapshot: pos.fundingIndexSnapshot,
          isLong: pos.size > 0n,
        });
      }
      if (ownerRef.current !== owner || seq !== seqRef.current) return; // superseded
      setRaw(result);
      setErr(false);
      setLoading(false);
    } catch {
      // Keep the last good rows — a blip should not blank a live position —
      // but say so, so the panel can render "can't reach Solana" instead of
      // "no open positions". Not rethrown: startPoll's backoff is driven by
      // its own catch and this hook has always swallowed here.
      if (ownerRef.current !== owner || seq !== seqRef.current) return;
      setErr(true);
      setLoading(false);
    }
  }, [connection, owner]);

  // Price them here instead. Recomputing this on every oracle tick is a cheap
  // pure map over a handful of positions; refetching on every oracle tick was
  // a program scan.
  const positions: PositionData[] = useMemo(
    () =>
      raw.map((p) => {
        // No trustworthy price is not "zero PnL". It used to fall through to 0
        // here, which the table rendered as a green "+$0.00" in the same row
        // whose Mark, Liq. and Health cells were correctly showing "—".
        if (!markPrice) return { ...p, unrealizedPnl: null };
        // Mirrors the on-chain compute_unrealized_pnl: size is 9-dp base
        // atoms, so (size * priceDiff) / BASE_SCALE (1e9) yields 6-dp quote
        // PnL; then / PRICE_SCALE (1e6) for a human dollar value.
        const priceDiff = markPrice - p.entryPrice;
        const rawPnl = (p.size * priceDiff) / 1_000_000_000n; // BASE_SCALE
        return { ...p, unrealizedPnl: Number(rawPnl) / PRICE_SCALE };
      }),
    [raw, markPrice]
  );

  useEffect(() => {
    // Drop the rows the moment the wallet changes, not when the new wallet's
    // fetch finally resolves — otherwise wallet B stares at wallet A's LONG
    // for a network round trip, and on disconnect the row never goes at all.
    ownerRef.current = owner;
    setRaw([]);
    setErr(false);
    // Back to "unknown" for the new wallet — clearing the rows without this
    // renders the cleared table as a confident "No open positions".
    setLoading(owner !== null);
    fetch();
    return startPoll(fetch, 5_000);
  }, [fetch, owner]);

  return { positions, error: err, loading, refresh: fetch };
}
