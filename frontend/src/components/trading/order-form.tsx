"use client";

import { erConnection } from "@/lib/connections";
import { useState } from "react";
import { useWallet } from "@/hooks/use-wallet-compat";
import { Transaction } from "@solana/web3.js";
import { useSession } from "@/hooks/use-session";
import { useMarket } from "@/hooks/use-market";
import { useMarkPrice } from "@/hooks/use-mark-price";
import { useOrderBook } from "@/hooks/use-orderbook";
import {
  PROGRAM_ID,
  MARKET_INDEX,
  explorerTx,
  TICK_SIZE,
  LOT_SIZE,
  LOT_SOL,
  MAX_LEVERAGE,
} from "@/lib/manifest";
import {
  createPlaceOrderInstruction,
  PRICE_SCALE,
  SIDE_BID,
  SIDE_ASK,
  ORDER_TYPE_LIMIT,
  ORDER_TYPE_MARKET,
  decodeProgramError,
  humanizeError,
} from "@/lib/slipstream";
import { confirmSignature } from "@/lib/confirm";

type OrderType = "limit" | "market";
const ORDER_TYPE_VALUES: Record<OrderType, number> = { limit: ORDER_TYPE_LIMIT, market: ORDER_TYPE_MARKET };

// Market params (TICK_SIZE / LOT_SIZE / LOT_SOL / MAX_LEVERAGE) now come from
// the Deploy_Manifest via @/lib/manifest — single source of truth with the
// on-chain market, so re-initializing at different params can't drift the UI.

// Required initial margin in 6-dp credit terms, mirroring the on-chain math
// exactly: notional = size_atoms * price_6dp / 1e9 (compute_notional), then
// margin = notional / market.max_leverage (compute_initial_margin). The divisor
// is the MARKET's fixed max_leverage — never the form's slider, which the wire
// format has no field for (createPlaceOrderInstruction packs 30 bytes: disc,
// side, type, price, size, expiry, slippage, reduce_only) and which
// place_order.rs:181-183 therefore never sees.
function requiredMarginAtoms(sizeAtoms: bigint, price6dp: bigint): bigint {
  if (sizeAtoms <= 0n || price6dp <= 0n) return 0n;
  const notional = (sizeAtoms * price6dp) / 1_000_000_000n; // BASE_SCALE
  return notional / BigInt(MAX_LEVERAGE);
}


