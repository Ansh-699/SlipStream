import { Connection, PublicKey } from "@solana/web3.js";
import { PRICE_SCALE } from "../../../client/src/constants";

/**
 * Live Pyth reference-price reader for the simulation bots.
 *
 * The live SOL/USD feed is the Pyth Receiver `PriceUpdateV2` account
 * (7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE per deploy.json). Layout
 * (matches tests/integration/crank_twap_harness.ts inspectPyth):
 *   price        i64 @ 73
 *   exponent     i32 @ 89
 *   publish_time i64 @ 93
 *
 * We normalize to the program's 6-decimal price scale (PRICE_SCALE = 1e6) so it
 * lines up with tick size and the on-chain notional math.
 */

export const PYTH_SOL_USD_FEED = new PublicKey(
  process.env.PYTH_FEED || "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
);

export interface PythPrice {
  /** Raw mantissa as stored in the feed. */
  priceRaw: bigint;
  /** Feed exponent (negative; e.g. -8). */
  exponent: number;
  /** Unix seconds of the last publish. */
  publishTime: number;
  /** Age in seconds at read time. */
  ageSecs: number;
  /** Price scaled to PRICE_SCALE (6 decimals), as a bigint of quote atoms-per-base. */
  price6: bigint;
  /** Convenience float in dollars. */
  priceFloat: number;
}

/** Parse a PriceUpdateV2 account buffer into a normalized 6-decimal price. */
export function parsePriceUpdateV2(data: Buffer, nowSecs?: number): PythPrice {
  if (data.length < 134) {
    throw new Error(`Pyth feed buffer too small (len ${data.length} < 134)`);
  }
  const priceRaw = data.readBigInt64LE(73);
  const exponent = data.readInt32LE(89);
  const publishTime = Number(data.readBigInt64LE(93));

  // Rescale priceRaw (10^exponent) into PRICE_SCALE (10^-6).
  const expDiff = exponent - -6; // how far the feed expo is from -6
  let price6 = priceRaw;
  if (expDiff > 0) price6 = priceRaw * 10n ** BigInt(expDiff);
  else if (expDiff < 0) price6 = priceRaw / 10n ** BigInt(-expDiff);

  const now = nowSecs ?? Math.floor(Date.now() / 1000);
  return {
    priceRaw,
    exponent,
    publishTime,
    ageSecs: now - publishTime,
    price6,
    priceFloat: Number(price6) / PRICE_SCALE,
  };
}

/** Read + parse the live Pyth feed from the base RPC. */
export async function readPythPrice(
  baseConnection: Connection,
  feed: PublicKey = PYTH_SOL_USD_FEED
): Promise<PythPrice> {
  const info = await baseConnection.getAccountInfo(feed, "confirmed");
  if (!info) throw new Error(`Pyth feed ${feed.toBase58()} not found`);
  return parsePriceUpdateV2(info.data as Buffer);
}
