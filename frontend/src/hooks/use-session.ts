"use client";

import { erConnection } from "@/lib/connections";
import { startPoll } from "@/lib/poll";
import { useCallback, useEffect, useState, useRef } from "react";
import { useWallet, useConnection } from "@/hooks/use-wallet-compat";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import { PROGRAM_ID, USDC_MINT, USDC_VAULT, ER_RPC } from "@/lib/manifest";
import {
  DELEGATION_PROGRAM_ID,
  DISC_TRADING_CREDIT,
  DISC_USER_ACCOUNT,
  PRICE_SCALE,
  TRADING_CREDIT_SIZE,
  decodeTradingCredit,
  decodeUserAccount,
  isSessionActive,
  findTradingCreditPda,
  findUserAccountPda,
  createInitializeUserInstruction,
  createDepositCollateralInstruction,
  createInitializeTradingCreditInstruction,
  createFundTradingCreditInstruction,
  createDelegateTradingCreditInstruction,
  createAuthorizeSessionInstruction,
  createCloseTradingCreditInstruction,
  createInitializePositionInstruction,
  createUndelegateTradingCreditInstruction,
  createWithdrawTradingCreditInstruction,
  createWithdrawCollateralInstruction,
  decodeGlobalState,
  findGlobalStatePda,
  findPositionPda,
  MAGIC_CONTEXT_ID,
} from "@/lib/slipstream";
import { confirmSignature } from "@/lib/confirm";

const DELEGATION_PROGRAM = DELEGATION_PROGRAM_ID.toBase58();

/** Session lifetime (seconds). The browser session key is authorized for this
 *  long; after it expires the user must rotate (one signature) to keep trading
 *  popup-less. 24h keeps a leaked key's blast radius bounded. */
/** Rent for UserAccount(56B) + TradingCredit(96B) + Position(96B) = 4_398_720
 *  lamports, plus fees and delegate()'s own account creations. Rounded up. */
const MIN_SOL_LAMPORTS = 10_000_000; // 0.01 SOL

const SESSION_TTL_SECS = 24 * 60 * 60;

/** A tiny SOL float optionally sent to the session key on delegate so it can
 *  pay ER tx fees IF the rollup required the fee payer to hold lamports.
 *
 *  FINDING (verified live on devnet): the MagicBlock devnet ER SPONSORS fees —
 *  a session-signed place_order succeeded with the session key holding ZERO SOL.
 *  So funding is NOT needed and defaults to 0. Operators can still set
 *  NEXT_PUBLIC_SESSION_FUND_SOL > 0 (e.g. for a rollup that charges the payer)
 *  without any other change. */
const SESSION_FUND_SOL = Number(
  process.env.NEXT_PUBLIC_SESSION_FUND_SOL ?? "0"
);

/** Lightweight namespaced console logger so each step of the deposit/ER flow is
 *  visible in the browser console with timing — makes "did it work?" answerable. */
function slog(step: string, msg: string, extra?: unknown): void {
  const ts = new Date().toISOString().split("T")[1].replace("Z", "");
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`%c[session ${ts}] ${step}: ${msg}`, "color:#34d399", extra);
  } else {
    // eslint-disable-next-line no-console
    console.log(`%c[session ${ts}] ${step}: ${msg}`, "color:#34d399");
  }
}

/** Turn an on-chain / wallet error into a short, human, actionable message. */
function humanizeError(err: unknown): string {
  const anyErr = err as { message?: string; logs?: string[]; name?: string } | null;
  const logs = Array.isArray(anyErr?.logs) ? anyErr!.logs! : [];
  const hay = [anyErr?.message ?? String(err), ...logs].join("\n");

  if (/insufficient (lamports|funds for rent|funds)/i.test(hay)) {
    return "Not enough devnet SOL to pay fees/rent. Airdrop some SOL to your wallet and retry.";
  }
  if (/could not find account|account does not exist|invalid account owner|TokenAccountNotFound/i.test(hay)) {
    return "You have no test USDC yet. Click “Get test USDC” first, then deposit.";
  }
  if (/0x1|insufficient/i.test(hay) && /transfer/i.test(hay)) {
    return "USDC transfer failed — your balance is lower than the deposit amount.";
  }
  if (/User rejected|rejected the request|cancelled/i.test(hay)) {
    return "You rejected the transaction in your wallet.";
  }
  if (/blockhash|expired|timed out/i.test(hay)) {
    return "Network was slow and the transaction expired. Please retry.";
  }
  return anyErr?.message ?? String(err);
}

export interface SessionState {
  initialized: boolean;
  delegated: boolean;
  credit: bigint;
  committed: bigint;
  available: bigint;
  activeOrders: number;
  /** Free collateral deposited in the on-chain UserAccount (not yet in credit). */
  freeCollateral: bigint;
  /** The wallet's SPL USDC balance (atoms, 6-dp). 0n if no ATA / no balance. */
  usdcBalance: bigint;
  /** The wallet's native SOL balance in lamports — needed for fees and PDA
   *  rent. A freshly created embedded wallet starts at zero, so the panel has
   *  to be able to say so rather than letting setup fail at signing time. */
  solBalance: bigint;
  userInitialized: boolean;
  /** The persisted session key's pubkey (base58), or null if none stored. */
  sessionPublicKey: string | null;
  /** Whether the on-chain credit currently authorizes a non-expired session. */
  sessionActive: boolean;
  /** On-chain session expiry (unix secs); 0 = none. */
  sessionExpiry: bigint;
  /** A pre-upgrade (e.g. 56-byte) credit that cannot be decoded at the current
   *  layout and must be migrated before the new session flow can be used. */
  legacyCredit: boolean;
  /** Whether a detected legacy credit is delegated (cannot be closed in place;
   *  the user must migrate via a fresh wallet) vs program-owned (closable). */
  legacyDelegated: boolean;
}

