"use client";

import { useState } from "react";
import { useWallet } from "@/hooks/use-wallet-compat";
import { Connection, Transaction } from "@solana/web3.js";
import { useSession } from "@/hooks/use-session";
import { useMarket } from "@/hooks/use-market";
import {
  PROGRAM_ID,
  MARKET_INDEX,
  ER_RPC,
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
} from "@/lib/slipstream";
import { confirmSignature } from "@/lib/confirm";

type OrderType = "limit" | "market";
const ORDER_TYPE_VALUES: Record<OrderType, number> = { limit: ORDER_TYPE_LIMIT, market: ORDER_TYPE_MARKET };

// Market params (TICK_SIZE / LOT_SIZE / LOT_SOL / MAX_LEVERAGE) now come from
// the Deploy_Manifest via @/lib/manifest — single source of truth with the
// on-chain market, so re-initializing at different params can't drift the UI.

// Required initial margin in 6-dp credit terms, mirroring the (now FIXED)
// on-chain math: notional = size_atoms * price_6dp / 1e9 ; margin = notional / lev.
function requiredMarginAtoms(sizeAtoms: bigint, price6dp: bigint): bigint {
  if (sizeAtoms <= 0n || price6dp <= 0n) return 0n;
  const notional = (sizeAtoms * price6dp) / 1_000_000_000n; // BASE_SCALE
  return notional / BigInt(MAX_LEVERAGE);
}

const ERR_NAMES = [
  "InvalidDiscriminator", "InvalidAuthority", "InvalidPda", "InvalidOracle", "OracleStale",
  "MarketPaused", "CircuitBreakerTripped", "InsufficientCollateral", "InsufficientMargin", "WithdrawalGateFailed",
  "PendingFillsExist", "ReservedMarginExists", "SameSlotWithdrawal", "OrderBookFull", "PriceLevelsFull",
  "InvalidOrderPrice", "InvalidOrderSize", "InvalidOrderSide", "InvalidOrderType", "OrderNotFound",
  "NotOrderOwner", "PostOnlyWouldCross", "FokCannotFill", "SlippageExceeded", "PositionNotFound",
  "PositionNotLiquidatable", "HealthFactorAboveThreshold", "InsuranceFundInsufficient", "InvalidFillSequence", "FillQueueEmpty",
  "FillQueueFull", "MathOverflow", "MathUnderflow", "DivisionByZero", "InvalidMarketIndex",
  "MaxOrdersPerUser", "InvalidExpiryTimestamp", "AccountAlreadyInitialized", "AccountNotInitialized", "InvalidTokenMint",
  "InvalidVault", "InvalidProgramId", "InsufficientCredit", "CreditStillActive", "TickSizeViolation",
  "LotSizeViolation", "OracleDisagreement", "RestrictedMode", "InvalidSwitchboardFeed", "GracePeriodActive",
  "LiquidationIntentNotReady", "GlobalPaused", "FillMarginExceeded", "TriggerConditionNotMet",
  "SelfTrade", "PositionStillOpen",
];

function decodeProgramError(input: unknown): string | null {
  const anyErr = input as { message?: string; logs?: string[] } | null;
  const logs = Array.isArray(anyErr?.logs) ? anyErr!.logs! : [];
  const hay = [anyErr?.message ?? String(input), ...logs].join("\n");
  const hex = hay.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  const dec = hay.match(/Custom\((\d+)\)/);
  const code = hex ? parseInt(hex[1], 16) : dec ? parseInt(dec[1], 10) : null;
  if (code === null) return null;
  const idx = code - 0x100;
  return idx >= 0 && idx < ERR_NAMES.length ? ERR_NAMES[idx] : `custom 0x${code.toString(16)}`;
}

