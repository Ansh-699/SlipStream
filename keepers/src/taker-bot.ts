import { Connection, PublicKey } from "@solana/web3.js";
import { getBaseConnection, getErConnection, sleep, log } from "./shared/connection";
import { getKeeperAddresses } from "./shared/manifest";
import { fetchMarket, fetchOrderBook } from "./shared/accounts";
import { readPythPrice, PYTH_SOL_USD_FEED, type PythPrice } from "./shared/pyth";
import { sendErTx } from "./shared/ertx";
import {
  loadBotWallets,
  getBotCounts,
  readTradingCredit,
  fmtUsdc,
  type BotWallet,
} from "./shared/bot-wallets";
import { createPlaceOrderInstruction } from "../../client/src/instructions";
import {
  SIDE_BID,
  SIDE_ASK,
  ORDER_TYPE_IOC,
  PRICE_SCALE,
} from "../../client/src/constants";
import type { Market, OrderBookState, PriceLevel } from "../../client/src/accounts";

/**
 * Taker / noise bot — periodically crosses the spread with small IOC orders to
 * generate fills (which the settlement keeper turns into positions, exercising
 * funding/liquidation paths).
 *
 * Each cycle, for every taker wallet, with some probability:
 *   1. read the ER order book + the live Pyth mid,
 *   2. pick a side biased toward MEAN REVERSION around the Pyth mid (if the best
 *      ask is below mid it tends to BUY; if the best bid is above mid it tends to
 *      SELL) so the price wanders without running away,
 *   3. send a 1-lot IOC limit order priced to cross the resting top-of-book.
 *
 * Why IOC limit (not MARKET): the deployed `place_order` derives MARKET slippage
 * bounds from `market.last_mark_price`, which on this market is stale ($1.00),
 * so MARKET orders against an ~$80 book revert with SlippageExceeded. An IOC
 * LIMIT priced at/through the resting level uses the order price as the reference
 * and matches cleanly, while still being a pure taker (any unfilled remainder is
 * dropped, never rests). A configurable BOT_TAKER_MAX_SLIPPAGE_BPS bounds how far
 * through the book we are willing to price.
 *
 * Config (env):
 *   BOT_TAKER_INTERVAL_MS     base cycle interval (default 12000)
 *   BOT_TAKER_JITTER_MS       random extra wait added per cycle (default 6000)
 *   BOT_TAKER_CROSS_PROB      probability a wallet trades in a cycle (default 0.7)
 *   BOT_TAKER_SIZE_LOTS       lots per taker order (default 1)
 *   BOT_TAKER_MAX_SLIPPAGE_BPS  max bps past top-of-book to price the IOC (default 100)
 *   BOT_TAKER_MAX_ORACLE_DEVIATION_BPS  max bps the resting top-of-book may sit
 *     away from the live Pyth mid before this bot refuses to cross it (default
 *     500 = 5%). MAX_SLIPPAGE_BPS alone only bounds price relative to the BOOK
 *     itself — if the book has drifted (a stalled market-maker, a wash-traded
 *     resting order, or the self-trade-prevention gap this bot exists to
 *     exercise), that gives no protection at all against actually paying a
 *     wildly bad price. This is the same sanity check `place_order` itself
 *     omits by design (there is no on-chain oracle band on limit prices).
 *   BOT_TAKER_REVERT_BIAS     0..1 strength of mean-reversion bias (default 0.7)
 *   MAX_CYCLES                stop after N cycles (default unbounded)
 */

const INTERVAL_MS = Number(process.env.BOT_TAKER_INTERVAL_MS || "12000");
const JITTER_MS = Number(process.env.BOT_TAKER_JITTER_MS || "6000");
const CROSS_PROB = Number(process.env.BOT_TAKER_CROSS_PROB || "0.7");
const SIZE_LOTS = Math.max(1, parseInt(process.env.BOT_TAKER_SIZE_LOTS || "1", 10));
const MAX_SLIPPAGE_BPS = Number(process.env.BOT_TAKER_MAX_SLIPPAGE_BPS || "100");
const MAX_ORACLE_DEVIATION_BPS = Number(process.env.BOT_TAKER_MAX_ORACLE_DEVIATION_BPS || "500");
const REVERT_BIAS = Math.min(1, Math.max(0, Number(process.env.BOT_TAKER_REVERT_BIAS || "0.7")));
const MAX_CYCLES = Number(process.env.MAX_CYCLES || "0");
// Mirror programs/slipstream/src/oracle.rs's MAX_STALENESS_SECS.
const PYTH_MAX_STALENESS_SECS = 60;

function roundToTick(price6: bigint, tick: bigint): bigint {
  if (tick <= 0n) return price6;
  const r = ((price6 + tick / 2n) / tick) * tick;
  return r < tick ? tick : r;
}

