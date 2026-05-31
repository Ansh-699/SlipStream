"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection, Transaction } from "@solana/web3.js";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { GlassFilter } from "@/components/ui/liquid-radio";
import { useSession } from "@/hooks/use-session";
import { useMarket } from "@/hooks/use-market";
import { LiquidGlassCard } from "@/components/ui/liquid-weather-glass";
import { LiquidButton } from "@/components/ui/liquid-glass-button";
import { PROGRAM_ID, MARKET_INDEX, ER_RPC, explorerTx } from "@/lib/manifest";
import { createPlaceOrderInstruction, PRICE_SCALE } from "@/lib/slipstream";
import { confirmSignature } from "@/lib/confirm";

type OrderType = "limit" | "market";
const ORDER_TYPE_VALUES: Record<OrderType, number> = { limit: 0, market: 4 };

// SOL-PERP market params (must match deploy.json / initialize_market).
const TICK_SIZE = 1_000n; // $0.001 in 6-dp price scale
const LOT_SIZE = 100_000_000n; // 0.1 SOL in 9-dp base atoms
const LOT_SOL = 0.1; // human lot
const MAX_LEVERAGE = 20;

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
  "LiquidationIntentNotReady", "GlobalPaused", "FillMarginExceeded",
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
      const sideVal = side === "long" ? 0 : 1;
      const typeVal = ORDER_TYPE_VALUES[orderType];
      const sizeVal = BigInt(Math.round(derived.sizeSol * 1e9));
      const priceVal =
        typeVal === 4 ? 0n : BigInt(Math.round(parseFloat(price) * PRICE_SCALE));
      const slippageVal = typeVal === 4 ? parseInt(slippageBps || "0", 10) : 0;

      if (sizeVal <= 0n || sizeVal % LOT_SIZE !== 0n) {
        setLastErr("Size must round to at least one 0.1 SOL lot — increase margin or leverage.");
        setSubmitting(false);
        return;
      }
      if (typeVal !== 4 && (priceVal <= 0n || priceVal % TICK_SIZE !== 0n)) {
        setLastErr("Price must be a positive multiple of $0.001 (tick size).");
        setSubmitting(false);
        return;
      }
      if (typeVal !== 4) {
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
      } catch (confErr: any) {
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
        const name = decodeProgramError({ message: confErr?.message ?? String(confErr), logs });
        setLastErr(name ? `Order rejected on-chain: ${name}` : confErr?.message ?? "Confirmation failed");
        return;
      }

      setLastSig(sig);
      setMargin("");
    } catch (err: any) {
      const name = decodeProgramError(err);
      setLastErr(name ? `Order rejected: ${name}` : err.message ?? String(err));
      console.error("order failed:", err);
    } finally {
      setSubmitting(false);
    }
  };

  const showPriceInput = orderType !== "market";
  const inputCls =
    "h-9 text-sm bg-black/5 dark:bg-black/20 border-black/10 dark:border-white/10 text-zinc-900 dark:text-white placeholder:text-zinc-400 dark:placeholder:text-white/40 focus-visible:ring-ring/40";

  return (
    <LiquidGlassCard shadowIntensity="none" glowIntensity="none" borderRadius="14px" className="glass-surface backdrop-blur-xl text-zinc-900 dark:text-white">
      <div className="px-4 pt-3.5 pb-2.5 border-b border-black/10 dark:border-white/10">
        <span className="panel-title">Place Order</span>
      </div>
      <div className="space-y-3 pt-3 px-4 pb-4">
        {/* Long / Short toggle */}
        <div className="inline-flex h-9 w-full rounded-md bg-black/5 dark:bg-black/20 p-0.5 border border-black/10 dark:border-white/10 shadow-inner">
          <RadioGroup
            value={side}
            onValueChange={(v) => setSide(v as any)}
            className="group w-full relative inline-grid grid-cols-[1fr_1fr] items-center gap-0 text-sm font-medium after:absolute after:inset-y-0 after:w-1/2 after:rounded-[4px] after:bg-black/10 dark:after:bg-white/20 after:backdrop-blur-md after:shadow-sm after:transition-transform after:duration-300 after:[transition-timing-function:cubic-bezier(0.16,1,0.3,1)] data-[state=short]:after:translate-x-full data-[state=long]:after:translate-x-0"
            data-state={side}
          >
            <div className="absolute top-0 left-0 isolate -z-10 h-full w-full overflow-hidden rounded-md" style={{ filter: 'url("#radio-glass")' }} />
            <label className="relative z-10 inline-flex h-full w-full cursor-pointer select-none items-center justify-center whitespace-nowrap px-4 transition-colors text-zinc-500 dark:text-white/60 group-data-[state=long]:text-emerald-600 dark:group-data-[state=long]:text-emerald-400 group-data-[state=long]:font-semibold">
              Long
              <RadioGroupItem id="side-long" value="long" className="sr-only" />
            </label>
            <label className="relative z-10 inline-flex h-full w-full cursor-pointer select-none items-center justify-center whitespace-nowrap px-4 transition-colors text-zinc-500 dark:text-white/60 group-data-[state=short]:text-rose-600 dark:group-data-[state=short]:text-rose-400 group-data-[state=short]:font-semibold">
              Short
              <RadioGroupItem id="side-short" value="short" className="sr-only" />
            </label>
            <GlassFilter />
          </RadioGroup>
        </div>

        {/* Order type */}
        <Tabs value={orderType} onValueChange={(v) => setOrderType(v as OrderType)}>
          <TabsList className="w-full grid grid-cols-2 bg-black/5 dark:bg-black/20 p-0.5 rounded-md border border-black/10 dark:border-white/10 shadow-inner h-9">
            <TabsTrigger value="limit" className="data-[state=active]:bg-black/10 dark:data-[state=active]:bg-white/20 text-zinc-500 dark:text-white/60 data-[state=active]:text-zinc-900 dark:data-[state=active]:text-white data-[state=active]:font-semibold rounded-[4px] transition-all text-xs">Limit</TabsTrigger>
            <TabsTrigger value="market" className="data-[state=active]:bg-black/10 dark:data-[state=active]:bg-white/20 text-zinc-500 dark:text-white/60 data-[state=active]:text-zinc-900 dark:data-[state=active]:text-white data-[state=active]:font-semibold rounded-[4px] transition-all text-xs">Market</TabsTrigger>
          </TabsList>
        </Tabs>

        {showPriceInput ? (
          <div className="space-y-1">
            <label className="text-xs text-zinc-600 dark:text-white/80 font-medium">Limit Price (USD)</label>
            <Input type="number" step="0.001" placeholder={markPrice ? markPrice.toFixed(3) : "0.00"} value={price} onChange={(e) => setPrice(e.target.value)} className={inputCls} />
          </div>
        ) : (
          <div className="text-[11px] text-zinc-500 dark:text-white/60 bg-black/5 dark:bg-white/5 rounded-md px-2.5 py-2">
            Market order fills at the best available price{markPrice ? ` (~$${markPrice.toFixed(3)})` : ""}.
          </div>
        )}

        {/* Margin ($) */}
        <div className="space-y-1">
          <label className="text-xs text-zinc-600 dark:text-white/80 font-medium">Margin (USD)</label>
          <Input type="number" step="1" placeholder="0.00" value={margin} onChange={(e) => setMargin(e.target.value)} className={inputCls} />
          <div className="flex gap-1.5">
            {[10, 50, 100, 250].map((m) => (
              <button key={m} onClick={() => setMargin(String(m))} className="flex-1 text-[10px] font-semibold py-1 rounded bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-zinc-600 dark:text-white/60 transition-colors">
                ${m}
              </button>
            ))}
            <button onClick={() => setMargin(availUsd > 0 ? String(Math.floor(availUsd)) : "")} className="flex-1 text-[10px] font-semibold py-1 rounded bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-zinc-600 dark:text-white/60 transition-colors">
              Max
            </button>
          </div>
        </div>

        {/* Leverage slider */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs text-zinc-600 dark:text-white/80 font-medium">Leverage</label>
            <span className="text-sm font-bold tnum text-emerald-500 dark:text-emerald-400">{leverage}x</span>
          </div>
          <input
            type="range"
            min={1}
            max={MAX_LEVERAGE}
            step={1}
            value={leverage}
            onChange={(e) => setLeverage(parseInt(e.target.value, 10))}
            className="w-full accent-emerald-500 cursor-pointer"
          />
          <div className="flex justify-between text-[9px] text-zinc-400 dark:text-white/40 font-medium">
            <span>1x</span><span>5x</span><span>10x</span><span>20x</span>
          </div>
        </div>

        {orderType === "market" && (
          <div className="space-y-1">
            <label className="text-xs text-zinc-600 dark:text-white/80 font-medium">Max Slippage (bps)</label>
            <Input type="number" step="1" placeholder="50" value={slippageBps} onChange={(e) => setSlippageBps(e.target.value)} className={inputCls} />
          </div>
        )}

        {/* Derived position summary */}
        <div className="rounded-lg bg-black/5 dark:bg-white/[0.04] border border-black/10 dark:border-white/[0.07] px-3 py-2 space-y-1">
          <SummaryRow label="Position size" value={derived ? `${derived.sizeSol.toFixed(1)} SOL` : "—"} />
          <SummaryRow label="Notional" value={derived ? `$${derived.notional.toFixed(2)}` : "—"} />
          <SummaryRow
            label="Margin required"
            value={derived ? `$${derived.actualMargin.toFixed(2)}` : "—"}
            danger={insufficient}
          />
          <SummaryRow label="Available credit" value={session.initialized ? `$${availUsd.toFixed(2)}` : "—"} muted />
        </div>

        {belowOneLot && (
          <div className="text-[11px] text-amber-500 dark:text-amber-400">
            Too small — minimum is one 0.1 SOL lot. Increase margin or leverage.
          </div>
        )}
        {insufficient && !belowOneLot && (
          <div className="text-[11px] text-rose-500 dark:text-rose-400">
            Margin required exceeds available credit. Lower it or fund more credit.
          </div>
        )}

        {session.delegated && (
          <div className="text-[10px] text-zinc-500 dark:text-white/50">
            {session.sessionActive
              ? "Session key active — orders sign locally, no wallet popup."
              : "No active session key — orders will prompt your wallet."}
          </div>
        )}

        <LiquidButton
          size="lg"
          onClick={handleSubmit}
          disabled={!publicKey || !session.delegated || submitting || insufficient || belowOneLot || !derived || derived.sizeSol <= 0 || (orderType !== "market" && (!price || parseFloat(price) <= 0))}
          className={`w-full font-semibold mt-1 rounded-xl backdrop-blur-md ${
            side === "long"
              ? "bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-950 dark:text-emerald-50 shadow-[0_4px_24px_rgba(16,185,129,0.35)]"
              : "bg-rose-500/20 hover:bg-rose-500/30 text-rose-950 dark:text-rose-50 shadow-[0_4px_24px_rgba(244,63,94,0.3)]"
          }`}
        >
          {submitting ? "Placing…" : `${side === "long" ? "Long" : "Short"}${derived && derived.sizeSol > 0 ? ` ${derived.sizeSol.toFixed(1)} SOL` : ""}`}
        </LiquidButton>

        {lastErr && <div className="text-xs text-rose-500 dark:text-rose-400 break-all">{lastErr}</div>}
        {lastSig && (
          <a
            href={explorerTx(lastSig, "er")}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-emerald-400 hover:text-emerald-300 break-all inline-flex items-center gap-1 underline decoration-dotted underline-offset-2"
          >
            View tx on Explorer: {lastSig.slice(0, 12)}…{lastSig.slice(-8)}
          </a>
        )}
      </div>
    </LiquidGlassCard>
  );
}

function SummaryRow({
  label,
  value,
  danger,
  muted,
}: {
  label: string;
  value: string;
  danger?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-zinc-500 dark:text-white/45">{label}</span>
      <span
        className={`font-mono font-semibold tnum ${
          danger ? "text-rose-500 dark:text-rose-400" : muted ? "text-zinc-500 dark:text-white/50" : "text-zinc-900 dark:text-white"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
