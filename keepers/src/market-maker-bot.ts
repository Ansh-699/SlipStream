import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getBaseConnection, getErConnection, sleep, log } from "./shared/connection";
import { getKeeperAddresses } from "./shared/manifest";
import { fetchMarket, fetchOrderBook } from "./shared/accounts";
import { readPythPrice, PYTH_SOL_USD_FEED, type PythPrice } from "./shared/pyth";
import { sendErTx } from "./shared/ertx";
import {
  loadBotWallets,
  getBotCounts,
  readTradingCredit,
  marginForOrder,
  fmtUsdc,
  type BotWallet,
} from "./shared/bot-wallets";
import {
  createPlaceOrderInstruction,
  createCancelOrderInstruction,
} from "../../client/src/instructions";
import {
  SIDE_BID,
  SIDE_ASK,
  ORDER_TYPE_POST_ONLY,
} from "../../client/src/constants";
import type { Market, OrderSlot } from "../../client/src/accounts";

/**
 * Market-maker bot — POST_ONLY two-sided ladder around the live Pyth mid.
 *
 * Each cycle, for every MM wallet:
 *   1. read the live Pyth reference mid (PriceUpdateV2 on the base RPC),
 *   2. if this is the first quote or the mid has moved beyond a threshold, cancel
 *      the wallet's resting orders and re-place a fresh ladder of N bids below /
 *      N asks above the mid at a configurable per-step spread,
 *   3. otherwise leave the existing quotes in place (saves tx spend).
 *
 * Orders are POST_ONLY so the MM never crosses (always a maker). Placement is on
 * the ER. Program reverts (PostOnlyWouldCross / InsufficientCredit / OrderBookFull)
 * are caught and the bot backs off the rest of the ladder. Long-running by default;
 * MAX_CYCLES bounds it for smoke testing.
 *
 * Config (env):
 *   BOT_MM_SPREAD_BPS    per-step spread from mid (default 3)
 *   BOT_MM_LEVELS        levels per side (default 9)
 *   BOT_MM_SIZE_LOTS     lots per order (default 1; 1 lot = 0.1 SOL)
 *   BOT_MM_INTERVAL_MS   cycle interval (default 2000 — a 1-1.2s cadence
 *                        roughly doubled base-RPC usage for no visible depth
 *                        benefit and contributed to a real quota-exhaustion
 *                        incident; see ecosystem.config.js's matching comment)
 *   BOT_MM_REFRESH_BPS   mid-move threshold to cancel/replace (default 6)
 *   MAX_CYCLES           stop after N cycles (default unbounded)
 */

const SPREAD_BPS = Number(process.env.BOT_MM_SPREAD_BPS || "3");
// 9 levels/side = 18 orders/wallet, under the orderbook's orders_per_user cap (20).
// Run multiple MM wallets (BOT_MM_COUNT) to widen total depth/range.
const LEVELS = Math.max(1, parseInt(process.env.BOT_MM_LEVELS || "9", 10));
const SIZE_LOTS = Math.max(1, parseInt(process.env.BOT_MM_SIZE_LOTS || "1", 10));
const INTERVAL_MS = Number(process.env.BOT_MM_INTERVAL_MS || "2000");
const REFRESH_BPS = Number(process.env.BOT_MM_REFRESH_BPS || "6");
const MAX_CYCLES = Number(process.env.MAX_CYCLES || "0"); // 0 = unbounded

/** Round a 6-dp price to the nearest valid tick (multiple of tickSize). */
function roundToTick(price6: bigint, tick: bigint): bigint {
  if (tick <= 0n) return price6;
  const r = ((price6 + tick / 2n) / tick) * tick;
  return r < tick ? tick : r; // never zero/negative
}

/** Per-wallet mid we last quoted around (for the refresh threshold). */
const lastQuotedMid = new Map<string, bigint>();

/** Find the wallet's active resting orders by scanning decoded order slots. */
function ownerActiveOrders(orderSlots: OrderSlot[], owner: PublicKey): OrderSlot[] {
  return orderSlots.filter(
    (s) => s.active && new PublicKey(s.owner).equals(owner)
  );
}

interface MmContext {
  base: Connection;
  er: Connection;
  market: Market;
  marketIndex: number;
}

/** Cancel all of a wallet's resting orders on the ER (concurrently). */
async function cancelAll(
  ctx: MmContext,
  wallet: BotWallet,
  orders: OrderSlot[]
): Promise<number> {
  const results = await Promise.allSettled(
    orders.map((o) => {
      const ix = createCancelOrderInstruction(wallet.keypair.publicKey, ctx.marketIndex, o.orderId);
      return sendErTx(ctx.er, ix, wallet.keypair);
    })
  );
  return results.filter((r) => r.status === "fulfilled").length;
}

