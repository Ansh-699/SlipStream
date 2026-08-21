"use client";

import { useState } from "react";
import { useWallet } from "@/hooks/use-wallet-compat";
import { Connection, Transaction } from "@solana/web3.js";
import { useSession } from "@/hooks/use-session";
import { useMarket } from "@/hooks/use-market";
import { LiquidGlassCard } from "@/components/ui/liquid-weather-glass";
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

  return (
    <LiquidGlassCard shadowIntensity="none" glowIntensity="none" borderRadius="14px" className="glass-surface backdrop-blur-xl text-zinc-900 dark:text-white">
      <div className="px-4 pt-3.5 pb-2.5 border-b border-black/10 dark:border-white/10">
        <span className="panel-title">Place Order</span>
      </div>
      <div className="order-form">
        <div className="order-side" role="group" aria-label="Order side">
          <button type="button" onClick={() => setSide("long")} aria-pressed={side === "long"} className="order-side-btn order-side-long">
            <span className="order-side-name">Long</span>
            <span className="order-side-sub">profits if price rises</span>
          </button>
          <button type="button" onClick={() => setSide("short")} aria-pressed={side === "short"} className="order-side-btn order-side-short">
            <span className="order-side-name">Short</span>
            <span className="order-side-sub">profits if price falls</span>
          </button>
        </div>

        <div className="order-field">
          <div className="order-field-head">
            <label htmlFor="order-price" className="order-label">{showPriceInput ? "Limit price" : "Execution"}</label>
            <div className="order-seg" role="group" aria-label="Order type">
              <button type="button" onClick={() => setOrderType("limit")} aria-pressed={orderType === "limit"} className="order-seg-btn">Limit</button>
              <button type="button" onClick={() => setOrderType("market")} aria-pressed={orderType === "market"} className="order-seg-btn">Market</button>
            </div>
          </div>
          {showPriceInput ? (
            <input id="order-price" type="number" step="0.001" inputMode="decimal" placeholder={markPrice ? markPrice.toFixed(3) : "0.00"} value={price} onChange={(ev) => setPrice(ev.target.value)} className="order-input" />
          ) : (
            <p className="order-note">Fills at the best price resting on the book{markPrice ? `, around ${markPrice.toFixed(3)}` : ""}.</p>
          )}
        </div>

        <div className="order-field">
          <div className="order-field-head">
            <label htmlFor="order-margin" className="order-label">Margin (USD)</label>
            <span className="order-aside">{session.initialized ? `${availUsd.toFixed(2)} available` : "no credit yet"}</span>
          </div>
          <input id="order-margin" type="number" step="1" inputMode="decimal" placeholder="0.00" value={margin} onChange={(ev) => setMargin(ev.target.value)} className="order-input" />
          <div className="order-chips">
            {[10, 50, 100, 250].map((m) => (
              <button key={m} type="button" onClick={() => setMargin(String(m))} className="order-chip">${m}</button>
            ))}
            <button type="button" onClick={() => setMargin(availUsd > 0 ? String(Math.floor(availUsd)) : "")} className="order-chip">Max</button>
          </div>
        </div>

        <div className="order-field">
          <div className="order-field-head">
            <label htmlFor="order-lev" className="order-label">Leverage</label>
            <span className="order-lev">{leverage}×</span>
          </div>
          <input id="order-lev" type="range" min={1} max={MAX_LEVERAGE} step={1} value={leverage} onChange={(ev) => setLeverage(parseInt(ev.target.value, 10))} className="order-range" />
          <div className="order-scale"><span>1×</span><span>5×</span><span>10×</span><span>{MAX_LEVERAGE}×</span></div>
        </div>

        {orderType === "market" && (
          <div className="order-field">
            <div className="order-field-head">
              <label htmlFor="order-slippage" className="order-label">Max slippage</label>
              <span className="order-aside">basis points</span>
            </div>
            <input id="order-slippage" type="number" step="1" inputMode="numeric" placeholder="50" value={slippageBps} onChange={(ev) => setSlippageBps(ev.target.value)} className="order-input" />
          </div>
        )}

        <p className="order-commit">
          {derived && derived.sizeSol > 0 ? (
            <>
              {side === "long" ? "Long" : "Short"} <b>{derived.sizeSol.toFixed(1)} SOL</b> — <span className="order-num">${derived.notional.toFixed(2)}</span> notional,{" "}
              <span className="order-num">${derived.actualMargin.toFixed(2)}</span> of your{" "}
              <span className="order-num">${availUsd.toFixed(2)}</span> credit at risk.
            </>
          ) : (
            "Enter a margin amount to size the order."
          )}
        </p>

        {belowOneLot && <p className="order-alert order-alert-warn">Too small — minimum is one 0.1 SOL lot. Increase margin or leverage.</p>}
        {insufficient && !belowOneLot && <p className="order-alert order-alert-bad">Margin required exceeds available credit. Lower it or fund more credit.</p>}

        {(() => {
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
          return (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || blocker !== null}
              className={`order-cta ${side === "long" ? "order-cta-long" : "order-cta-short"}`}
            >
              {submitting
                ? "Placing…"
                : blocker ?? `${side === "long" ? "Long" : "Short"} ${derived ? derived.sizeSol.toFixed(1) : "0.0"} SOL`}
            </button>
          );
        })()}

        {session.delegated && (
          <p className="order-foot">
            {session.sessionActive
              ? "Session key active — orders sign locally, no wallet popup."
              : "No active session key — orders will prompt your wallet."}
          </p>
        )}
        {lastErr && <p className="order-err">{lastErr}</p>}
        {lastSig && (
          <a href={explorerTx(lastSig, "er")} target="_blank" rel="noopener noreferrer" className="order-link">
            View tx on Explorer: {lastSig.slice(0, 12)}…{lastSig.slice(-8)}
          </a>
        )}
      </div>
    </LiquidGlassCard>
  );
}