/** Best (highest) bid level present, or null. */
function bestBid(ob: OrderBookState): PriceLevel | null {
  let best: PriceLevel | null = null;
  for (const lvl of ob.bidLevels) {
    if (lvl.orderCount > 0 && lvl.price > 0n) {
      if (!best || lvl.price > best.price) best = lvl;
    }
  }
  return best;
}

/** Best (lowest) ask level present, or null. */
function bestAsk(ob: OrderBookState): PriceLevel | null {
  let best: PriceLevel | null = null;
  for (const lvl of ob.askLevels) {
    if (lvl.orderCount > 0 && lvl.price > 0n) {
      if (!best || lvl.price < best.price) best = lvl;
    }
  }
  return best;
}

interface TakerContext {
  base: Connection;
  er: Connection;
  market: Market;
  marketIndex: number;
}

/**
 * Choose the taker side with a mean-reversion bias around `mid6`:
 *  - if the best ask is cheaper than mid → buying reverts toward mid (favor BUY),
 *  - if the best bid is richer than mid → selling reverts toward mid (favor SELL),
 *  - otherwise pick randomly. REVERT_BIAS blends the signal with randomness.
 */
function chooseSide(ob: OrderBookState, mid6: bigint): number | null {
  const bid = bestBid(ob);
  const ask = bestAsk(ob);
  if (!bid && !ask) return null;

  let buyScore = 0.5;
  if (ask && ask.price < mid6) buyScore += REVERT_BIAS * 0.5; // cheap ask → buy
  if (bid && bid.price > mid6) buyScore -= REVERT_BIAS * 0.5; // rich bid → sell

  // Can only take a side if there's resting liquidity on the opposite side.
  const wantBuy = Math.random() < buyScore;
  if (wantBuy && ask) return SIDE_BID;
  if (!wantBuy && bid) return SIDE_ASK;
  // Fall back to whichever side has liquidity.
  if (ask) return SIDE_BID;
  if (bid) return SIDE_ASK;
  return null;
}

/** One taker action for one wallet. */
async function cycleWallet(ctx: TakerContext, wallet: BotWallet, pyth: PythPrice): Promise<void> {
  const owner = wallet.keypair.publicKey;

  if (Math.random() > CROSS_PROB) {
    log("taker", `${wallet.name} idle this cycle (prob)`);
    return;
  }

  const ob = await fetchOrderBook(ctx.er, ctx.marketIndex);
  if (!ob) {
    log("taker", `${wallet.name} order book unavailable on ER`);
    return;
  }

  const side = chooseSide(ob, pyth.price6);
  if (side === null) {
    log("taker", `${wallet.name} no resting liquidity to cross — skipping`);
    return;
  }

  const tick = ctx.market.tickSize;
  const lot = ctx.market.lotSize;
  const size = lot * BigInt(SIZE_LOTS);

  // Price the IOC to cross the resting top-of-book, bounded by max slippage.
  const ask = bestAsk(ob);
  const bid = bestBid(ob);
  let limitPrice: bigint;
  let refLevel: PriceLevel | null;
  if (side === SIDE_BID) {
    refLevel = ask;
    if (!ask) {
      log("taker", `${wallet.name} wanted BUY but no ask — skipping`);
      return;
    }
    const slip = (ask.price * BigInt(Math.round(MAX_SLIPPAGE_BPS))) / 10_000n;
    limitPrice = roundToTick(ask.price + slip, tick); // willing to pay up to ask + slippage
  } else {
    refLevel = bid;
    if (!bid) {
      log("taker", `${wallet.name} wanted SELL but no bid — skipping`);
      return;
    }
    const slip = (bid.price * BigInt(Math.round(MAX_SLIPPAGE_BPS))) / 10_000n;
    const target = bid.price > slip ? bid.price - slip : tick;
    limitPrice = roundToTick(target, tick); // willing to sell down to bid - slippage
  }

  // Oracle sanity bound: MAX_SLIPPAGE_BPS above only bounds the limit price
  // relative to the BOOK's own top-of-book, which gives zero protection if the
  // book itself has drifted away from reality. Refuse to cross a resting price
  // that's too far from the live Pyth mid, regardless of what the book says.
  const refPrice = refLevel!.price;
  const oracleDeviationBps = pyth.price6 > 0n
    ? Number(((refPrice > pyth.price6 ? refPrice - pyth.price6 : pyth.price6 - refPrice) * 10_000n) / pyth.price6)
    : 0;
  if (oracleDeviationBps > MAX_ORACLE_DEVIATION_BPS) {
    log(
      "taker",
      `${wallet.name} top-of-book $${(Number(refPrice) / PRICE_SCALE).toFixed(4)} is ` +
        `${oracleDeviationBps}bps from Pyth mid $${pyth.priceFloat.toFixed(4)} (max ${MAX_ORACLE_DEVIATION_BPS}) — refusing to cross`
    );
    return;
  }

  // Make sure the wallet has credit to take (taker margin is drained on fill).
  const credit = await readTradingCredit(ctx.base, ctx.er, owner, ctx.marketIndex);
  if (!credit || credit.available === 0n) {
    log("taker", `${wallet.name} no available trading credit — run bot-setup first`);
    return;
  }

  const sideName = side === SIDE_BID ? "BUY" : "SELL";
  try {
    const ix = createPlaceOrderInstruction(owner, ctx.marketIndex, {
      side,
      orderType: ORDER_TYPE_IOC,
      price: limitPrice,
      size,
    });
    const sig = await sendErTx(ctx.er, ix, wallet.keypair);
    log(
      "taker",
      `${wallet.name} ${sideName} ${SIZE_LOTS}lot IOC @ $${(Number(limitPrice) / PRICE_SCALE).toFixed(4)} ` +
        `(top $${(Number(refLevel!.price) / PRICE_SCALE).toFixed(4)}, mid $${pyth.priceFloat.toFixed(4)}) sig=${sig}`
    );
  } catch (e: any) {
    const name = e?.name ?? "Error";
    if (name === "SlippageExceeded") {
      log("taker", `${wallet.name} ${sideName} slippage exceeded — book moved away, skip`);
    } else if (name === "InsufficientCredit") {
      log("taker", `${wallet.name} insufficient credit to take — skip`);
    } else {
      log("taker", `${wallet.name} ${sideName} IOC failed: ${name} (${e?.code ?? "?"})`);
    }
  }
}

