"use client";

import { useEffect, useState } from "react";
import { useMarket } from "@/hooks/use-market";
import { useLivePrice } from "@/hooks/use-live-price";
import {
  markPriceAgeMins,
  MARK_PRICE_MAX_STALENESS_MINS,
  PRICE_SCALE,
} from "@/lib/slipstream";

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
 *     decoders. It needs nothing but the market account: if it says stale,
 *     `close_position` and `place_order` will refuse this mark. It matches the
 *     chain everywhere except the far half of the minute ring, which it reads
 *     as a client clock running behind rather than a 22-45 day old mark - see
 *     the CEILING note at the computation.
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
  // The oracle price is usable only while the socket is UP and the reading is
  // recent. The first half of that now holds at the source: useLivePrice gates
  // `live` on `connected` in its own getSnapshot, so a dead stream yields null
  // here (and in market-bar, price-chart and status-panel, which never checked).
  // It used to hand out the last frame forever, which is what made this whole
  // staleness system trust a frozen price:
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
  //
  // The second half is what the store CANNOT do: a socket that stays open and
  // stops delivering leaves `connected` true, and a snapshot read has nothing
  // to notify it as time passes. That needs a clock, which is why the age gate
  // and the `connected` term both stay here — this is the one consumer that
  // owns a tick.
  const spotAgeSecs =
    live?.publishTime != null ? nowSec - Number(live.publishTime) : null;
  const spotUsable =
    connected && live != null && (spotAgeSecs === null || spotAgeSecs <= MAX_SPOT_AGE_SECS);
  const spot = spotUsable ? (live?.price ?? null) : null;

  // `markPriceAgeMins` mirrors the program's wrapping u16 minute arithmetic
  // (state/market.rs:154-161), but the program compares two reads of the SAME
  // Clock, so its delta is never negative. Here `nowMin` comes from Date.now()
  // sampled up to 5s ago while the stamp comes from the chain, so a stamp from
  // a minute this client has not reached yet wraps to ~65535 — read as a mark
  // 46 DAYS old. Two ways in, neither exotic: the crank stamps at 12:00:01 and
  // the market poll delivers it while `nowSec` is still 11:59:59, or the
  // laptop's clock is simply a minute slow (no NTP — VMs, corporate images, a
  // phone back from airplane mode), which never leaves the state at all. It
  // turned the Mark column amber with "the TWAP crank has stopped — mark is 46d
  // old" one second after the crank ran, and with the oracle stream also down
  // it left `reference` null, so both close paths refused outright: the user
  // could not exit a position because their clock was a minute slow.
  //
  // The far half of the ring is a clock behind, not an ancient mark — the
  // program's own comment scopes this arithmetic to "any real age < ~22 days".
  // Age it as 0. This tolerates arbitrary client-behind-chain skew.
  //
  // CEILING: a mark genuinely 22-45 days old also lands in the far half and is
  // reported fresh here while the chain would refuse it. Deliberate trade — a
  // slow client clock is routine, a month-dead crank on a live market is not,
  // and `divergenceStale` still catches that case whenever the oracle is up.
  // The correction belongs in the shared helpers in lib/slipstream/accounts.ts
  // (see the isMarkPriceFresh/markPriceAgeMins pair) so it exists once; that
  // file is outside this change, and this hook is currently their only caller.
  const rawAgeMins = market ? markPriceAgeMins(market, nowSec) : null;
  const ageMins = rawAgeMins !== null && rawAgeMins > 32768 ? 0 : rawAgeMins;
  // Unstamped (null) is fresh, exactly as the program treats it.
  const stampStale = ageMins !== null && ageMins > MARK_PRICE_MAX_STALENESS_MINS;

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
