"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { MIN_SOL_LAMPORTS, useSession } from "@/hooks/use-session";
import { useWallet } from "@/hooks/use-wallet-compat";

const PRICE_SCALE = 1_000_000;
const LAMPORTS_PER_SOL = 1_000_000_000;

// The SOL floor is IMPORTED, not restated. This file used to declare its own
// 20_000_000 while the two preflights in use-session.ts refuse at 10_000_000,
// so a wallet holding 0.015 SOL was shown the amber "setup can't run yet"
// warning and then completed setup without a hitch. A warning that fires for
// states the gate lets through teaches the user to ignore it.

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
  const {
    state,
    status: read,
    busy,
    step,
    error,
    notice,
    autoStart,
    withdraw,
    requestFaucet,
    rotate,
    closeLegacyCredit,
  } = useSession(0);
  const { publicKey, connected, connect, exportWallet } = useWallet();

  const address = publicKey?.toBase58() ?? null;
  const inProtocol = state.freeCollateral + state.credit;

  /**
   * Whether the numbers in `state` are this wallet's, as the chain reported
   * them. See SessionStatus in use-session.ts: under "loading" no read has
   * completed for this owner yet and under "unavailable" every read failed, so
   * in BOTH cases every field is either a placeholder zero or the PREVIOUSLY
   * connected wallet's — rendering them as money says "$0.00, you have
   * nothing" about a wallet we have simply not managed to read. "stale" IS
   * trustworthy, just possibly a few seconds behind, so it keeps its numbers
   * and gets a line saying so.
   */
  const trusted = read === "live" || read === "stale";
  /** Money, or an em dash when we have no right to claim a figure. */
  const money = (atoms: bigint) => (trusted ? usd(atoms) : "—");

  const lowSol = trusted && state.solBalance < BigInt(MIN_SOL_LAMPORTS);

  const status = !connected
    ? "disconnected"
    : read === "loading"
      ? "checking"
      : read === "unavailable"
        ? "unknown"
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

  // Disable ONLY on zeros we are currently certain of. This used to read the
  // placeholder zeros of a read that had not happened (or had failed) as "this
  // wallet is empty" and greyed the primary button out on a funded wallet with
  // nothing on screen to explain it. Leaving it enabled while the RPC is down
  // is safe: autoStart re-reads the ATA itself and surfaces the real failure
  // through humanizeError instead of silently depositing nothing.
  const startDisabled = busy || (read === "live" && state.usdcBalance === 0n && inProtocol === 0n);

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
              : status === "setup" || status === "unknown"
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
            <button type="button" onClick={connect} className={primaryBtn(false)}>
              Create wallet / sign in
            </button>
          </div>
        ) : (
          <>
            <WalletIdentity address={address} exportWallet={exportWallet} />

            <div className="grid grid-cols-2 gap-2">
              <Stat label="USDC" value={money(state.usdcBalance)} hint="In your wallet" />
              <Stat
                label="SOL"
                value={trusted ? (Number(state.solBalance) / LAMPORTS_PER_SOL).toFixed(4) : "—"}
                hint="For network fees"
                amber={lowSol}
              />
            </div>

            {/* A failed read is not an empty wallet, and the panel has to say
             *  which one it is looking at. "stale" still has real numbers on
             *  screen — the last ones we got — so it says they may be behind;
             *  "unavailable" has em dashes, so it says why. */}
            {(read === "stale" || read === "unavailable") && (
              <p role="status" className="text-[10px] leading-tight text-[var(--t-warn)]">
                {read === "stale"
                  ? "Can’t reach Solana — these are the last balances we read, retrying."
                  : "Can’t reach Solana — balances unknown, retrying."}
              </p>
            )}

            <button
              type="button"
              onClick={requestFaucet}
              disabled={busy}
              className={`w-full ${SECONDARY_BTN} ${busy ? "cursor-not-allowed" : ""}`}
            >
              {busy && step?.includes("USDC") ? "…" : "Get test USDC"}
            </button>

            {/* Point at the button that fixes it. "Send some to the address
             *  above" asked a user with an embedded wallet and no second wallet
             *  to solve it out-of-band, when the button directly above this line
             *  tops up SOL as well as USDC (/api/faucet drips both). */}
            {lowSol && (
              <p className="text-[10px] leading-tight text-[var(--t-warn)]">
                This wallet needs about {(MIN_SOL_LAMPORTS / LAMPORTS_PER_SOL).toFixed(3)} devnet
                SOL for fees and account rent before setup can run. “Get test USDC” above tops up
                SOL too — or send some to the address above.
              </p>
            )}

            {/* Money that has left the wallet and is inside the protocol.
             *  Shown whenever we cannot vouch for the read too: hiding the
             *  whole block on an unreadable chain is indistinguishable from
             *  "you have nothing in the market", which is the one thing we do
             *  not know at that moment. */}
            {(inProtocol > 0n || state.initialized || read === "unavailable") && (
              <div className="space-y-2 pt-0.5">
                <div className="flex items-center gap-2">
                  <div className="h-px flex-1 bg-[var(--t-border)]" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-3)]">
                    In the market
                  </span>
                  <div className="h-px flex-1 bg-[var(--t-border)]" />
                </div>
                {/* Three columns, not two. `freeCollateral` — the UserAccount
                 *  balance — was decoded on every poll and rendered nowhere,
                 *  and it is where close_position pays back your margin AND
                 *  your realized PnL (close_position.rs:228), where settlement
                 *  pays maker rebates (settle_from_log.rs:302) and where
                 *  funding lands (claim_funding.rs:100). So closing a winning
                 *  trade made money disappear from the panel: every figure on
                 *  screen dropped by the margin that was just released, and
                 *  the profit never showed up anywhere. It only reappeared on
                 *  "Withdraw all to wallet", which withdraws exactly this. */}
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="Committed" value={money(state.committed)} hint="In open orders" amber />
                  <Stat label="Available" value={money(state.available)} hint="Free to trade" emerald />
                  <Stat label="Settled" value={money(state.freeCollateral)} hint="Closed trades" />
                </div>
              </div>
            )}

            {/* `trusted &&` because this offers a transaction: right after a
             *  wallet switch `state` is still the PREVIOUS wallet's until the
             *  first read lands, and "Close legacy credit" would send against
             *  the new one on a diagnosis made about the old one. */}
            {trusted && state.legacyCredit && <LegacyNotice {...{ state, busy, closeLegacyCredit }} />}

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

            {!(trusted && state.delegated) ? (
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
                  {!trusted
                    ? "Moves your USDC into the market and opens a rollup session. One wallet approval — after that, orders sign instantly with no popups."
                    : state.usdcBalance > 0n
                      ? `Moves your ${usd(state.usdcBalance)} into the market and opens a rollup session. One wallet approval — after that, orders sign instantly with no popups.`
                      : inProtocol > 0n
                        ? // Wallet USDC is 0 but money is already inside the
                          // protocol — a half-finished withdraw, or a session
                          // that was undelegated. "Get test USDC first" is
                          // false advice here: oneShotSetup re-delegates what
                          // is already there without needing a single atom more.
                          `Re-opens a rollup session on the ${usd(inProtocol)} already in the market. One wallet approval.`
                        : "Get test USDC first — then this moves it into the market and opens your trading session."}
                </p>
              </div>
            ) : (
              <SessionKeyCard {...{ state, busy, rotate, expiresIn }} />
            )}

            {/* Withdraw is NOT part of the delegated arm any more. A withdraw
             *  that dies between its legs strands the money in a state the old
             *  placement could not reach: undelegate landed but release did not
             *  (credit > 0, not delegated) hid this button entirely, and release
             *  landed but the transfer did not (credit 0, freeCollateral > 0)
             *  left "Start trading" as the only control — which re-funds and
             *  re-delegates the very money the user was trying to take out.
             *  Both are `inProtocol > 0n`, and withdraw() is already resumable
             *  leg by leg, so one click finishes whichever half is missing.
             *  Kept for a delegated-but-empty credit too: that one still needs
             *  an undelegate, and this is the only button that sends it. */}
            {trusted && (state.delegated || inProtocol > 0n) && (
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
                    : state.delegated
                      ? "Leaves the rollup, releases your credit and returns the USDC here. Takes a few seconds to settle."
                      : "Your funds are in the market but off the rollup — this releases them and returns the USDC to your wallet."}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Address row with copy-to-clipboard, an optional QR for funding the wallet
 * from elsewhere, and — for the embedded wallet only — Privy's export-key
 * escape hatch. This is the "fund this wallet" affordance: on devnet there is
 * no card onramp, so the paths are a transfer from another devnet wallet (the
 * address + QR) or the faucet button below.
 */
function WalletIdentity({
  address,
  exportWallet,
}: {
  address: string | null;
  exportWallet: (() => Promise<void>) | null;
}) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

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

  // Rendered lazily: the QR is only wanted when the user is about to fund the
  // wallet from elsewhere, and encoding is main-thread work.
  useEffect(() => {
    if (!showQr || !address) return;
    let cancelled = false;
    QRCode.toDataURL(address, { margin: 1, width: 160 }).then(
      (url) => {
        if (!cancelled) setQr(url);
      },
      () => {
        if (!cancelled) setQr(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [showQr, address]);

  if (!address) return null;
  const short = `${address.slice(0, 4)}…${address.slice(-4)}`;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--t-text-3)]">Your wallet</span>
          <span className="truncate font-mono text-[12px] text-[var(--t-text)]" title={address}>
            {short}
          </span>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={() => setShowQr((v) => !v)}
            aria-expanded={showQr}
            className={SECONDARY_BTN}
          >
            {showQr ? "Hide QR" : "Show QR"}
          </button>
          <button
            type="button"
            onClick={copy}
            aria-label={copied ? "Address copied" : "Copy wallet address"}
            className={SECONDARY_BTN}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      {showQr && (
        <div className="flex flex-col items-center gap-1.5 rounded-[6px] border border-[var(--t-border)] bg-[var(--t-surface)] p-3">
          {qr ? (
            // A data: URL cannot go through next/image; the size is fixed.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="Wallet address as a QR code" width={160} height={160} className="rounded-[4px]" />
          ) : (
            <span className={HINT}>Generating…</span>
          )}
          <p className={`${HINT} max-w-[24ch] text-center`}>
            Devnet only: send test SOL or USDC here from another devnet wallet, or use Get test USDC below.
          </p>
        </div>
      )}
      {exportWallet && (
        <button
          type="button"
          onClick={() => void exportWallet()}
          className={`${HINT} underline underline-offset-2 transition-colors hover:text-[var(--t-text-2)] ${FOCUS}`}
        >
          Export private key
        </button>
      )}
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
