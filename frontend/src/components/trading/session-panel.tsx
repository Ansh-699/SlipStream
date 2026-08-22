"use client";

import { useCallback, useEffect, useState } from "react";
import { useModal } from "@phantom/react-sdk";
import { useSession } from "@/hooks/use-session";
import { useWallet } from "@/hooks/use-wallet-compat";

const PRICE_SCALE = 1_000_000;
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Enough SOL to cover fees plus rent for the UserAccount/TradingCredit/Position
 *  PDAs that setup creates. Below this, setup fails partway with a signing
 *  error, so warn before the user starts rather than after. */
const MIN_SOL_LAMPORTS = 20_000_000; // 0.02 SOL

const FOCUS = "focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]";
const SECONDARY_BTN =
  `h-[28px] rounded-[4px] border border-[var(--t-border)] bg-[var(--t-surface)] px-2.5 text-[12px] text-[var(--t-text-2)] transition-colors hover:text-[var(--t-text)] disabled:pointer-events-none disabled:text-[var(--t-text-3)] disabled:border-[var(--t-border)] disabled:cursor-not-allowed ${FOCUS}`;
const HINT = "text-[10px] leading-tight text-[var(--t-text-3)]";

function primaryBtn(disabled: boolean) {
  return `h-[34px] w-full rounded-[6px] text-[13px] font-semibold ${FOCUS} ${
    disabled ? "cursor-not-allowed bg-[var(--t-surface-3)] text-[var(--t-text-2)]" : "bg-[var(--t-up-3)] text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)]"
  }`;
}

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

  const startDisabled = busy || (state.usdcBalance === 0n && inProtocol === 0n);

  return (
    <div>
      <div className="flex h-[36px] items-center justify-between border-b border-[var(--t-border)] px-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-2)]">
          Wallet
        </span>
        <span
          className={`rounded-[4px] px-1.5 py-0.5 text-[10px] ${
            status === "trading"
              ? "bg-[rgba(34,197,94,0.12)] text-[var(--t-up)]"
              : status === "setup"
                ? "bg-[rgba(245,158,11,0.12)] text-[var(--t-warn)]"
                : "bg-[var(--t-surface)] text-[var(--t-text-2)]"
          }`}
        >
          {status}
        </span>
      </div>

      <div className="space-y-3 p-3">
        {!connected ? (
          <div className="space-y-2.5">
            <p className="text-[11.5px] leading-relaxed text-[var(--t-text-2)]">
              Sign in to create your in-app wallet. It holds your funds, signs
              your trades, and needs no browser extension.
            </p>
            <button type="button" onClick={open} className={primaryBtn(false)}>
              Create wallet / sign in
            </button>
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

            <button
              type="button"
              onClick={requestFaucet}
              disabled={busy}
              className={`w-full ${SECONDARY_BTN} ${busy ? "cursor-not-allowed" : ""}`}
            >
              {busy && step?.includes("USDC") ? "…" : "Get test USDC"}
            </button>

            {lowSol && (
              <p className="text-[10px] leading-tight text-[var(--t-warn)]">
                This wallet needs a little devnet SOL for fees and account rent
                before setup can run. Send some to the address above.
              </p>
            )}

            {/* Money that has left the wallet and is inside the protocol. */}
            {(inProtocol > 0n || state.initialized) && (
              <div className="space-y-2 pt-0.5">
                <div className="flex items-center gap-2">
                  <div className="h-px flex-1 bg-[var(--t-border)]" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-3)]">
                    In the market
                  </span>
                  <div className="h-px flex-1 bg-[var(--t-border)]" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="Committed" value={usd(state.committed)} hint="Locked in orders" amber />
                  <Stat label="Available" value={usd(state.available)} hint="Free to trade" emerald />
                </div>
              </div>
            )}

            {state.legacyCredit && <LegacyNotice {...{ state, busy, closeLegacyCredit }} />}

            {step && (
              <div className="flex items-center gap-2 text-[11.5px] text-[var(--t-text-2)]">
                <span
                  aria-hidden
                  className="h-3 w-3 shrink-0 rounded-full border-2 border-[var(--t-border)] border-t-[var(--t-up)] animate-spin"
                />
                {step}
              </div>
            )}
            {error && (
              <div role="alert" className="break-words text-[11.5px] leading-tight text-[var(--t-down)]">
                {error}
              </div>
            )}
            {notice && !error && !step && (
              <div className="break-words text-[11.5px] leading-tight text-[var(--t-text-2)]">{notice}</div>
            )}

            {!state.delegated ? (
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => autoStart()}
                  disabled={startDisabled}
                  className={primaryBtn(startDisabled)}
                >
                  {busy ? "…" : "Start trading"}
                </button>
                <p className={HINT}>
                  {state.usdcBalance > 0n
                    ? `Moves your ${usd(state.usdcBalance)} into the market and opens a rollup session. One wallet approval — after that, orders sign instantly with no popups.`
                    : "Get test USDC first — then this moves it into the market and opens your trading session."}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <SessionKeyCard {...{ state, busy, rotate, expiresIn }} />
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={withdraw}
                    disabled={busy || state.activeOrders > 0}
                    className={`w-full ${SECONDARY_BTN} ${
                      busy || state.activeOrders > 0 ? "cursor-not-allowed" : ""
                    }`}
                  >
                    {busy ? "…" : "Withdraw all to wallet"}
                  </button>
                  <p className={HINT}>
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
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--t-text-3)]">Your wallet</span>
        <span className="truncate font-mono text-[12px] text-[var(--t-text)]" title={address}>
          {short}
        </span>
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Address copied" : "Copy wallet address"}
        className={`shrink-0 ${SECONDARY_BTN}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
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
    <div className="space-y-1.5 rounded-[4px] border border-[var(--t-border)] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--t-text-3)]">Trading session</span>
        <span
          className={`rounded-[4px] bg-[var(--t-surface)] px-1.5 py-0.5 text-[10px] ${
            state.sessionActive ? "text-[var(--t-up)]" : "text-[var(--t-text-2)]"
          }`}
        >
          {state.sessionActive ? `active · ${expiresIn}` : "none"}
        </span>
      </div>
      <p className={HINT}>
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
      <button
        type="button"
        onClick={rotate}
        disabled={busy}
        className={`w-full ${SECONDARY_BTN} ${busy ? "cursor-not-allowed" : ""}`}
      >
        {busy ? "…" : state.sessionActive ? "Rotate session key" : "New session key"}
      </button>
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
    <div className="space-y-1.5 rounded-[4px] border border-[var(--t-border)] p-2.5">
      <div className="text-[11.5px] font-semibold text-[var(--t-warn)]">Legacy trading-credit detected</div>
      {state.legacyDelegated ? (
        <p className={HINT}>
          This credit predates the session-keys upgrade and is delegated to the
          rollup, so it can&apos;t be migrated in place. Use a fresh wallet to
          start the new flow — your existing devnet funds stay where they are.
        </p>
      ) : (
        <>
          <p className={HINT}>
            This credit predates the session-keys upgrade. Close it to reclaim
            the rent, then start again to create a session-enabled one.
          </p>
          <button
            type="button"
            onClick={closeLegacyCredit}
            disabled={busy}
            className={`w-full ${SECONDARY_BTN} ${busy ? "cursor-not-allowed" : ""}`}
          >
            {busy ? "…" : "Close legacy credit"}
          </button>
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
  const color = emerald ? "text-[var(--t-up)]" : amber ? "text-[var(--t-warn)]" : "text-[var(--t-text)]";
  return (
    <div className="rounded-[4px] border border-[var(--t-border)] bg-[var(--t-surface)] px-[10px] py-2">
      <div className="text-[10px] uppercase tracking-[0.06em] text-[var(--t-text-3)]">{label}</div>
      <div className={`text-[14px] font-semibold tnum ${color}`}>{value}</div>
      <div className={`${HINT} mt-0.5`}>{hint}</div>
    </div>
  );
}