/** Place a fresh POST_ONLY ladder for one wallet around `mid6`. Fires all orders
 *  CONCURRENTLY for speed. `bandStart` lets multiple MM wallets tile DIFFERENT
 *  price bands (wallet 0 quotes levels 1..N tight to the mid, wallet 1 quotes
 *  N+1..2N further out, etc.) so together they occupy a large price range. */
async function placeLadder(
  ctx: MmContext,
  wallet: BotWallet,
  mid6: bigint,
  availableCredit: bigint,
  bandStart: number
): Promise<{ bids: number; asks: number; sigs: string[]; reserved: bigint }> {
  const tick = ctx.market.tickSize;
  const lot = ctx.market.lotSize;
  const maxLev = ctx.market.maxLeverage;

  const perOrderMargin = marginForOrder(lot, SIZE_LOTS, mid6, maxLev);
  const size = lot * BigInt(SIZE_LOTS);

  const budget = perOrderMargin > 0n ? Number(availableCredit / perOrderMargin) : 0;
  if (budget <= 0) {
    log("market-maker", `${wallet.name} no credit for any order (avail ${fmtUsdc(availableCredit)})`);
    return { bids: 0, asks: 0, sigs: [], reserved: 0n };
  }

  const quotes: { side: number; price: bigint }[] = [];
  for (let j = 0; j < LEVELS; j++) {
    const k = bandStart + j; // this wallet's band of price steps
    const offset = (BigInt(Math.round(SPREAD_BPS * k)) * mid6) / 10_000n;
    quotes.push({ side: SIDE_BID, price: roundToTick(mid6 - offset, tick) });
    quotes.push({ side: SIDE_ASK, price: roundToTick(mid6 + offset, tick) });
  }
  const capped = quotes.slice(0, budget);

  const results = await Promise.allSettled(
    capped.map((q) => {
      const ix = createPlaceOrderInstruction(wallet.keypair.publicKey, ctx.marketIndex, {
        side: q.side,
        orderType: ORDER_TYPE_POST_ONLY,
        price: q.price,
        size,
      });
      return sendErTx(ctx.er, ix, wallet.keypair).then((sig) => ({ sig, side: q.side }));
    })
  );

  const sigs: string[] = [];
  let bids = 0;
  let asks = 0;
  let reserved = 0n;
  let crossed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      sigs.push(r.value.sig);
      reserved += perOrderMargin;
      if (r.value.side === SIDE_BID) bids++;
      else asks++;
    } else {
      const name = (r.reason as any)?.name ?? "Error";
      if (name === "PostOnlyWouldCross") crossed++;
    }
  }
  if (crossed > 0) {
    log("market-maker", `${wallet.name} ${crossed} level(s) skipped (would cross)`);
  }
  return { bids, asks, sigs, reserved };
}

/** One full market-maker cycle for one wallet. `bandIndex` is this wallet's
 *  position among the MM wallets; it shifts the wallet's quoted price band so
 *  multiple wallets tile a wide range (band 0 = tightest, band 1 = next, …). */