// ---------------------------------------------------------------------------
// Ephemeral session-key storage (localStorage, per owner+market).
// ---------------------------------------------------------------------------

interface StoredSession {
  secretKey: number[]; // 64-byte ed25519 secret
  expiry: number; // unix secs
}

function sessionStorageKey(owner: PublicKey, marketIndex: number): string {
  return `slipstream:session:${owner.toBase58()}:${marketIndex}`;
}

function loadStoredSession(
  owner: PublicKey,
  marketIndex: number
): { keypair: Keypair; expiry: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(sessionStorageKey(owner, marketIndex));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    const keypair = Keypair.fromSecretKey(Uint8Array.from(parsed.secretKey));
    return { keypair, expiry: parsed.expiry };
  } catch {
    return null;
  }
}

function storeSession(
  owner: PublicKey,
  marketIndex: number,
  keypair: Keypair,
  expiry: number
): void {
  if (typeof window === "undefined") return;
  const payload: StoredSession = {
    secretKey: Array.from(keypair.secretKey),
    expiry,
  };
  window.localStorage.setItem(
    sessionStorageKey(owner, marketIndex),
    JSON.stringify(payload)
  );
}

/**
 * Wait for a scheduled undelegation to actually land on the base layer.
 *
 * `undelegate_trading_credit` only fires a ScheduleCommitAndUndelegate CPI on
 * the rollup; the account's ownership flip back to our program is performed
 * later by the MagicBlock validator. Until that lands, `withdraw_trading_credit`
 * rejects with CreditStillActive, so callers must poll rather than assume the
 * confirmed ER transaction means the funds are back.
 */