export function OrderForm() {
  const { publicKey, sendTransaction } = useWallet();
  const { state: session, getSessionKeypair } = useSession(0);
  const { market } = useMarket(0);
  const markPrice = market && market.lastMarkPrice > 0n ? Number(market.lastMarkPrice) / PRICE_SCALE : null;

  const [side, setSide] = useState<"long" | "short">("long");
  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [price, setPrice] = useState("");
  const [margin, setMargin] = useState(""); // dollars the trader posts
  const [leverage, setLeverage] = useState(5);
  const [slippageBps, setSlippageBps] = useState("50");
  const [submitting, setSubmitting] = useState(false);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [lastErr, setLastErr] = useState<string | null>(null);

  // Effective entry price used for sizing: the limit price, or the live mark for market.
  const entryPrice =
    orderType === "limit" ? (price ? parseFloat(price) : null) : markPrice;

  // Derive position size from margin × leverage ÷ price, rounded to whole lots.
  const derived = (() => {
    const m = parseFloat(margin);
    if (!Number.isFinite(m) || m <= 0 || !entryPrice || entryPrice <= 0) return null;
    const notional = m * leverage; // $ position value
    const rawSol = notional / entryPrice; // SOL
    const lots = Math.max(0, Math.round(rawSol / LOT_SOL));
    const sizeSol = lots * LOT_SOL;
    if (sizeSol <= 0) return { lots: 0, sizeSol: 0, notional, actualMargin: 0 };
    // Actual margin after lot rounding = notional(rounded) / leverage.
    const actualNotional = sizeSol * entryPrice;
    const actualMargin = actualNotional / leverage;
    return { lots, sizeSol, notional: actualNotional, actualMargin };
  })();

  const availUsd = session.initialized ? Number(session.available) / PRICE_SCALE : 0;
  const insufficient = derived != null && derived.actualMargin > availUsd + 1e-6;
  const belowOneLot = derived != null && derived.lots === 0;

  const handleSubmit = async () => {
    if (!publicKey) return;
    if (!session.delegated) {
      setLastErr("Start a trading session first (deposit + delegate credit)");
      return;
    }
    if (!derived || derived.sizeSol <= 0) {
      setLastErr("Enter margin, leverage, and a price to size the order");
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
      const slippageVal = typeVal === ORDER_TYPE_MARKET ? parseInt(slippageBps || "0", 10) : 0;

      if (sizeVal <= 0n || sizeVal % LOT_SIZE !== 0n) {
        setLastErr("Size must round to at least one 0.1 SOL lot — increase margin or leverage.");
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
              `you have $${availUsd.toFixed(2)}. Lower margin/leverage or fund more credit.`
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
      const erConn = new Connection(ER_RPC, "confirmed");
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
        try {
          const t = await erConn.getTransaction(sig, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          logs = t?.meta?.logMessages ?? [];
        } catch {
          /* ignore */
        }
        const name = decodeProgramError({ message: confMsg, logs });
        setLastErr(name ? `Order rejected on-chain: ${name}` : confMsg || "Confirmation failed");
        return;
      }

      setLastSig(sig);
      setMargin("");
    } catch (err) {
      const name = decodeProgramError(err);
      setLastErr(
        name
          ? `Order rejected: ${name}`
          : err instanceof Error
            ? err.message
            : String(err)
      );
      console.error("order failed:", err);
    } finally {
      setSubmitting(false);
    }
  };


  const showPriceInput = orderType !== "market";
  const availLine = session.initialized ? `${availUsd.toFixed(2)} available` : "no credit yet";
  const inputCls =
    "h-[34px] w-full rounded-[4px] border border-[#1d2224] bg-[#121516] px-[10px] pr-14 text-[13px] text-[#e6e9ea] tnum placeholder:text-[#838c92] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#22c55e]";
  const suffixCls = "pointer-events-none absolute right-[10px] top-1/2 -translate-y-1/2 text-[11px] text-[#838c92]";
  const labelCls = "text-[12px] text-[#a2abb1]";
  const rowCls = "flex h-[22px] items-center justify-between border-b border-[#15191a] last:border-b-0";

  const blocker = !publicKey
    ? "Connect a wallet to trade"
    : !session.delegated
      ? "Start a trading session first"
      : orderType !== "market" && (!price || parseFloat(price) <= 0)
        ? "Enter a limit price"
        : !derived || derived.sizeSol <= 0
          ? "Enter a margin amount"
          : belowOneLot
            ? "Below the 0.1 SOL minimum lot"
            : insufficient
              ? "Margin exceeds available credit"
              : null;
  const disabled = submitting || blocker !== null;

  return (
    <div className="flex flex-col border border-[#1d2224] bg-[#0b0d0e]">
      <div className="flex h-[40px] items-stretch gap-4 border-b border-[#1d2224] px-3" role="group" aria-label="Order type">
        {(["market", "limit"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setOrderType(t)}
            aria-pressed={orderType === t}
            className={`relative text-[13px] font-medium focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#22c55e] ${
              orderType === t
                ? "text-[#e6e9ea] after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-[#e6e9ea]"
                : "text-[#a2abb1] hover:text-[#e6e9ea]"
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
            className={`flex h-[44px] items-center justify-center rounded-[4px] border text-[13px] font-medium focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#22c55e] ${
              side === "long"
                ? "border-[#22c55e] bg-[rgba(34,197,94,0.12)] text-[#22c55e]"
                : "border-[#1d2224] bg-[#121516] text-[#a2abb1] hover:text-[#e6e9ea]"
            }`}
          >
            <span className="flex flex-col items-center leading-tight">
              <span>Long</span>
              <span className="text-[10px] font-normal opacity-80">profits if price rises</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setSide("short")}
            aria-pressed={side === "short"}
            className={`flex h-[44px] items-center justify-center rounded-[4px] border text-[13px] font-medium focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#22c55e] ${
              side === "short"
                ? "border-[#ef4444] bg-[rgba(239,68,68,0.12)] text-[#ef4444]"
                : "border-[#1d2224] bg-[#121516] text-[#a2abb1] hover:text-[#e6e9ea]"
            }`}
          >
            <span className="flex flex-col items-center leading-tight">
              <span>Short</span>
              <span className="text-[10px] font-normal opacity-80">profits if price falls</span>
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
            <p className="text-[11.5px] text-[#838c92]">
            Fills at the best price resting on the book
            {markPrice ? <span className="tnum">, around {markPrice.toFixed(3)}</span> : ""}.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <label htmlFor="order-margin" className={labelCls}>Margin</label>
            <span className="text-[11.5px] text-[#838c92] tnum">{availLine}</span>
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
                className="h-[26px] rounded-[4px] border border-[#1d2224] bg-[#121516] text-[11.5px] text-[#a2abb1] tnum hover:text-[#e6e9ea] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#22c55e]"
              >
                ${m}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setMargin(availUsd > 0 ? String(Math.floor(availUsd)) : "")}
              className="h-[26px] rounded-[4px] border border-[#1d2224] bg-[#121516] text-[11.5px] text-[#a2abb1] hover:text-[#e6e9ea] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#22c55e]"
            >
              Max
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <label htmlFor="order-lev" className={labelCls}>Leverage</label>
            <span className="text-[12px] font-semibold text-[#22c55e] tnum">{leverage}×</span>
          </div>
          <input
            id="order-lev"
            type="range"
            min={1}
            max={MAX_LEVERAGE}
            step={1}
            value={leverage}
            onChange={(ev) => setLeverage(parseInt(ev.target.value, 10))}
            className="w-full cursor-pointer accent-[#22c55e] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#22c55e]"
          />
          <div className="flex justify-between text-[11px] text-[#838c92] tnum">
            <span>1×</span><span>5×</span><span>10×</span><span>{MAX_LEVERAGE}×</span>
          </div>
        </div>

        {orderType === "market" && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <label htmlFor="order-slippage" className={labelCls}>Max Slippage</label>
              <span className="text-[11.5px] text-[#838c92]">basis points</span>
            </div>
            <div className="relative">
              <input
                id="order-slippage"
                type="number"
                step="1"
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
            <span className={labelCls}>Direction</span>
            <span className="text-[12px] text-[#e6e9ea]">{side === "long" ? "Long" : "Short"}</span>
          </div>
          <div className={rowCls}>
            <span className={labelCls}>Size</span>
            <span className="text-[12px] text-[#e6e9ea] tnum">
              {derived && derived.sizeSol > 0 ? `${derived.sizeSol.toFixed(1)} SOL` : "—"}
            </span>
          </div>
          <div className={rowCls}>
            <span className={labelCls}>Notional</span>
            <span className="text-[12px] text-[#e6e9ea] tnum">
              {derived && derived.sizeSol > 0 ? `$${derived.notional.toFixed(2)}` : "—"}
            </span>
          </div>
          <div className={rowCls}>
            <span className={labelCls}>Margin at risk</span>
            <span className="text-[12px] text-[#e6e9ea] tnum">
              {derived && derived.sizeSol > 0 ? `$${derived.actualMargin.toFixed(2)}` : "—"}
            </span>
          </div>
          <div className={rowCls}>
            <span className={labelCls}>Available credit</span>
            <span className="text-[12px] text-[#e6e9ea] tnum">${availUsd.toFixed(2)}</span>
          </div>
        </div>

        {!(derived && derived.sizeSol > 0) && (
          <p className="text-[11.5px] text-[#838c92]">Enter a margin amount to size the order.</p>
        )}

        {belowOneLot && (
          <p className="text-[11.5px] text-[#f59e0b]">Too small — minimum is one 0.1 SOL lot. Increase margin or leverage.</p>
        )}
        {insufficient && !belowOneLot && (
          <p className="text-[11.5px] text-[#ef4444]">Margin required exceeds available credit. Lower it or fund more credit.</p>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled}
          className={`h-[38px] min-h-[38px] w-full rounded-[6px] text-[14px] font-semibold focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#22c55e] ${
            disabled
              ? "cursor-not-allowed bg-[#171b1c] text-[#a2abb1]"
              : side === "long"
                ? "bg-[#16794f] text-white hover:bg-[#1c9463]"
                : "bg-[#a93436] text-white hover:bg-[#c04447]"
          }`}
        >
          {submitting
            ? "Placing…"
            : blocker ?? `${side === "long" ? "Long" : "Short"} ${derived ? derived.sizeSol.toFixed(1) : "0.0"} SOL`}
        </button>

        {session.delegated && (
          <p className="text-[11.5px] text-[#838c92]">
            {session.sessionActive
              ? "Session key active — orders sign locally, no wallet popup."
              : "No active session key — orders will prompt your wallet."}
          </p>
        )}
        {lastErr && <p className="text-[11.5px] break-all text-[#ef4444]">{lastErr}</p>}
        {lastSig && (
          <a
            href={explorerTx(lastSig, "er")}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11.5px] text-[#22c55e] hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#22c55e]"
          >
            View tx on Explorer: <span className="tnum">{lastSig.slice(0, 12)}…{lastSig.slice(-8)}</span>
          </a>
        )}
      </div>
    </div>
  );
}
