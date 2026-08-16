"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/use-session";

const PRICE_SCALE = 1_000_000;

export function SessionPanel() {
  const { state, busy, step, error, notice, autoStart, withdraw, requestFaucet, rotate, closeLegacyCredit } = useSession(0);
  const [depositAmt, setDepositAmt] = useState("1000");

  const usdcBal = Number(state.usdcBalance) / PRICE_SCALE;
  /** Money already inside the protocol — setup can finish without a new deposit. */
  const hasFunds = state.freeCollateral > 0n || state.credit > 0n;
  const depositNum = parseFloat(depositAmt || "0");
  const canStart =
    !busy && (hasFunds || (depositNum > 0 && usdcBal > 0 && depositNum <= usdcBal));

  const status = !state.initialized
    ? "uninitialized"
    : state.delegated
      ? "active"
      : "idle";

  // Clock state (30s tick) so the countdown re-renders and render stays pure.
  const [nowSec, setNowSec] = useState(0);
  useEffect(() => {
    const tick = () => setNowSec(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  // Human "expires in …" string from the on-chain session expiry.
  const expiresIn = (() => {
    if (!state.sessionActive || state.sessionExpiry === 0n || nowSec === 0) return null;
    const secs = Number(state.sessionExpiry) - nowSec;
    if (secs <= 0) return "expired";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  })();

  return (
    <div className="panel">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-white/[0.06]">
        <span className="panel-title">Trading Session</span>
        <span
          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
            status === "active"
              ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/25"
              : status === "idle"
              ? "text-amber-300 bg-amber-500/10 border-amber-500/25"
              : "text-white/50 bg-white/5 border-white/10"
          }`}
        >
          {status}
        </span>
      </div>
      <div className="space-y-3 px-4 pt-3 pb-4">
        {/* Money-flow breakdown: Collateral -> Credit -> (Committed | Available) */}
        <div className="grid grid-cols-2 gap-2">
          <FlowStat
            label="Collateral"
            value={state.freeCollateral}
            hint="Deposited, idle"
          />
          <FlowStat label="Credit" value={state.credit} hint="Allocated to market" />
          <FlowStat label="Committed" value={state.committed} hint="Locked in orders" amber />
          <FlowStat label="Available" value={state.available} hint="Free to trade" emerald />
        </div>

        {/* Legacy (pre-upgrade) credit detected: guide migration. */}
        {state.legacyCredit && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 space-y-1.5">
            <div className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">
              Legacy trading-credit detected
            </div>
            {state.legacyDelegated ? (
              <div className="text-[10px] leading-tight text-muted-foreground">
                Your existing credit predates the session-keys upgrade and is
                delegated to the rollup, so it can&apos;t be migrated in place.
                Use a fresh wallet to start the new popup-less flow. (Your legacy
                devnet funds stay where they are.)
              </div>
            ) : (
              <>
                <div className="text-[10px] leading-tight text-muted-foreground">
                  Your existing credit predates the session-keys upgrade. Close it
                  to reclaim rent, then deposit again to create a new
                  session-enabled credit.
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full h-8 text-xs"
                  onClick={closeLegacyCredit}
                  disabled={busy}
                >
                  {busy ? "…" : "Close legacy credit"}
                </Button>
              </>
            )}
          </div>
        )}

        {/* Live status: loading step / error / success — so the user always
            knows whether deposit/ER succeeded or why it didn't. */}
        {step && (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-[11px] text-emerald-200">
            <span className="h-3 w-3 rounded-full border-2 border-emerald-300/40 border-t-emerald-300 animate-spin" />
            {step}
          </div>
        )}
        {error && (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-200 break-words">
            {error}
          </div>
        )}
        {notice && !error && !step && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-[11px] text-emerald-200 break-words">
            {notice}
          </div>
        )}

        {/* Setup in one click: deposit → allocate to market → open ER session. */}
        {!state.delegated && (
          <div className="space-y-2">
            {/* Wallet USDC balance + faucet for new wallets. */}
            <div className="flex items-center justify-between rounded-md bg-white/[0.03] border border-white/[0.06] px-2.5 py-2">
              <div className="flex flex-col">
                <span className="text-[9px] uppercase tracking-wider text-white/40 font-semibold">
                  Wallet USDC
                </span>
                <span className="font-mono font-bold text-sm tnum text-white">
                  ${usdcBal.toFixed(2)}
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={requestFaucet}
                disabled={busy}
              >
                {busy && step?.includes("USDC") ? "…" : "Get test USDC"}
              </Button>
            </div>
            {usdcBal <= 0 && !hasFunds && (
              <div className="text-[10px] leading-tight text-amber-400">
                New wallet detected with no test USDC. Click “Get test USDC” to
                mint some (devnet test tokens), then start trading.
              </div>
            )}

            <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
              Deposit collateral (USDC)
            </label>
            <Input
              type="number"
              step="1"
              placeholder="1000"
              value={depositAmt}
              onChange={(e) => setDepositAmt(e.target.value)}
              className="h-9 text-sm"
            />
            <Button
              size="lg"
              onClick={() => autoStart(parseFloat(depositAmt || "0"))}
              disabled={!canStart}
              className="w-full font-semibold bg-emerald-600 text-white hover:bg-emerald-600/90"
            >
              {busy ? "…" : hasFunds && !state.initialized ? "Resume setup" : "Start trading"}
            </Button>
            <div className="text-[10px] text-muted-foreground">
              Deposits your USDC, allocates it to the market, and opens a rollup
              session so every order signs instantly — no wallet popups.
            </div>
          </div>
        )}

        {state.delegated && (
          <div className="space-y-2">
            <div className="text-[10px] leading-tight text-muted-foreground font-medium">
              Session active — orders execute on the Ephemeral Rollup at sub-second
              latency. {state.activeOrders} resting order{state.activeOrders === 1 ? "" : "s"}.
            </div>

            {/* Session-key status: shows whether orders sign locally (no popup). */}
            <div className="rounded-md border p-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                  Session key
                </span>
                <Badge
                  variant={state.sessionActive ? "default" : "secondary"}
                  className="text-[10px] px-1.5 py-0"
                >
                  {state.sessionActive ? `active · ${expiresIn}` : "none"}
                </Badge>
              </div>
              <div className="text-[10px] leading-tight text-muted-foreground">
                {state.sessionActive ? (
                  <>
                    Orders are signed locally by an in-browser key —{" "}
                    <span className="font-semibold">no wallet popup per order</span>.
                    The key can ONLY place/cancel orders within your capped credit
                    and expires automatically. Withdraw/delegate still need your
                    wallet.
                  </>
                ) : (
                  <>
                    No active session key — orders will prompt your wallet each
                    time. Rotate to create a fresh in-browser key (one signature).
                  </>
                )}
              </div>
              {state.sessionPublicKey && (
                <div className="text-[10px] font-mono text-muted-foreground break-all">
                  {state.sessionPublicKey.slice(0, 8)}…{state.sessionPublicKey.slice(-8)}
                </div>
              )}
              <Button
                size="sm"
                variant="outline"
                className="w-full h-8 text-xs"
                onClick={rotate}
                disabled={busy}
              >
                {busy ? "…" : state.sessionActive ? "Rotate session key" : "New session key"}
              </Button>
            </div>

            {/* Full exit: off the rollup, out of credit, back to the wallet. */}
            <div className="rounded-md border p-2 space-y-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Cash out
              </span>
              <div className="text-[10px] leading-tight text-muted-foreground">
                Returns everything to your wallet: leaves the rollup, releases
                your credit, then sends the USDC back. Takes a few seconds while
                the rollup settles.
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-full h-8 text-xs"
                onClick={withdraw}
                disabled={busy || state.activeOrders > 0}
              >
                {busy ? "…" : "Withdraw all"}
              </Button>
              {state.activeOrders > 0 && (
                <div className="text-[10px] text-amber-500">
                  Cancel your open orders first.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FlowStat({
  label,
  value,
  hint,
  emerald,
  amber,
}: {
  label: string;
  value: bigint;
  hint: string;
  emerald?: boolean;
  amber?: boolean;
}) {
  const color = emerald ? "text-emerald-400" : amber ? "text-amber-300" : "text-white";
  return (
    <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] px-2.5 py-2">
      <div className="text-[9px] text-white/40 font-semibold uppercase tracking-wider">
        {label}
      </div>
      <div className={`font-mono font-bold text-sm tnum ${color}`}>
        ${(Number(value) / PRICE_SCALE).toFixed(2)}
      </div>
      <div className="text-[9px] text-white/30 font-medium mt-0.5">{hint}</div>
    </div>
  );
}