async function main() {
  const base = getBaseConnection();
  const er = getErConnection();
  const addrs = getKeeperAddresses();
  const counts = getBotCounts();

  const wallets = loadBotWallets(counts).filter((w) => w.role === "taker");
  log("taker", `starting with ${wallets.length} taker wallet(s); market=${addrs.market.toBase58()} index=${addrs.marketIndex}`);
  log("taker", `interval=${INTERVAL_MS}ms jitter=${JITTER_MS}ms crossProb=${CROSS_PROB} size=${SIZE_LOTS}lot maxSlippage=${MAX_SLIPPAGE_BPS}bps revertBias=${REVERT_BIAS} maxCycles=${MAX_CYCLES || "∞"}`);
  if (wallets.length === 0) {
    log("taker", "no taker wallets configured (BOT_TAKER_COUNT=0) — nothing to do");
    return;
  }

  let consecutiveErrors = 0;
  let cycle = 0;

  while (true) {
    cycle++;
    try {
      const market = await fetchMarket(base, addrs.marketIndex);
      if (!market) {
        log("taker", "market not found, waiting…");
        await sleep(5_000);
        continue;
      }
      if (market.circuitBreakerActive) {
        log("taker", "market paused (circuit breaker) — skipping cycle");
        await sleep(INTERVAL_MS);
        continue;
      }

      const pyth = await readPythPrice(base, PYTH_SOL_USD_FEED);
      log("taker", `cycle ${cycle} pyth mid=$${pyth.priceFloat.toFixed(4)} (age ${pyth.ageSecs}s)`);
      if (pyth.ageSecs > PYTH_MAX_STALENESS_SECS) {
        // Age was computed and logged above but never actually gated — trading
        // against a stale mid defeats the point of the oracle deviation check
        // just above, since the "reference" price could itself be arbitrarily
        // out of date. Mirrors programs/slipstream/src/oracle.rs's own
        // MAX_STALENESS_SECS.
        log("taker", `pyth reading stale (${pyth.ageSecs}s > ${PYTH_MAX_STALENESS_SECS}s) — skipping cycle`);
        await sleep(INTERVAL_MS);
        continue;
      }

      const ctx: TakerContext = { base, er, market, marketIndex: addrs.marketIndex };
      for (const w of wallets) {
        await cycleWallet(ctx, w, pyth);
      }
      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      log("taker", `error (${consecutiveErrors}): ${err?.message ?? err}`);
      if (consecutiveErrors > 10) {
        log("taker", "too many consecutive errors, backing off 60s");
        await sleep(60_000);
        consecutiveErrors = 0;
      }
    }

    if (MAX_CYCLES > 0 && cycle >= MAX_CYCLES) {
      log("taker", `reached MAX_CYCLES=${MAX_CYCLES}; stopping.`);
      break;
    }
    const wait = INTERVAL_MS + Math.floor(Math.random() * JITTER_MS);
    await sleep(wait);
  }
}

main().catch((err) => {
  console.error("taker bot crashed:", err?.message ?? err);
  process.exit(1);
});