async function cycleWallet(
  ctx: MmContext,
  wallet: BotWallet,
  pyth: PythPrice,
  bandIndex: number,
  cycle: number,
  walletCount: number
): Promise<void> {
  const owner = wallet.keypair.publicKey;
  const mid6 = pyth.price6;

  // Read the wallet's current resting orders from the ER book.
  const ob = await fetchOrderBook(ctx.er, ctx.marketIndex);
  const myOrders = ob ? ownerActiveOrders(ob.orderSlots, owner) : [];

  // Decide whether to refresh: first quote, no resting orders, mid moved past
  // threshold, OR the wallet's depth has been eaten down (so we replenish fast
  // as takers fill us, keeping the book full).
  const prevMid = lastQuotedMid.get(wallet.name);
  const targetOrders = LEVELS * 2;
  let shouldRefresh = myOrders.length === 0 || prevMid === undefined;
  if (!shouldRefresh && myOrders.length < targetOrders * 0.6) shouldRefresh = true;
  // STAGGERED. A refresh is cancel-then-place across two transactions, so while
  // it runs this wallet has NO orders on the book. Both MM wallets watch the same
  // Pyth mid, so before this they re-quoted on the same tick and the book could
  // lose every level on a side at once -- which is what surfaced in the UI as the
  // ask ladder collapsing to half depth, the spread jumping from 0.04 to 0.30,
  // and the ancient $74 orders scrolling up into view because the fresh levels
  // above them had momentarily gone. The panel was rendering that honestly; the
  // book really was that thin for a moment.
  //
  // Only one wallet may take the mid-move refresh per cycle, so the other always
  // holds a full ladder. The cost is that a wallet's quotes can be one cycle
  // (INTERVAL_MS) stale, which is far cheaper than a hole in the book.
  //
  // Deliberately does NOT gate the two recovery triggers above: a wallet with no
  // orders, or one that has been eaten down, must re-quote on the spot -- those
  // are the cases where waiting a cycle makes the hole WORSE.
  const myTurn = walletCount <= 1 || cycle % walletCount === bandIndex;
  if (!shouldRefresh && prevMid !== undefined && myTurn) {
    const moveBps = Number((abs(mid6 - prevMid) * 10_000n) / (prevMid === 0n ? 1n : prevMid));
    if (moveBps >= REFRESH_BPS) shouldRefresh = true;
  }

  if (!shouldRefresh) {
    log("market-maker", `${wallet.name} mid=$${pyth.priceFloat.toFixed(4)} steady — ${myOrders.length} resting orders held`);
    return;
  }

  // Credit is read BEFORE cancelling. It does not depend on the cancel, and it
  // is a base-layer + ER round trip -- sitting between cancelAll and placeLadder
  // it put that entire latency INSIDE the window where this wallet has no orders
  // resting. Reading it first shortens the hole to just the two transactions.
  // It also means a missing credit aborts before the orders are pulled, instead
  // of cancelling the ladder and then discovering there is nothing to re-place
  // with -- which left the wallet flat until the next cycle noticed.
  const credit = await readTradingCredit(ctx.base, ctx.er, owner, ctx.marketIndex);
  if (!credit) {
    log("market-maker", `${wallet.name} no trading credit found — run bot-setup first`);
    return;
  }

  let cancelled = 0;
  if (myOrders.length > 0) cancelled = await cancelAll(ctx, wallet, myOrders);

  const result = await placeLadder(ctx, wallet, mid6, credit.available, 1 + bandIndex * LEVELS);
  lastQuotedMid.set(wallet.name, mid6);
  log(
    "market-maker",
    `${wallet.name} mid=$${pyth.priceFloat.toFixed(4)} cancelled=${cancelled} placed bids=${result.bids} asks=${result.asks} reserved≈${fmtUsdc(result.reserved)} avail=${fmtUsdc(credit.available)}`
  );
  if (result.sigs.length > 0) {
    log("market-maker", `${wallet.name} sigs: ${result.sigs.slice(0, 3).join(", ")}${result.sigs.length > 3 ? " …" : ""}`);
  }
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

async function main() {
  const base = getBaseConnection();
  const er = getErConnection();
  const addrs = getKeeperAddresses();
  const counts = getBotCounts();

  // Only the MM wallets participate here.
  const wallets = loadBotWallets(counts).filter((w) => w.role === "mm");
  log("market-maker", `starting with ${wallets.length} MM wallet(s); market=${addrs.market.toBase58()} index=${addrs.marketIndex}`);
  log("market-maker", `spread=${SPREAD_BPS}bps/step levels=${LEVELS} size=${SIZE_LOTS}lot interval=${INTERVAL_MS}ms refresh=${REFRESH_BPS}bps maxCycles=${MAX_CYCLES || "∞"}`);
  if (wallets.length === 0) {
    log("market-maker", "no MM wallets configured (BOT_MM_COUNT=0) — nothing to do");
    return;
  }

  let consecutiveErrors = 0;
  let cycle = 0;

  while (true) {
    cycle++;
    try {
      const market = await fetchMarket(base, addrs.marketIndex);
      if (!market) {
        log("market-maker", "market not found, waiting…");
        await sleep(5_000);
        continue;
      }
      if (market.circuitBreakerActive) {
        log("market-maker", "market paused (circuit breaker) — skipping cycle");
        await sleep(INTERVAL_MS);
        continue;
      }

      const pyth = await readPythPrice(base, PYTH_SOL_USD_FEED);
      log("market-maker", `cycle ${cycle} pyth mid=$${pyth.priceFloat.toFixed(4)} (age ${pyth.ageSecs}s, price6=${pyth.price6})`);

      const ctx: MmContext = { base, er, market, marketIndex: addrs.marketIndex };
      for (let i = 0; i < wallets.length; i++) {
        await cycleWallet(ctx, wallets[i], pyth, i, cycle, wallets.length);
      }
      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      log("market-maker", `error (${consecutiveErrors}): ${err?.message ?? err}`);
      if (consecutiveErrors > 10) {
        log("market-maker", "too many consecutive errors, backing off 60s");
        await sleep(60_000);
        consecutiveErrors = 0;
      }
    }

    if (MAX_CYCLES > 0 && cycle >= MAX_CYCLES) {
      log("market-maker", `reached MAX_CYCLES=${MAX_CYCLES}; stopping.`);
      break;
    }
    await sleep(INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("market-maker bot crashed:", err?.message ?? err);
  process.exit(1);
});
