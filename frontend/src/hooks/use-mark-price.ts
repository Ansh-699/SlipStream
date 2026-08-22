"use client";

import { useEffect, useState } from "react";
import { useMarket } from "@/hooks/use-market";
import { useLivePrice } from "@/hooks/use-live-price";
import { isMarkPriceFresh, markPriceAgeMins, PRICE_SCALE } from "@/lib/slipstream";

/**
 * One answer to "what price should this surface use, and can it be trusted?"
 *
 * Six surfaces read `market.lastMarkPrice` and five of them rendered it as if
 * it were live (S13-02, S13-03, S13-04, S9-X02, S3-X03). Only `market-bar.tsx`
 * treated it carefully, and it stated the invariant while doing so: "if the
 * keepers stop, mark freezes while the market does not, and showing the frozen
 * number as 'the price' would be a lie." That treatment is lifted here so every
 * surface gets it, rather than each re-deriving it or forgetting to.
 *
 * Two independent staleness signals, because they fail in different ways:
 *
 *   - `stampStale` is the program's own gate (`Market::is_mark_price_fresh`),
 *     read from the `mark_price_minute` stamp that S6-01 restored to the
 *     decoders. It needs nothing but the market account, and it agrees with the
 *     chain exactly - if it says stale, `close_position` and `place_order` will
 *     refuse this mark.
 *   - `divergenceStale` compares the mark to the live oracle. It catches a mark
 *     that is being stamped but is wrong, which the stamp alone cannot see, but
 *     it says nothing at all when the oracle stream is down.
 *
 * `reference` is what price math should actually use: the oracle when it is
 * available, otherwise a mark the program itself would still accept, otherwise
 * null. Null means "do not quote a price" - not "fall back to the frozen one".
 */

/** Mark/oracle gap past which the mark is treated as untrustworthy. */
export const MARK_DIVERGENCE_WARN = 0.01;

/** How old a Pyth reading may be and still be treated as the live price. The
 *  feed pushes about every 50ms, so anything past a few seconds means the
 *  stream is not delivering even if the socket has not formally closed. */
const MAX_SPOT_AGE_SECS = 10;

export interface MarkPriceInfo {
  /** On-chain mark, in dollars. Null when unset or unavailable. */
  mark: number | null;
  /** Live oracle price, in dollars. Null when the stream is down. */
  spot: number | null;
  /**
   * The price to compute with: oracle first, then a still-fresh mark. Null when
   * neither can be trusted — callers must refuse to quote rather than
   * substitute the frozen mark.
   */
  reference: number | null;
  /** True when the program's own freshness gate would reject this mark. */
  stampStale: boolean;
  /** Age of the mark stamp in minutes; null on an unstamped market. */
  ageMins: number | null;
  /** |mark - spot| / spot, or null without both. */
  divergence: number | null;
  /** True when mark and oracle disagree past MARK_DIVERGENCE_WARN. */
  divergenceStale: boolean;
  /** Either signal firing. This is what UI should branch on. */
  stale: boolean;
  /** Short human explanation of why it is stale, or null when it is not. */
  reason: string | null;
}

export function useMarkPrice(marketIndex: number = 0): MarkPriceInfo {
  const { market } = useMarket(marketIndex);
  const { live, connected } = useLivePrice();

  // Both gates are functions of wall-clock time, so a price that was fresh when
  // fetched goes stale on its own. The tick must be shorter than the tightest
  // window it polices: it was 30s while MAX_SPOT_AGE_SECS is 10, so a dead
  // oracle would have kept reading as live for up to another half minute.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 5_000);
    return () => clearInterval(id);
  }, []);

  const mark =
    market && market.lastMarkPrice > 0n ? Number(market.lastMarkPrice) / PRICE_SCALE : null;
  // The oracle price is only usable while the socket is UP and the reading is
  // recent. useLivePrice leaves `live` at its last value forever when the
  // socket closes — it only flips `connected` — so consuming `live` alone made
  // this whole staleness system trust a frozen price:
  //   - `reference` fell back to a spot that stopped updating minutes ago, and
  //     that reference is what prices health, the Mark column, and the IOC
  //     cross-price and 1% slippage bound on Close. The bound the tooltip
  //     promises was being computed against a dead number.
  //   - `divergence` was measured against that same frozen spot, so a genuinely
  //     drifting mark stopped being flagged the moment the oracle died — a
  //     false negative exactly when the warning matters most.
  // This file's own contract says "Null means 'do not quote a price' — not
  // 'fall back to the frozen one'." It applied that to the mark and not to the
  // oracle it was checking the mark against.
  const spotAgeSecs =
    live?.publishTime != null ? nowSec - Number(live.publishTime) : null;
  const spotUsable =
    connected && live != null && (spotAgeSecs === null || spotAgeSecs <= MAX_SPOT_AGE_SECS);
  const spot = spotUsable ? (live?.price ?? null) : null;

  const stampStale = market ? !isMarkPriceFresh(market, nowSec) : false;
  const ageMins = market ? markPriceAgeMins(market, nowSec) : null;

  const divergence =
    mark !== null && spot !== null && spot > 0 ? Math.abs(mark - spot) / spot : null;
  const divergenceStale = divergence !== null && divergence > MARK_DIVERGENCE_WARN;

  const stale = stampStale || divergenceStale;

  let reason: string | null = null;
  if (stampStale) {
    const age =
      ageMins === null
        ? "past the freshness window"
        : ageMins >= 1440
          ? `${Math.round(ageMins / 1440)}d old`
          : ageMins >= 60
            ? `${Math.round(ageMins / 60)}h old`
            : `${ageMins}m old`;
    reason = `the TWAP crank has stopped — mark is ${age}`;
  } else if (divergenceStale) {
    reason = `mark is ${(divergence! * 100).toFixed(1)}% off the oracle`;
  } else if (!spotUsable && mark !== null) {
    // Not "stale" — the mark is still one the program accepts — but the reason
    // callers show should say which price they are looking at.
    reason = "oracle stream is down — showing the on-chain mark";
  }

  // Oracle first — but only when it is ACTUALLY live, which is what spotUsable
  // now establishes; "live by construction" was the assumption that made this
  // trust a frozen feed. A stamp-stale mark is one the program itself will
  // refuse, so it must never become the reference either.
  const reference = spot ?? (stampStale ? null : mark);

  return {
    mark,
    spot,
    reference,
    stampStale,
    ageMins,
    divergence,
    divergenceStale,
    stale,
    reason,
  };
}
