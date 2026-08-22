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
  const { live } = useLivePrice();

  // The stamp gate is a function of wall-clock time, so a mark that was fresh
  // when fetched goes stale on its own. Without a tick the panel would keep
  // claiming freshness until the next market poll happened to re-render it.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  const mark =
    market && market.lastMarkPrice > 0n ? Number(market.lastMarkPrice) / PRICE_SCALE : null;
  const spot = live?.price ?? null;

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
  }

  // Oracle first: it is live by construction. A stamp-stale mark is one the
  // program will refuse, so it must never become the reference.
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