async function waitForUndelegation(
  conn: Connection,
  creditPda: PublicKey,
  tries = 30
): Promise<boolean> {
  const programId = PROGRAM_ID.toBase58();
  for (let i = 0; i < tries; i++) {
    try {
      const info = await conn.getAccountInfo(creditPda, "confirmed");
      if (info && info.owner.toBase58() === programId) return true;
    } catch {
      /* transient RPC error — keep polling */
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

export function useSession(marketIndex: number = 0) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [state, setState] = useState<SessionState>({
    initialized: false,
    delegated: false,
    credit: 0n,
    committed: 0n,
    available: 0n,
    activeOrders: 0,
    freeCollateral: 0n,
    usdcBalance: 0n,
    solBalance: 0n,
    userInitialized: false,
    sessionPublicKey: null,
    sessionActive: false,
    sessionExpiry: 0n,
    legacyCredit: false,
    legacyDelegated: false,
  });
  const [busy, setBusy] = useState(false);
  // autoStart used to set no busy state of its own: `busy` was raised inside
  // initialize(), TWO RPC round trips later. For those two round trips the
  // button looked completely idle, so it got clicked again — and every click
  // started another full chain, which is why it got slower the more it was
  // pressed. This ref makes a second click while one is in flight a no-op even
  // before React has re-rendered the disabled state.
  const autoStartInFlight = useRef(false);
  // The ref guards re-entry synchronously; this state keeps the spinner up for
  // the WHOLE run. initialize()/fund()/delegate() each clear `busy` in their own
  // finally, so without it the button flickers back to enabled between the three
  // legs of a single click.
  const [autoRunning, setAutoRunning] = useState(false);
  /** Human label for the in-flight step (drives the loading text), or null. */
  const [step, setStep] = useState<string | null>(null);
  /** Last error message (human-readable), or null. */
  const [error, setError] = useState<string | null>(null);
  /** Last success message (e.g. "Deposited $1000"), or null. */
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Return the locally-stored session Keypair IFF it is still valid: it exists,
   * has not expired locally, and matches the session authority currently stored
   * on-chain. Returns null otherwise (caller should fall back to wallet signing
   * or rotate). This is what order-form.tsx uses to sign place_order locally.
   */
  const getSessionKeypair = useCallback((): Keypair | null => {
    if (!publicKey) return null;
    const stored = loadStoredSession(publicKey, marketIndex);
    if (!stored) return null;
    const nowSecs = Math.floor(Date.now() / 1000);
    if (stored.expiry <= nowSecs) return null;
    return stored.keypair;
  }, [publicKey, marketIndex]);

  const refresh = useCallback(async () => {
    if (!publicKey) return;
    try {
      // FOUR independent reads, one round trip. These ran in series, and
      // refresh() is called after EVERY leg of autoStart as well as on a 5s
      // poll — so the serial version charged ~4 round trips to each of the
      // three setup steps, on top of the transactions themselves. Nothing here
      // depends on anything else here.
      const [userPda] = findUserAccountPda(publicKey, PROGRAM_ID);
      const [pda] = findTradingCreditPda(publicKey, marketIndex, PROGRAM_ID);
      const [uInfo, usdcBalance, solBalance, info] = await Promise.all([
        connection.getAccountInfo(userPda).catch(() => null),
        USDC_MINT
          ? getAssociatedTokenAddress(USDC_MINT, publicKey)
              .then((ata) => getAccount(connection, ata))
              .then((a) => a.amount)
              .catch(() => 0n) // no ATA / no balance yet
          : Promise.resolve(0n),
        connection.getBalance(publicKey).then((l) => BigInt(l)).catch(() => 0n),
        connection.getAccountInfo(pda).catch(() => null),
      ]);

      let freeCollateral = 0n;
      let userInitialized = false;
      if (uInfo && uInfo.data[0] === DISC_USER_ACCOUNT) {
        userInitialized = true;
        freeCollateral = decodeUserAccount(uInfo.data as Buffer).freeCollateral;
      }

      const stored = loadStoredSession(publicKey, marketIndex);
      const sessionPublicKey = stored ? stored.keypair.publicKey.toBase58() : null;
      if (!info) {
        setState((s) => ({
          ...s,
          initialized: false,
          freeCollateral,
          usdcBalance,
          solBalance,
          userInitialized,
          sessionPublicKey,
          sessionActive: false,
          sessionExpiry: 0n,
          legacyCredit: false,
          legacyDelegated: false,
        }));
        return;
      }
      const isDelegated = info.owner.toBase58() === DELEGATION_PROGRAM;
      const data = info.data;
      if (data[0] !== DISC_TRADING_CREDIT) {
        setState((s) => ({
          ...s,
          initialized: false,
          freeCollateral,
          usdcBalance,
          solBalance,
          userInitialized,
          sessionPublicKey,
          sessionActive: false,
          sessionExpiry: 0n,
          legacyCredit: false,
          legacyDelegated: false,
        }));
        return;
      }
      // Detect a pre-upgrade credit (e.g. legacy 56-byte) that the current 96-byte
      // decoder cannot read. It must be migrated before the new flow works:
      //   - program-owned (not delegated): the user can close + re-init in place.
      //   - delegated: cannot be closed/re-init'd at this PDA (undelegate is a
      //     dead-end) — migration requires a fresh wallet.
      const liveLen = isDelegated
        ? (await (async () => {
            try {
              const erConn = erConnection;
              const erInfo = await erConn.getAccountInfo(pda);
              return erInfo ? erInfo.data.length : data.length;
            } catch {
              return data.length;
            }
          })())
        : data.length;
      if (liveLen < TRADING_CREDIT_SIZE) {
        setState((s) => ({
          ...s,
          initialized: true,
          delegated: isDelegated,
          credit: 0n,
          committed: 0n,
          available: 0n,
          activeOrders: 0,
          freeCollateral,
          usdcBalance,
          solBalance,
          userInitialized,
          sessionPublicKey,
          sessionActive: false,
          sessionExpiry: 0n,
          legacyCredit: true,
          legacyDelegated: isDelegated,
        }));
        return;
      }
      // When delegated, the authoritative credit (with the live session fields)
      // lives on the ER. Read it there so the session expiry/authority reflect
      // the rollup state the orders actually execute against.
      let credit = decodeTradingCredit(data as Buffer);
      if (isDelegated) {
        try {
          const erConn = erConnection;
          const erInfo = await erConn.getAccountInfo(pda);
          if (erInfo && erInfo.data[0] === DISC_TRADING_CREDIT) {
            credit = decodeTradingCredit(erInfo.data as Buffer);
          }
        } catch {
          /* fall back to base-layer copy */
        }
      }

      // The on-chain session matches our local key only if the authority equals
      // the stored session pubkey AND it is not expired.
      const localMatches =
        sessionPublicKey !== null &&
        credit.sessionAuthority.toBase58() === sessionPublicKey;
      const sessionActive = localMatches && isSessionActive(credit);

      setState({
        initialized: true,
        delegated: isDelegated,
        credit: credit.credit,
        committed: credit.committed,
        available: credit.available,
        activeOrders: credit.activeOrders,
        freeCollateral,
        usdcBalance,
        solBalance,
        userInitialized,
        sessionPublicKey,
        sessionActive,
        sessionExpiry: credit.sessionExpiry,
        legacyCredit: false,
        legacyDelegated: false,
      });
    } catch {
      // Will retry
    }
  }, [connection, publicKey, marketIndex]);

  useEffect(() => {
    refresh();
    return startPoll(refresh, 5_000);
  }, [refresh]);

  // FULL session setup in ONE click (base layer): initialize_user (if needed) →
  // deposit_collateral (wallet USDC → on-chain UserAccount) → initialize_trading_credit.
  const initialize = useCallback(
    async (depositUsdc: number): Promise<boolean> => {
      if (!publicKey) return false;
      if (!USDC_MINT || !USDC_VAULT) {
        setError("USDC mint/vault missing from deploy manifest.");
        return false;
      }
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const depositAmount = BigInt(Math.round(depositUsdc * PRICE_SCALE));
        slog("init", `requested deposit of $${depositUsdc} (${depositAmount} atoms)`);

        // ── PREFLIGHT: a brand-new wallet typically has no USDC ATA / balance.
        // Catch that here with a clear, actionable message instead of letting
        // the wallet throw a generic "Unexpected error" at simulate time.
        const ata = await getAssociatedTokenAddress(USDC_MINT, publicKey);
        const [userPda] = findUserAccountPda(publicKey, PROGRAM_ID);
        const [creditPda] = findTradingCreditPda(publicKey, marketIndex, PROGRAM_ID);
        const [positionPda] = findPositionPda(publicKey, marketIndex, PROGRAM_ID);

        // ONE round trip, not five. These five reads are mutually independent —
        // nothing here needs a previous result — but they used to run strictly
        // sequentially, so the wallet could not prompt until all five had
        // returned. At the ~1.3s devnet latency this path actually sees, that
        // was the difference between a prompt in ~1s and a prompt in ~7s, and
        // it is why the button felt dead long enough to be clicked repeatedly.
        const [bal, lamports, uInfo, cInfo, pInfo] = await Promise.all([
          depositAmount > 0n
            ? getAccount(connection, ata).then((a) => a.amount).catch(() => 0n)
            : Promise.resolve(0n),
          connection.getBalance(publicKey).catch(() => null),
          connection.getAccountInfo(userPda),
          connection.getAccountInfo(creditPda),
          connection.getAccountInfo(positionPda),
        ]);

        if (depositAmount > 0n) {
          slog("init", `wallet USDC balance = ${Number(bal) / PRICE_SCALE}`);
          if (bal < depositAmount) {
            const msg =
              bal === 0n
                ? "You have no test USDC. Click “Get test USDC” first, then deposit."
                : `Deposit ($${depositUsdc}) exceeds your USDC balance ($${(Number(bal) / PRICE_SCALE).toFixed(2)}). Lower the amount or get more test USDC.`;
            setError(msg);
            slog("init", `BLOCKED: ${msg}`);
            return false;
          }
        }

        // Also ensure the wallet has a little SOL for fees/rent. A null here is
        // an unreachable RPC, which was non-fatal before and stays non-fatal.
        if (lamports !== null) {
          slog("init", `wallet SOL = ${(lamports / 1e9).toFixed(4)}`);
          // Rent for the three accounts this transaction creates is
          // 1_280_640 (UserAccount 56B) + 1_559_040 (TradingCredit 96B)
          // + 1_559_040 (Position 96B) = 4_398_720 lamports, before fees and
          // before delegate()'s own buffer/record/metadata accounts. The old
          // 3_000_000 gate passed wallets that then failed at signing with
          // "insufficient funds for rent", which humanizeError reports as a
          // deposit problem.
          if (lamports < MIN_SOL_LAMPORTS) {
            setError(
              `Your wallet needs about ${(MIN_SOL_LAMPORTS / 1e9).toFixed(3)} devnet SOL for account rent and fees — ` +
                `it has ${(lamports / 1e9).toFixed(4)}. Use "Get test USDC" (it tops up SOL too) or airdrop some, then retry.`
            );
            return false;
          }
        }

        const ixs = [];
        if (!(uInfo && uInfo.data[0] === DISC_USER_ACCOUNT)) {
          slog("init", "will create UserAccount");
          ixs.push(createInitializeUserInstruction(publicKey, PROGRAM_ID));
        }

        if (depositAmount > 0n) {
          slog("init", "will deposit collateral");
          ixs.push(
            createDepositCollateralInstruction(publicKey, ata, USDC_VAULT, depositAmount, PROGRAM_ID)
          );
        }

        if (!(cInfo && cInfo.data[0] === DISC_TRADING_CREDIT)) {
          slog("init", "will create TradingCredit");
          ixs.push(createInitializeTradingCreditInstruction(publicKey, marketIndex, PROGRAM_ID));
        }

        // Create the L1 Position account too, so settled fills have somewhere to
        // land (settle_from_log skips fills whose owner has no Position).
        if (!pInfo) {
          slog("init", "will create Position");
          ixs.push(createInitializePositionInstruction(publicKey, marketIndex, PROGRAM_ID));
        }

        if (ixs.length === 0) {
          slog("init", "nothing to do (already set up)");
          setNotice("Already initialized.");
          await refresh();
          return true;
        }

        setStep("Awaiting wallet signature…");
        const tx = new Transaction().add(...ixs);
        slog("init", `sending tx with ${ixs.length} instruction(s)`);
        const sig = await sendTransaction(tx, connection);
        slog("init", `submitted: ${sig}`);
        setStep("Confirming on Solana…");
        await confirmSignature(connection, sig, { timeoutMs: 45_000 });
        slog("init", `CONFIRMED: ${sig}`);
        setNotice(depositAmount > 0n ? `Deposited $${depositUsdc} and initialized.` : "Initialized.");
        await refresh();
        return true;
      } catch (err) {
        const msg = humanizeError(err);
        setError(msg);
        slog("init", `FAILED: ${msg}`, err);
        // eslint-disable-next-line no-console
        console.error("[session] initialize failed:", err);
        return false;
      } finally {
        setStep(null);
        setBusy(false);
      }
    },
    [publicKey, sendTransaction, connection, marketIndex, refresh]
  );

  // Request test USDC from the server faucet (operator mints to the wallet's ATA).
  const requestFaucet = useCallback(async () => {
    if (!publicKey) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setStep("Requesting test USDC…");
    try {
      slog("faucet", `requesting test USDC for ${publicKey.toBase58()}`);
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58() }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        const msg = body?.error ?? `Faucet failed (HTTP ${res.status}).`;
        setError(msg);
        slog("faucet", `FAILED: ${msg}`);
        return;
      }
      slog("faucet", `minted ${body.amount} USDC, sig=${body.signature}`);
      setNotice(
        body.sol
          ? `Received ${body.amount} test USDC and ${body.sol} SOL for fees. You're ready to start.`
          : `Received ${body.amount} test USDC. You can start trading now.`
      );
      // Give the RPC a moment to reflect the mint, then refresh balances.
      await new Promise((r) => setTimeout(r, 1500));
      await refresh();
    } catch (err) {
      const msg = humanizeError(err);
      setError(msg);
      slog("faucet", `FAILED: ${msg}`, err);
    } finally {
      setStep(null);
      setBusy(false);
    }
  }, [publicKey, refresh]);

  // fund_trading_credit (0x0e) — base layer.
  const fund = useCallback(
    async (amountUsdc: number): Promise<boolean> => {
      if (!publicKey) return false;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const amount = BigInt(Math.round(amountUsdc * PRICE_SCALE));
        slog("fund", `funding credit with $${amountUsdc}`);
        // Read the deposit balance from chain rather than React state: when
        // this runs straight after a deposit (the one-click flow), `state` has
        // not re-rendered yet and would still report the pre-deposit balance.
        const [userPdaForFund] = findUserAccountPda(publicKey, PROGRAM_ID);
        const uInfoForFund = await connection.getAccountInfo(userPdaForFund);
        const freeCollateral =
          uInfoForFund && uInfoForFund.data[0] === DISC_USER_ACCOUNT
            ? decodeUserAccount(uInfoForFund.data as Buffer).freeCollateral
            : 0n;
        if (amount > freeCollateral) {
          const msg = `Not enough deposited collateral: have $${(Number(freeCollateral) / PRICE_SCALE).toFixed(2)}, need $${amountUsdc}.`;
          setError(msg);
          slog("fund", `BLOCKED: ${msg}`);
          return false;
        }
        const ix = createFundTradingCreditInstruction(
          publicKey,
          marketIndex,
          amount,
          PROGRAM_ID
        );
        setStep("Awaiting wallet signature…");
        const tx = new Transaction().add(ix);
        const sig = await sendTransaction(tx, connection);
        slog("fund", `submitted: ${sig}`);
        setStep("Confirming on Solana…");
        await confirmSignature(connection, sig, { timeoutMs: 45_000 });
        slog("fund", `CONFIRMED: ${sig}`);
        setNotice(`Funded $${amountUsdc} into trading credit.`);
        await refresh();
        return true;
      } catch (err) {
        const msg = humanizeError(err);
        setError(msg);
        slog("fund", `FAILED: ${msg}`, err);
        return false;
      } finally {
        setStep(null);
        setBusy(false);
      }
    },
    [publicKey, sendTransaction, connection, marketIndex, refresh]
  );

  // delegate_trading_credit (0x0f) — BASE layer. THE ONE SIGNATURE.
  //
  // This single wallet-signed transaction:
  //   1. generates a fresh ephemeral session keypair in the browser,
  //   2. persists its secret in localStorage (keyed by owner+market) with a TTL,
  //   3. delegates the credit to the ER AND authorizes the session pubkey+expiry
  //      in the same instruction (the program writes the session fields before
  //      staging the buffer), and
  //   4. funds the session key with a tiny SOL float so it can pay ER fees.
  // After this, order-form signs every place_order locally with the session key
  // — zero wallet popups per order.
  const delegate = useCallback(async (): Promise<boolean> => {
    if (!publicKey) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      slog("delegate", "starting ER delegation + session authorize");
      // 1: generate the session key with a TTL. Persisted only after the
      // on-chain delegate+authorize succeeds below (matches rotate()) — storing
      // it up front would overwrite a still-valid previous session with a key
      // that was never actually authorized if this transaction fails.
      const sessionKp = Keypair.generate();
      const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECS;
      slog("delegate", `session key ${sessionKp.publicKey.toBase58()} (expires ${new Date(expiry * 1000).toISOString()})`);

      // 3: delegate + authorize the session in ONE instruction/signature.
      const ix = createDelegateTradingCreditInstruction(
        publicKey,
        marketIndex,
        sessionKp.publicKey,
        BigInt(expiry),
        PROGRAM_ID
      );
      const tx = new Transaction().add(ix);

      // 4: fund the session key for ER fees (skipped when SESSION_FUND_SOL = 0).
      if (SESSION_FUND_SOL > 0) {
        tx.add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: sessionKp.publicKey,
            lamports: Math.floor(SESSION_FUND_SOL * 1e9),
          })
        );
      }

      setStep("Awaiting wallet signature…");
      const sig = await sendTransaction(tx, connection);
      slog("delegate", `submitted: ${sig}`);
      setStep("Delegating to the rollup…");
      await confirmSignature(connection, sig, { timeoutMs: 45_000 });
      slog("delegate", `CONFIRMED: ${sig}`);
      // Persist only AFTER the on-chain delegate+authorize succeeds.
      storeSession(publicKey, marketIndex, sessionKp, expiry);
      setNotice("Trading session active — you can place orders now.");
      await refresh();
      return true;
    } catch (err) {
      const msg = humanizeError(err);
      setError(msg);
      slog("delegate", `FAILED: ${msg}`, err);
      return false;
    } finally {
      setStep(null);
      setBusy(false);
    }
  }, [publicKey, sendTransaction, connection, marketIndex, refresh]);

  // autoStart — the whole onboarding in ONE click: deposit collateral, move it
  // into trading credit, then delegate to the ER with a fresh session key.
  //
  // Resumable by design: each step is skipped when it is already done, so a
  // user whose wallet rejected step 2 of 3 can simply press the button again
  // rather than being stranded in a half-set-up state with no way forward.
  const autoStart = useCallback(
    async (depositUsdc?: number): Promise<boolean> => {
      if (!publicKey) return false;
      if (autoStartInFlight.current) {
        slog("autostart", "already running — ignoring repeat click");
        return false;
      }
      autoStartInFlight.current = true;
      setAutoRunning(true);
      // Feedback on the CLICK, not two round trips later.
      setBusy(true);
      setStep("Checking your accounts\u2026");
      try {
        const [creditPda] = findTradingCreditPda(publicKey, marketIndex, PROGRAM_ID);
        // Both preflight reads at once. They are independent: the credit's owner
        // decides whether there is anything to do, the wallet balance decides
        // how much to move. Running them in series added a whole round trip
        // before the wallet could be asked for anything.
        const [creditInfo, walletUsdc] = await Promise.all([
          connection.getAccountInfo(creditPda),
          depositUsdc !== undefined || !USDC_MINT
            ? Promise.resolve(0n)
            : getAssociatedTokenAddress(USDC_MINT, publicKey)
                .then((ata) => getAccount(connection, ata))
                .then((a) => a.amount)
                // ONLY "the ATA does not exist" means zero. Every other failure
                // is the RPC being unreachable, and swallowing it here turned
                // "deposit everything" into "deposit nothing" while the run
                // carried on and delegated an EMPTY credit — three approvals
                // burned, USDC still in the wallet, and the Start button then
                // replaced by the withdraw card so there was no way back.
                .catch((e: unknown) => {
                  const name = (e as { name?: string })?.name ?? "";
                  if (name === "TokenAccountNotFoundError" || name === "TokenInvalidAccountOwnerError") {
                    return 0n;
                  }
                  throw e;
                }),
        ]);
        if (creditInfo?.owner.toBase58() === DELEGATION_PROGRAM) {
          // Silent `return true` here read to the user as "the button does
          // nothing": no spinner, no error, no notice, no state change they
          // could see. Say what happened, and say it differently depending on
          // whether there is actually credit to trade with — "already set up"
          // is not a useful answer to someone staring at $0.00 available.
          slog("autostart", "already delegated — nothing to do");
          await refresh();
          const [uPda] = findUserAccountPda(publicKey, PROGRAM_ID);
          const uAcc = await connection.getAccountInfo(uPda);
          const parked =
            uAcc && uAcc.data[0] === DISC_USER_ACCOUNT
              ? decodeUserAccount(uAcc.data as Buffer).freeCollateral
              : 0n;
          setNotice(
            parked > 0n
              ? "Your session is already open, but this wallet still has collateral sitting outside its trading credit. Use \u201CWithdraw all to wallet\u201D and start again to move it in."
              : "Your session is already open — nothing to set up. If credit still shows $0.00, the funds are in a trading credit this build cannot reach; use a fresh wallet."
          );
          return true;
        }

        // With no amount given, move the wallet's entire USDC balance in. Read
        // it from chain rather than from a UI field: there is no deposit input
        // any more, and React state can lag a faucet drip by a whole poll.
        const deposit =
          depositUsdc !== undefined ? depositUsdc : Number(walletUsdc) / PRICE_SCALE;

        slog("autostart", `starting one-click setup (deposit $${deposit ?? 0})`);
        // Setup is THREE transactions, so it is THREE wallet signatures. The
        // button's hint ("every order signs instantly with no popups") is true
        // of trading afterwards, not of setup — and with no step labelling, a
        // user who had approved one popup had no way to know two more were
        // coming, or which one they were looking at.
        setStep("Step 1 of 3 — creating your accounts\u2026");
        if (!(await initialize(deposit ?? 0))) return false;

        // Move everything deposited into trading credit. Read the balance from
        // chain — the deposit above landed moments ago and React state lags it.
        const [userPda] = findUserAccountPda(publicKey, PROGRAM_ID);
        const uInfo = await connection.getAccountInfo(userPda);
        const free =
          uInfo && uInfo.data[0] === DISC_USER_ACCOUNT
            ? decodeUserAccount(uInfo.data as Buffer).freeCollateral
            : 0n;
        if (free > 0n) {
          setStep("Step 2 of 3 — moving collateral into the market\u2026");
          if (!(await fund(Number(free) / PRICE_SCALE))) return false;
        }

        // Delegating an empty credit is the trap: it succeeds, `state.delegated`
        // flips true, and session-panel then swaps the Start button for the
        // withdraw/rotate card — leaving a wallet that cannot trade and has no
        // visible way to fund. Refuse before the third signature, not after.
        const creditNow = await connection.getAccountInfo(creditPda);
        const creditAmount =
          creditNow && creditNow.data.length >= TRADING_CREDIT_SIZE
            ? decodeTradingCredit(creditNow.data as Buffer).credit
            : 0n;
        if (creditAmount === 0n) {
          setError(
            "Nothing was moved into the market, so there is no session to open. " +
              "Get test USDC (or check your connection) and press Start trading again."
          );
          slog("autostart", "BLOCKED: refusing to delegate an empty credit");
          return false;
        }

        setStep("Step 3 of 3 — opening your rollup session\u2026");
        if (!(await delegate())) return false;

        slog("autostart", "setup complete");
        setNotice("You're ready to trade — orders sign instantly, no wallet popups.");
        // Not awaited: autoStart re-reads what it needs from chain itself, so
        // this is 4+ RPCs of pure latency on the path the user is watching.
        void refresh();
        return true;
      } catch (err) {
        const msg = humanizeError(err);
        setError(msg);
        slog("autostart", `FAILED: ${msg}`, err);
        return false;
      } finally {
        autoStartInFlight.current = false;
        setAutoRunning(false);
        setBusy(false);
        setStep(null);
      }
    },
    [publicKey, connection, marketIndex, initialize, fund, delegate, refresh]
  );

  // withdraw — the full exit, in one click: pull the credit back off the
  // rollup, convert it to collateral, and send the USDC to the wallet.
  //
  // Withdraws everything rather than a chosen amount: a credit is delegated to
  // the ER as a whole, so any partial exit would still mean undelegating and
  // re-delegating the lot. Resumable like autoStart — each leg is skipped when
  // it is already done, so a retry after a failed step picks up where it left
  // off instead of repeating work.
  const withdraw = useCallback(async (): Promise<boolean> => {
    if (!publicKey) return false;
    if (!USDC_MINT || !USDC_VAULT) {
      setError("USDC mint/vault missing from deploy manifest.");
      return false;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const [creditPda] = findTradingCreditPda(publicKey, marketIndex, PROGRAM_ID);
      let creditInfo = await connection.getAccountInfo(creditPda);
      const delegated = creditInfo?.owner.toBase58() === DELEGATION_PROGRAM;

      // The program refuses to release a credit that still backs resting
      // orders. Check first: undelegating and only then discovering the credit
      // is busy would strand the user off-rollup with funds they can't move.
      if (creditInfo && creditInfo.data.length >= TRADING_CREDIT_SIZE) {
        let live = creditInfo.data;
        if (delegated) {
          try {
            const erInfo = await erConnection.getAccountInfo(creditPda);
            if (erInfo && erInfo.data[0] === DISC_TRADING_CREDIT) live = erInfo.data;
          } catch {
            /* fall back to the base-layer copy */
          }
        }
        if (live[0] === DISC_TRADING_CREDIT) {
          const c = decodeTradingCredit(live as Buffer);
          if (c.activeOrders > 0 || c.committed > 0n) {
            setError(
              `Cancel your ${c.activeOrders} open order${c.activeOrders === 1 ? "" : "s"} before withdrawing.`
            );
            return false;
          }
        }
      }

      // 1. Leave the rollup. Only the schedule happens here; the base-layer
      //    handover is the validator's job, so poll for it afterwards.
      if (delegated) {
        slog("withdraw", "undelegating trading credit from the ER");
        setStep("Returning funds from the rollup…");
        const erConn = erConnection;
        const tx = new Transaction().add(
          createUndelegateTradingCreditInstruction(
            publicKey,
            marketIndex,
            MAGIC_CONTEXT_ID,
            PROGRAM_ID
          )
        );
        const { blockhash } = await erConn.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = publicKey;
        const sig = await sendTransaction(tx, erConn);
        await confirmSignature(erConn, sig, { timeoutMs: 45_000 });

        setStep("Waiting for the rollup to settle…");
        if (!(await waitForUndelegation(connection, creditPda))) {
          setError(
            "The rollup hasn't handed your funds back yet. Give it a moment and press Withdraw again."
          );
          return false;
        }
        slog("withdraw", "undelegation landed on L1");
      }

      // 2. Trading credit → free collateral (accounting only, no tokens move).
      creditInfo = await connection.getAccountInfo(creditPda);
      const credit =
        creditInfo &&
        creditInfo.data[0] === DISC_TRADING_CREDIT &&
        creditInfo.data.length >= TRADING_CREDIT_SIZE
          ? decodeTradingCredit(creditInfo.data as Buffer).credit
          : 0n;
      if (credit > 0n) {
        setStep("Releasing trading credit…");
        const sig = await sendTransaction(
          new Transaction().add(
            createWithdrawTradingCreditInstruction(publicKey, marketIndex, credit, PROGRAM_ID)
          ),
          connection
        );
        await confirmSignature(connection, sig, { timeoutMs: 45_000 });
      }

      // 3. Free collateral → the wallet's USDC account (the real transfer).
      const [userPda] = findUserAccountPda(publicKey, PROGRAM_ID);
      const uInfo = await connection.getAccountInfo(userPda);
      const free =
        uInfo && uInfo.data[0] === DISC_USER_ACCOUNT
          ? decodeUserAccount(uInfo.data as Buffer).freeCollateral
          : 0n;
      if (free === 0n) {
        setNotice("Nothing left to withdraw.");
        await refresh();
        return true;
      }

      // withdraw_collateral checks one Position PDA per market, so it needs the
      // live market count rather than an assumed single market.
      const [globalPda] = findGlobalStatePda(PROGRAM_ID);
      const gInfo = await connection.getAccountInfo(globalPda);
      const marketCount = gInfo ? decodeGlobalState(gInfo.data as Buffer).marketCount : 1;

      setStep("Sending USDC to your wallet…");
      const ata = await getAssociatedTokenAddress(USDC_MINT, publicKey);
      const sig = await sendTransaction(
        new Transaction().add(
          createWithdrawCollateralInstruction(
            {
              owner: publicKey,
              userTokenAccount: ata,
              quoteVault: USDC_VAULT,
              amount: free,
              marketIndex,
              marketCount,
            },
            PROGRAM_ID
          )
        ),
        connection
      );
      await confirmSignature(connection, sig, { timeoutMs: 45_000 });

      const usd = (Number(free) / PRICE_SCALE).toFixed(2);
      slog("withdraw", `withdrew $${usd} to the wallet`);
      setNotice(`Withdrew $${usd} to your wallet.`);
      await refresh();
      return true;
    } catch (err) {
      const msg = humanizeError(err);
      setError(msg);
      slog("withdraw", `FAILED: ${msg}`, err);
      return false;
    } finally {
      setStep(null);
      setBusy(false);
    }
  }, [publicKey, sendTransaction, connection, marketIndex, refresh]);

  // rotate — issue a fresh session key and re-authorize it on the (already
  // delegated) credit via authorize_session. ONE wallet signature. Used when the
  // session expired or the user wants to invalidate the old key. Runs on the ER
  // when the credit is delegated (the program owns the delegated account's logic
  // there), else on the base layer.
  const rotate = useCallback(async () => {
    if (!publicKey) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setStep("Awaiting wallet signature\u2026");
    try {
      const sessionKp = Keypair.generate();
      const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECS;

      const [creditPda] = findTradingCreditPda(publicKey, marketIndex, PROGRAM_ID);
      const baseInfo = await connection.getAccountInfo(creditPda);
      const delegated = baseInfo?.owner.toBase58() === DELEGATION_PROGRAM;

      const authIx = createAuthorizeSessionInstruction(
        publicKey,
        marketIndex,
        sessionKp.publicKey,
        BigInt(expiry),
        PROGRAM_ID
      );

      // Fund the fresh session key for ER fees (base layer; skipped at 0).
      if (SESSION_FUND_SOL > 0) {
        const fundTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: sessionKp.publicKey,
            lamports: Math.floor(SESSION_FUND_SOL * 1e9),
          })
        );
        const fundSig = await sendTransaction(fundTx, connection);
        await confirmSignature(connection, fundSig, { timeoutMs: 45_000 });
      }

      if (delegated) {
        const erConn = erConnection;
        const authTx = new Transaction().add(authIx);
        const { blockhash } = await erConn.getLatestBlockhash();
        authTx.recentBlockhash = blockhash;
        authTx.feePayer = publicKey;
        const sig = await sendTransaction(authTx, erConn);
        await confirmSignature(erConn, sig, { timeoutMs: 45_000 });
      } else {
        const sig = await sendTransaction(new Transaction().add(authIx), connection);
        await confirmSignature(connection, sig, { timeoutMs: 45_000 });
      }

      // Persist only AFTER the on-chain authorize succeeds.
      storeSession(publicKey, marketIndex, sessionKp, expiry);
      await refresh();
    } catch (err) {
      // Was try/finally with NO catch, wired straight to onClick: a rejected
      // signature, an ER outage and a SUCCESSFUL rotation were pixel-identical
      // — spinner, then the label back. This is the recovery path for a session
      // key lost to a confirm timeout, so its silence compounded.
      const msg = humanizeError(err);
      setError(msg);
      slog("rotate", `FAILED: ${msg}`, err);
      return false;
    } finally {
      setStep(null);
      setBusy(false);
    }
  }, [publicKey, sendTransaction, connection, marketIndex, refresh]);

  // closeLegacyCredit — migration helper for a pre-upgrade NON-delegated credit:
  // closes the old (e.g. 56-byte) account so the user can re-init at the new
  // 96-byte layout via `initialize`. Refuses on a delegated legacy credit (the
  // program-side guard also enforces this) — that case needs a fresh wallet.
  const closeLegacyCredit = useCallback(async () => {
    if (!publicKey) return;
    if (state.legacyDelegated) {
      throw new Error(
        "Legacy credit is delegated and cannot be closed in place; migrate with a fresh wallet."
      );
    }
    setBusy(true);
    try {
      const ix = createCloseTradingCreditInstruction(publicKey, marketIndex, PROGRAM_ID);
      const sig = await sendTransaction(new Transaction().add(ix), connection);
      await confirmSignature(connection, sig, { timeoutMs: 45_000 });
      await refresh();
    } catch (err) {
      // Same silence as rotate(). This is the ONLY route out of a bricked
      // legacy credit, so a button that spins and says nothing is the worst
      // possible failure mode for it.
      const msg = humanizeError(err);
      setError(msg);
      slog("close-legacy", `FAILED: ${msg}`, err);
      return false;
    } finally {
      setBusy(false);
    }
  }, [publicKey, sendTransaction, connection, marketIndex, refresh, state.legacyDelegated]);

  return {
    state,
    busy: busy || autoRunning,
    step,
    error,
    notice,
    clearError: () => setError(null),
    clearNotice: () => setNotice(null),
    initialize,
    requestFaucet,
    fund,
    delegate,
    autoStart,
    withdraw,
    rotate,
    refresh,
    getSessionKeypair,
    closeLegacyCredit,
  };
}
