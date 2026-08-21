"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useModal } from "@phantom/react-sdk";
import { useSession } from "@/hooks/use-session";
import { useWallet } from "@/hooks/use-wallet-compat";

const PRICE_SCALE = 1_000_000;
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Enough SOL to cover fees plus rent for the UserAccount/TradingCredit/Position
 *  PDAs that setup creates. Below this, setup fails partway with a signing
 *  error, so warn before the user starts rather than after. */
const MIN_SOL_LAMPORTS = 20_000_000; // 0.02 SOL

const usd = (atoms: bigint) =>
  `$${(Number(atoms) / PRICE_SCALE).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export function SessionPanel() {
  const { state, busy, step, error, notice, autoStart, withdraw, requestFaucet, rotate, closeLegacyCredit } =
    useSession(0);
  const { publicKey, connected } = useWallet();
  const { open } = useModal();

  const address = publicKey?.toBase58() ?? null;
  const inProtocol = state.freeCollateral + state.credit;
  const lowSol = state.solBalance < BigInt(MIN_SOL_LAMPORTS);

  const status = !connected
    ? "disconnected"
    : !state.initialized
      ? "ready"
      : state.delegated
        ? "trading"
        : "setup";

  // Clock tick (30s) so the session countdown re-renders without impurity.
  const [nowSec, setNowSec] = useState(0);
  useEffect(() => {
    const tick = () => setNowSec(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

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
        <span className="panel-title">Wallet</span>
        <span
          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
            status === "trading"
              ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/25"
              : status === "setup"
                ? "text-amber-300 bg-amber-500/10 border-amber-500/25"
                : "text-white/50 bg-white/5 border-white/10"
          }`}
        >
          {status}
        </span>
      </div>

      <div className="space-y-3 px-4 pt-3 pb-4">
        {!connected ? (
          <div className="space-y-2.5">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Sign in to create your in-app wallet. It holds your funds, signs
              your trades, and needs no browser extension.
            </p>
            <Button
              size="lg"
              onClick={open}
              className="w-full font-semibold bg-emerald-700 text-emerald-50 hover:bg-emerald-700/90"
            >
              Create wallet / sign in
            </Button>
          </div>
        ) : (
          <>
            <WalletIdentity address={address} />

            <div className="grid grid-cols-2 gap-2">
              <Stat label="USDC" value={usd(state.usdcBalance)} hint="In your wallet" />
              <Stat
                label="SOL"
                value={(Number(state.solBalance) / LAMPORTS_PER_SOL).toFixed(4)}
                hint="For network fees"
                amber={lowSol}
              />
            </div>

            <Button
              size="sm"
              variant="outline"
              className="w-full h-9 text-xs"
              onClick={requestFaucet}
              disabled={busy}
            >
              {busy && step?.includes("USDC") ? "…" : "Get test USDC"}
            </Button>

            {lowSol && (
              <p className="text-[10px] leading-tight text-amber-700 dark:text-amber-400">
                This wallet needs a little devnet SOL for fees and account rent
                before setup can run. Send some to the address above.
              </p>
            )}

            {/* Money that has left the wallet and is inside the protocol. */}
            {(inProtocol > 0n || state.initialized) && (
              <div className="space-y-2 pt-0.5">
                <div className="flex items-center gap-2">
                  <div className="h-px flex-1 bg-white/[0.06]" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    In the market
                  </span>
                  <div className="h-px flex-1 bg-white/[0.06]" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="Committed" value={usd(state.committed)} hint="Locked in orders" amber />
                  <Stat label="Available" value={usd(state.available)} hint="Free to trade" emerald />
                </div>
              </div>
            )}

            {state.legacyCredit && <LegacyNotice {...{ state, busy, closeLegacyCredit }} />}

            {step && (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-[11px] text-emerald-800 dark:text-emerald-200">
                <span
                  aria-hidden
                  className="h-3 w-3 rounded-full border-2 border-emerald-500/40 border-t-emerald-500 animate-spin"
                />
                {step}
              </div>
            )}
            {error && (
              <div role="alert" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-800 dark:text-rose-200 break-words">
                {error}
              </div>
            )}
            {notice && !error && !step && (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-[11px] text-emerald-800 dark:text-emerald-200 break-words">
                {notice}
              </div>
            )}

            {!state.delegated ? (
              <div className="space-y-1.5">
                <Button
                  size="lg"
                  onClick={() => autoStart()}
                  disabled={busy || (state.usdcBalance === 0n && inProtocol === 0n)}
                  className="w-full font-semibold bg-emerald-700 text-emerald-50 hover:bg-emerald-700/90"
                >
                  {busy ? "…" : "Start trading"}
                </Button>
                <p className="text-[10px] leading-tight text-muted-foreground">
                  {state.usdcBalance > 0n
                    ? `Moves your ${usd(state.usdcBalance)} into the market and opens a rollup session, so every order signs instantly with no popups.`
                    : "Get test USDC first — then this moves it into the market and opens your trading session."}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <SessionKeyCard {...{ state, busy, rotate, expiresIn }} />
                <div className="space-y-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full h-9 text-xs"
                    onClick={withdraw}
                    disabled={busy || state.activeOrders > 0}
                  >
                    {busy ? "…" : "Withdraw all to wallet"}
                  </Button>
                  <p className="text-[10px] leading-tight text-muted-foreground">
                    {state.activeOrders > 0
                      ? "Cancel your open orders first."
                      : "Leaves the rollup, releases your credit and returns the USDC here. Takes a few seconds to settle."}
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Address row with copy-to-clipboard and transient confirmation. */
function WalletIdentity({ address }: { address: string | null }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    if (!address) return;
    navigator.clipboard.writeText(address).then(
      () => setCopied(true),
      () => setCopied(false)
    );
  }, [address]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  if (!address) return null;
  const short = `${address.slice(0, 4)}…${address.slice(-4)}`;

  return (
    <div className="flex items-center justify-between rounded-lg bg-white/[0.03] border border-white/[0.06] px-2.5 py-2">
      <div className="flex flex-col min-w-0">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          Your wallet
        </span>
        <span className="font-mono text-xs text-foreground truncate" title={address}>
          {short}
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-8 text-xs shrink-0"
        onClick={copy}
        aria-label={copied ? "Address copied" : "Copy wallet address"}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function SessionKeyCard({
  state,
  busy,
  rotate,
  expiresIn,
}: {
  state: ReturnType<typeof useSession>["state"];
  busy: boolean;
  rotate: () => void;
  expiresIn: string | null;
}) {
  return (
    <div className="rounded-md border p-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          Trading session
        </span>
        <Badge variant={state.sessionActive ? "default" : "secondary"} className="text-[10px] px-1.5 py-0">
          {state.sessionActive ? `active · ${expiresIn}` : "none"}
        </Badge>
      </div>
      <p className="text-[10px] leading-tight text-muted-foreground">
        {state.sessionActive ? (
          <>
            Orders are signed locally by a temporary key — no popup per trade. It
            can only place and cancel orders within your funded credit, and it
            expires on its own. Moving money always needs your wallet.
          </>
        ) : (
          <>No active session key — orders will prompt your wallet each time.</>
        )}
      </p>
      <Button size="sm" variant="outline" className="w-full h-8 text-xs" onClick={rotate} disabled={busy}>
        {busy ? "…" : state.sessionActive ? "Rotate session key" : "New session key"}
      </Button>
    </div>
  );
}

function LegacyNotice({
  state,
  busy,
  closeLegacyCredit,
}: {
  state: ReturnType<typeof useSession>["state"];
  busy: boolean;
  closeLegacyCredit: () => void;
}) {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 space-y-1.5">
      <div className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">
        Legacy trading-credit detected
      </div>
      {state.legacyDelegated ? (
        <p className="text-[10px] leading-tight text-muted-foreground">
          This credit predates the session-keys upgrade and is delegated to the
          rollup, so it can&apos;t be migrated in place. Use a fresh wallet to
          start the new flow — your existing devnet funds stay where they are.
        </p>
      ) : (
        <>
          <p className="text-[10px] leading-tight text-muted-foreground">
            This credit predates the session-keys upgrade. Close it to reclaim
            the rent, then start again to create a session-enabled one.
          </p>
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
  );
}

function Stat({
  label,
  value,
  hint,
  emerald,
  amber,
}: {
  label: string;
  value: string;
  hint: string;
  emerald?: boolean;
  amber?: boolean;
}) {
  const color = emerald
    ? "text-emerald-600 dark:text-emerald-400"
    : amber
      ? "text-amber-700 dark:text-amber-300"
      : "text-foreground";
  return (
    <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] px-2.5 py-2">
      <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
        {label}
      </div>
      <div className={`font-mono font-bold text-sm tnum ${color}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground/70 font-medium mt-0.5">{hint}</div>
    </div>
  );
}