export function OrderForm() {
  const { publicKey, sendTransaction } = useWallet();
  // `status`, not just `state`: an all-zero SessionState means "not read yet",
  // "genuinely empty" or "the read failed", and this form used to render the
  // third as the second — "$0.00 available", "no credit yet", "Start a trading
  // session first" — to a trader whose credit was funded and delegated the
  // whole time. See SessionStatus in use-session.ts.
  const { state: session, status: sessionRead, getSessionKeypair } = useSession(0);
  // This used to read `market.lastMarkPrice` raw, which is the exact field
  // useMarkPrice exists to gate. With the crank stopped it sized and quoted
  // market orders off a frozen price (the documented 74.11-against-95.81 case)
  // while the Mark column two panels away, reading the SAME field through this
  // hook, correctly rendered an em dash. `reference` is null precisely when no
  // price can be honestly quoted; `stampStale` is the program's own gate, and a
  // MARKET order whose stamp is stale reverts with OracleStale after the
  // signature (place_order.rs:173-177 via Market::mark_price_for_close).
  const { reference: markPrice, mark, stampStale, reason: markReason } = useMarkPrice(0);
  // "We have not read the market yet" is not "there is no trustworthy price" —
  // useMarkPrice cannot tell them apart because it only ever sees `market`, so
  // the status comes from the same shared source it already polls (no extra RPC,
  // one poller per key). Without this the button spends the first read telling
  // the user the crank is down.
  const { status: marketStatus } = useMarket(0);
  // Free: shared-source already polls this account for the ladder, status panel
  // and fill toasts, so this mount adds no RPC. Needed to answer "would a market
  // order of this size actually fill?" BEFORE it is sent.
  const { bids, asks, status: bookStatus } = useOrderBook(0);

  const [side, setSide] = useState<"long" | "short">("long");
  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [price, setPrice] = useState("");
  const [margin, setMargin] = useState(""); // dollars the trader posts
  const [leverage, setLeverage] = useState(5);
  const [slippageBps, setSlippageBps] = useState("50");
  const [submitting, setSubmitting] = useState(false);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [lastErr, setLastErr] = useState<string | null>(null);

  const isMarket = orderType === "market";

  const priceLoading = marketStatus === "loading" && markPrice === null;
  // Why a MARKET order cannot be priced right now, or null when it can be.
  // "We haven't read yet", "we can't reach the chain" and "the mark is stale"
  // are three different answers; the old code gave all three the same one by
  // silently dropping the ", around X" clause and letting the button read
  // "Enter a margin amount" to a user who had already entered one.
  const marketPriceBlock: string | null =
    !isMarket || (markPrice !== null && !stampStale)
      ? null
      : priceLoading
        ? "Loading the market price…"
        : marketStatus === "unavailable" && markPrice === null
          ? "Can't reach Solana right now — no price to size a market order"
          : markReason ?? "No trustworthy price to size a market order";

  // Effective entry price used for sizing: the limit price, or the best price we
  // can honestly quote for market (oracle first, then a mark the program itself
  // would still accept — never the frozen one).
  const entryPrice = isMarket ? markPrice : price ? parseFloat(price) : null;

  // An empty Max Slippage box is NOT "no bound": place_order.rs:35 documents
  // `0 = disabled`, and place_order.rs:224 then takes the `(0, u64::MAX)` branch,
  // so a cleared field — placeholder still reading "50" — used to send a market
  // order that could sweep the entire ask ladder. Parse toward protection: any
  // value that is not a positive number means the 50 bps the placeholder
  // promises. The u16 clamp keeps a pasted 99999 out of writeU16LE.
  const parsedBps = Number.parseInt(slippageBps, 10);
  const effectiveBps =
    Number.isFinite(parsedBps) && parsedBps > 0 ? Math.min(parsedBps, 65535) : 50;

  // Derive position size from amount × multiplier ÷ price, rounded to whole lots.
  const derived = (() => {
    const m = parseFloat(margin);
    if (!Number.isFinite(m) || m <= 0 || !entryPrice || entryPrice <= 0) return null;
    const notional = m * leverage; // $ position value
    const rawSol = notional / entryPrice; // SOL
    const lots = Math.max(0, Math.round(rawSol / LOT_SOL));
    const sizeSol = lots * LOT_SOL;
    if (sizeSol <= 0) return { lots: 0, sizeSol: 0, notional, actualMargin: 0 };
    const actualNotional = sizeSol * entryPrice;
    // The slider is a SIZING knob, not leverage. It never reaches the chain —
    // the instruction has no leverage field — and place_order.rs:181-183 always
    // computes compute_initial_margin(notional, market.max_leverage). Dividing
    // by `leverage` here claimed up to 20x more money was committed than the
    // program actually reserves (type $50 at 1x, the chain takes $2.50), and the
    // same wrong number gated the button, blocking orders the chain would have
    // accepted. requiredMarginAtoms above always had this right; only the
    // display path disagreed with it.
    const actualMargin = actualNotional / MAX_LEVERAGE;
    return { lots, sizeSol, notional: actualNotional, actualMargin };
  })();

  /** Whether `session` is this wallet's credit as the chain reported it.
   *  "stale" counts — those numbers are real, just possibly a few seconds old.
   *  "loading" and "unavailable" do not: every field is a placeholder zero or
   *  the previously connected wallet's. */
  const creditTrusted = sessionRead === "live" || sessionRead === "stale";
  const availUsd = creditTrusted && session.initialized ? Number(session.available) / PRICE_SCALE : 0;
  // Only claim the margin is too large when we know what the credit holds —
  // otherwise `availUsd` is a placeholder 0 and EVERY order looks insufficient.
  const insufficient =
    creditTrusted && derived != null && derived.actualMargin > availUsd + 1e-6;
  const belowOneLot = derived != null && derived.lots === 0;

  // Would a MARKET order of this size actually fill? A market remainder is not
  // rested and not rejected — place_order.rs:279-282 simply drops it — so an
  // order against an empty or thin book lands, fills nothing, and used to be
  // reported as an unqualified success with an explorer link.
  //
  // The chain walks the opposite ladder best-price-first and REVERTS the whole
  // order at the first level outside the slippage band (place_order.rs:409-412)
  // rather than skipping it, so reachable depth is a PREFIX of the ladder, not a
  // filter over it. The band is centred on the price the CHAIN uses — the mark —
  // not on `reference`, which prefers the oracle.
  // null = the order is fine (or we cannot honestly judge); a number = the SOL
  // actually reachable, which is less than the order asks for.
  const thinFillable: number | null = (() => {
    if (!isMarket || derived == null || derived.sizeSol <= 0) return null;
    // "loading", "stale" and "unavailable" are not evidence of a thin book —
    // never block a market order because the RPC hiccuped.
    if (bookStatus !== "live" && bookStatus !== "empty") return null;
    const ladder = side === "long" ? asks : bids;
    // buildLadders caps at depth 20, so a full 20 levels may be truncated and we
    // cannot claim to know the real depth.
    if (ladder.length >= 20) return null;
    const window = mark !== null && !stampStale ? (mark * effectiveBps) / 10_000 : null;
    let fillable = 0;
    for (const level of ladder) {
      if (window !== null && Math.abs(level.price - mark!) > window) break;
      fillable += level.size;
    }
    return fillable + 1e-9 < derived.sizeSol ? fillable : null;
  })();

  const handleSubmit = async () => {
    if (!publicKey) return;
    if (!session.delegated) {
      setLastErr("Start a trading session first (deposit + delegate credit)");
      return;
    }
    if (!derived || derived.sizeSol <= 0) {
      setLastErr("Enter an amount, a multiplier and a price to size the order");
      return;
    }

    setSubmitting(true);
    setLastErr(null);
    setLastSig(null);
    try {
      const sideVal = side === "long" ? SIDE_BID : SIDE_ASK;
      const typeVal = ORDER_TYPE_VALUES[orderType];
      const sizeVal = BigInt(Math.round(derived.sizeSol * 1e9));
      const priceVal =
        typeVal === ORDER_TYPE_MARKET ? 0n : BigInt(Math.round(parseFloat(price) * PRICE_SCALE));
      const slippageVal = typeVal === ORDER_TYPE_MARKET ? effectiveBps : 0;

      if (sizeVal <= 0n || sizeVal % LOT_SIZE !== 0n) {
        setLastErr("Size must round to at least one 0.1 SOL lot — increase the amount or the multiplier.");
        setSubmitting(false);
        return;
      }
      if (typeVal !== ORDER_TYPE_MARKET && (priceVal <= 0n || priceVal % TICK_SIZE !== 0n)) {
        setLastErr("Price must be a positive multiple of $0.001 (tick size).");
        setSubmitting(false);
        return;
      }
      if (typeVal !== ORDER_TYPE_MARKET) {
        const required = requiredMarginAtoms(sizeVal, priceVal);
        if (session.initialized && required > session.available) {
          setLastErr(
            `Insufficient credit: needs $${(Number(required) / PRICE_SCALE).toFixed(2)} margin, ` +
              `you have $${availUsd.toFixed(2)}. Lower the amount/multiplier or fund more credit.`
          );
          setSubmitting(false);
          return;
        }
      }

      const sessionKp = getSessionKeypair();
      const useSessionKey = session.sessionActive && sessionKp !== null;
      const signerPk = useSessionKey ? sessionKp!.publicKey : publicKey;

      const ix = createPlaceOrderInstruction(
        publicKey,
        MARKET_INDEX,
        {
          side: sideVal,
          orderType: typeVal,
          price: priceVal,
          size: sizeVal,
          expiryTs: 0n,
          maxSlippageBps: slippageVal,
        },
        PROGRAM_ID,
        signerPk
      );

      const tx = new Transaction().add(ix);
      const erConn = erConnection;
      const { blockhash } = await erConn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      let sig: string;
      if (useSessionKey) {
        tx.feePayer = sessionKp!.publicKey;
        tx.sign(sessionKp!);
        sig = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      } else {
        tx.feePayer = publicKey;
        sig = await sendTransaction(tx, erConn, { skipPreflight: false });
      }

      // Confirm by HTTP polling (NOT the WS subscription, which can't reach the
      // same-origin proxy and would hang forever).
      try {
        await confirmSignature(erConn, sig, { timeoutMs: 30_000 });
      } catch (confErr) {
        const confMsg = confErr instanceof Error ? confErr.message : String(confErr);
        let logs: string[] = [];
        let landed = false;
        try {
          const t = await erConn.getTransaction(sig, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          logs = t?.meta?.logMessages ?? [];
          // The poll timing out says nothing about whether the order landed.
          // We are already fetching the transaction for its logs — if it is
          // there and carries no error, this WAS a success, and reporting it as
          // a failure is what made traders place the order a second time.
          landed = t?.meta != null && t.meta.err == null;
        } catch {
          /* ignore — treated as "could not verify" below */
        }
        if (!landed) {
          const name = decodeProgramError({ message: confMsg, logs });
          // The signature is the only way the user can check for themselves, so
          // it must survive the failure path rather than being thrown away.
          setLastSig(sig);
          setLastErr(
            // humanizeError only when we KNOW it was an on-chain rejection: its
            // network branch says "nothing was sent", which is false once
            // sendRawTransaction has handed back a signature.
            name
              ? humanizeError({ message: confMsg, logs })
              : "Couldn't confirm in time — the order may still have landed. " +
                "Check the transaction before retrying."
          );
          return;
        }
      }

      setLastSig(sig);
      setMargin("");
    } catch (err) {
      // Everything reaching here failed BEFORE or DURING submission, which is
      // exactly the case humanizeError's wording is written for — and it is the
      // one decoder the other four submit paths in this app already share.
      setLastErr(humanizeError(err));
      console.error("order failed:", err);
    } finally {
      setSubmitting(false);
    }
  };


  const showPriceInput = !isMarket;
  // A market order takes whatever is resting at the best price, right now.
  // "Long - profits if price rises" describes a thesis, not that action; the
  // honest verb for crossing the book is buy/sell. A limit order really is
  // opening a directional position at a price you choose, so it keeps
  // long/short. Same instruction either way - only the label changes.
  const buyLabel = isMarket ? "Buy" : "Long";
  const sellLabel = isMarket ? "Sell" : "Short";
  const buyHint = isMarket ? "takes the best ask now" : "profits if price rises";
  const sellHint = isMarket ? "hits the best bid now" : "profits if price falls";
  const availLine = !creditTrusted
    ? "credit unknown"
    : session.initialized
      ? `${availUsd.toFixed(2)} available`
      : "no credit yet";
  const inputCls =
    "h-[34px] w-full rounded-[4px] border border-[var(--t-border-strong)] bg-[var(--t-surface)] px-[10px] pr-14 text-[13px] text-[var(--t-text)] tnum placeholder:text-[var(--t-text-3)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]";
  const suffixCls = "pointer-events-none absolute right-[10px] top-1/2 -translate-y-1/2 text-[11px] text-[var(--t-text-3)]";
  const labelCls = "text-[12px] text-[var(--t-text-2)]";
  const rowCls = "flex h-[22px] items-center justify-between border-b border-[var(--t-surface-2)] last:border-b-0";

  // "You have no credit" and "your credit is too small for this size" need
  // different answers, and the UI used to give the second answer to both. A
  // user with USDC in their wallet and an un-funded credit was told to "lower
  // it or fund more credit" with no indication that funding happens in the
  // Session panel, or that wallet USDC is not collateral until it is moved in.
  const noCreditAtAll = creditTrusted && session.delegated && session.available === 0n;

  const blocker = !publicKey
    ? "Connect a wallet to trade"
    : // "You have no session" is a claim about the chain, and we have not read
      // it. Both branches disable the button exactly as the old
      // `!session.delegated` did on these states — they only stop asserting
      // something false while doing it.
      !creditTrusted
      ? sessionRead === "loading"
        ? "Checking your trading session…"
        : "Can't reach Solana — trading session unknown"
      : !session.delegated
        ? "Start a trading session first"
        : !isMarket && (!price || parseFloat(price) <= 0)
            ? "Enter a limit price"
            : // A limit order sizes off the price the user typed, so it keeps
              // working with no usable mark. A market order cannot: the program
              // prices it from mark_price_for_close and reverts with OracleStale
              // when that is refused, so there is nothing honest to quote from.
              marketPriceBlock !== null
              ? marketPriceBlock
              : !derived || derived.sizeSol <= 0
                ? "Enter an amount"
                : belowOneLot
                  ? "Below the 0.1 SOL minimum lot"
                  : noCreditAtAll
                    ? "Fund trading credit to trade"
                    : thinFillable !== null
                      ? `Only ${thinFillable.toFixed(1)} SOL resting within slippage`
                      : insufficient
                        ? "Margin exceeds available credit"
                        : null;
  const disabled = submitting || blocker !== null;

  return (
    <div className="flex flex-col border border-[var(--t-border)] bg-[var(--t-bg)]">
      <div className="flex h-[40px] items-stretch gap-4 border-b border-[var(--t-border)] px-3" role="group" aria-label="Order type">
        {(["market", "limit"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setOrderType(t)}
            aria-pressed={orderType === t}
            className={`relative text-[13px] font-medium focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)] ${
              orderType === t
                ? "text-[var(--t-text)] after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-[var(--t-text)]"
                : "text-[var(--t-text-2)] hover:text-[var(--t-text)]"
            }`}
          >
            {t === "market" ? "Market" : "Limit"}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3 p-3">
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Order side">
          <button
            type="button"
            onClick={() => setSide("long")}
            aria-pressed={side === "long"}
            className={`flex h-[44px] items-center justify-center rounded-[4px] border text-[13px] font-medium focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)] ${
              side === "long"
                ? "border-[var(--t-up)] bg-[rgba(34,197,94,0.12)] text-[var(--t-up)]"
                : "border-[var(--t-border-strong)] bg-[var(--t-surface)] text-[var(--t-text-2)] hover:text-[var(--t-text)]"
            }`}
          >
            <span className="flex flex-col items-center leading-tight">
              <span>{buyLabel}</span>
              <span className="text-[10px] font-normal">{buyHint}</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setSide("short")}
            aria-pressed={side === "short"}
            className={`flex h-[44px] items-center justify-center rounded-[4px] border text-[13px] font-medium focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)] ${
              side === "short"
                ? "border-[var(--t-down)] bg-[rgba(239,68,68,0.12)] text-[var(--t-down)]"
                : "border-[var(--t-border-strong)] bg-[var(--t-surface)] text-[var(--t-text-2)] hover:text-[var(--t-text)]"
            }`}
          >
            <span className="flex flex-col items-center leading-tight">
              <span>{sellLabel}</span>
              <span className="text-[10px] font-normal">{sellHint}</span>
            </span>
          </button>
        </div>

        {showPriceInput ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <label htmlFor="order-price" className={labelCls}>Limit Price</label>
            </div>
            <div className="relative">
              <input
                id="order-price"
                type="number"
                step="0.001"
                inputMode="decimal"
                placeholder={markPrice ? markPrice.toFixed(3) : "0.00"}
                value={price}
                onChange={(ev) => setPrice(ev.target.value)}
                className={inputCls}
              />
              <span className={suffixCls}>USD</span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className={labelCls}>Execution</span>
            {/* Loading, unreachable, stale and priced are four different states
                and get four different sentences. Before, the last three all
                rendered as the first: the ", around X" clause simply vanished,
                so a dead crank looked like a slow page. */}
            {marketPriceBlock !== null ? (
              <p
                className={`text-[11.5px] ${
                  priceLoading ? "text-[var(--t-text-3)]" : "text-[var(--t-warn)]"
                }`}
              >
                {marketPriceBlock}
                {priceLoading
                  ? ""
                  : ". Market orders are refused until a trustworthy price returns — a limit order still works."}
              </p>
            ) : (
              <p className="text-[11.5px] text-[var(--t-text-3)]">
                Fills at the best price resting on the book
                {markPrice !== null ? <span className="tnum">, around {markPrice.toFixed(3)}</span> : ""}.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            {/* Not "Margin": what the chain commits is notional ÷ max_leverage,
                which this box does not name at any multiplier below 20×. It is
                one half of the notional the form builds. */}
            <label htmlFor="order-margin" className={labelCls}>Amount</label>
            <span className="text-[11.5px] text-[var(--t-text-3)] tnum">{availLine}</span>
          </div>
          <div className="relative">
            <input
              id="order-margin"
              type="number"
              step="1"
              inputMode="decimal"
              placeholder="0.00"
              value={margin}
              onChange={(ev) => setMargin(ev.target.value)}
              className={inputCls}
            />
            <span className={suffixCls}>USDC</span>
          </div>
          <div className="grid grid-cols-5 gap-1">
            {[10, 50, 100, 250].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMargin(String(m))}
                className="h-[26px] rounded-[4px] border border-[var(--t-border)] bg-[var(--t-surface)] text-[11.5px] text-[var(--t-text-2)] tnum hover:text-[var(--t-text)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]"
              >
                ${m}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setMargin(availUsd > 0 ? String(Math.floor(availUsd)) : "")}
              className="h-[26px] rounded-[4px] border border-[var(--t-border)] bg-[var(--t-surface)] text-[11.5px] text-[var(--t-text-2)] hover:text-[var(--t-text)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]"
            >
              Max
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            {/* NOT leverage. The instruction has no leverage field and
                place_order.rs:181-183 always margins at market.max_leverage, so
                calling this "Leverage" promised a 1x position the program will
                never open. All it does is scale notional = amount × multiplier. */}
            <label htmlFor="order-lev" className={labelCls}>Size multiplier</label>
            <span className="text-[12px] font-semibold text-[var(--t-up)] tnum">{leverage}×</span>
          </div>
          <input
            id="order-lev"
            type="range"
            min={1}
            max={MAX_LEVERAGE}
            step={1}
            value={leverage}
            onChange={(ev) => setLeverage(parseInt(ev.target.value, 10))}
            className="w-full cursor-pointer accent-[var(--t-up)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]"
          />
          <div className="flex justify-between text-[11px] text-[var(--t-text-3)] tnum">
            <span>1×</span><span>5×</span><span>10×</span><span>{MAX_LEVERAGE}×</span>
          </div>
          <p className="text-[11px] text-[var(--t-text-3)]">
            Notional = amount × multiplier. This market margins every position at{" "}
            {MAX_LEVERAGE}×, so the credit committed is notional ÷ {MAX_LEVERAGE} whatever the
            multiplier says.
          </p>
        </div>

        {orderType === "market" && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <label htmlFor="order-slippage" className={labelCls}>Max Slippage</label>
              <span className="text-[11.5px] text-[var(--t-text-3)]">basis points</span>
            </div>
            <div className="relative">
              <input
                id="order-slippage"
                type="number"
                step="1"
                min={1}
                max={65535}
                inputMode="numeric"
                placeholder="50"
                value={slippageBps}
                onChange={(ev) => setSlippageBps(ev.target.value)}
                className={inputCls}
              />
              <span className={suffixCls}>bps</span>
            </div>
          </div>
        )}

        <div className="flex flex-col">
          <div className={rowCls}>
            <span className={labelCls}>{isMarket ? "Action" : "Direction"}</span>
            <span className="text-[12px] text-[var(--t-text)]">{side === "long" ? buyLabel : sellLabel}</span>
          </div>
          <div className={rowCls}>
            <span className={labelCls}>Size</span>
            <span className="text-[12px] text-[var(--t-text)] tnum">
              {derived && derived.sizeSol > 0 ? `${derived.sizeSol.toFixed(1)} SOL` : "—"}
            </span>
          </div>
          <div className={rowCls}>
            <span className={labelCls}>Notional</span>
            <span className="text-[12px] text-[var(--t-text)] tnum">
              {derived && derived.sizeSol > 0 ? `$${derived.notional.toFixed(2)}` : "—"}
            </span>
          </div>
          <div className={rowCls}>
            {/* Was "Margin at risk" showing notional ÷ slider. The market
                margins EVERY position at max_leverage, so this is notional ÷ 20
                and nothing else — naming the divisor is the only way the row
                stops contradicting the "Available" tile in the Session panel. */}
            <span className={labelCls}>Margin required ({MAX_LEVERAGE}× market)</span>
            <span className="text-[12px] text-[var(--t-text)] tnum">
              {derived && derived.sizeSol > 0 ? `$${derived.actualMargin.toFixed(2)}` : "—"}
            </span>
          </div>
          <div className={rowCls}>
            <span className={labelCls}>Available credit</span>
            {/* An em dash, not "$0.00", when no read of this wallet's credit
                has landed — that zero is a placeholder, and the chain would
                contradict it for any funded account. */}
            <span className="text-[12px] text-[var(--t-text)] tnum">
              {creditTrusted ? `$${availUsd.toFixed(2)}` : "—"}
            </span>
          </div>
        </div>

        {!(derived && derived.sizeSol > 0) && (
          <p className="text-[11.5px] text-[var(--t-text-3)]">Enter an amount to size the order.</p>
        )}

        {belowOneLot && (
          <p className="text-[11.5px] text-[var(--t-warn)]">Too small — minimum is one 0.1 SOL lot. Increase the amount or the multiplier.</p>
        )}
        {thinFillable !== null && (
          <p className="text-[11.5px] text-[var(--t-warn)]">
            Only {thinFillable.toFixed(1)} SOL is resting within your {effectiveBps} bps slippage
            band. A market order does not rest its remainder — the program drops it — so the rest
            of this order would silently vanish. Reduce the size, widen the slippage, or use a
            limit order.
          </p>
        )}
        {noCreditAtAll && !belowOneLot && (
          <p className="text-[11.5px] text-[var(--t-warn)]">
            Your trading credit is empty. USDC in your wallet is not collateral yet — use{" "}
            <span className="font-semibold text-[var(--t-text)]">Start trading</span> in the Session
            panel below to move it into the market.
          </p>
        )}
        {insufficient && !noCreditAtAll && !belowOneLot && (
          <p className="text-[11.5px] text-[var(--t-down)]">
            Needs ${derived!.actualMargin.toFixed(2)} margin (notional ÷ {MAX_LEVERAGE}), you have $
            {availUsd.toFixed(2)}. Lower the amount or the multiplier, or add credit in the Session
            panel.
          </p>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled}
          className={`h-[38px] min-h-[38px] w-full rounded-[6px] text-[14px] font-semibold focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)] ${
            disabled
              ? "cursor-not-allowed bg-[var(--t-surface-3)] text-[var(--t-text-2)]"
              : side === "long"
                ? "bg-[var(--t-up-3)] text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)]"
                : "bg-[var(--t-down-3)] text-[var(--t-on-fill)] hover:bg-[var(--t-down-2)]"
          }`}
        >
          {submitting
            ? "Placing…"
            : blocker ?? `${side === "long" ? buyLabel : sellLabel} ${derived ? derived.sizeSol.toFixed(1) : "0.0"} SOL`}
        </button>

        {session.delegated && (
          <p className="text-[11.5px] text-[var(--t-text-3)]">
            {session.sessionActive
              ? "Session key active — orders sign locally, no wallet popup."
              : "No active session key — orders will prompt your wallet."}
          </p>
        )}
        {lastErr && <p className="text-[11.5px] break-all text-[var(--t-down)]">{lastErr}</p>}
        {lastSig && (
          <a
            href={explorerTx(lastSig, "er")}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11.5px] text-[var(--t-up)] hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]"
          >
            View tx on Explorer: <span className="tnum">{lastSig.slice(0, 12)}…{lastSig.slice(-8)}</span>
          </a>
        )}
      </div>
    </div>
  );
}
