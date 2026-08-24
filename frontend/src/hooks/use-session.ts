"use client";

import { erConnection } from "@/lib/connections";
import { startPoll } from "@/lib/poll";
import { useCallback, useEffect, useState, useRef } from "react";
import { useWallet, useConnection } from "@/hooks/use-wallet-compat";
import {
  type AccountInfo,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, unpackAccount } from "@solana/spl-token";
import { PROGRAM_ID, USDC_MINT, USDC_VAULT } from "@/lib/manifest";
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
  humanizeError,
} from "@/lib/slipstream";
import { confirmSignature } from "@/lib/confirm";

const DELEGATION_PROGRAM = DELEGATION_PROGRAM_ID.toBase58();

/** Rent for UserAccount(56B) + TradingCredit(96B) + Position(96B) = 4_398_720
 *  lamports, plus fees and delegate()'s own account creations. Rounded up.
 *
 *  Exported because it is the number that actually REFUSES: both preflights
 *  below quote it verbatim. session-panel.tsx used to carry its own copy at
 *  20_000_000 (the faucet's top-up floor, FAUCET_SOL_FLOOR), so every wallet
 *  between 0.01 and 0.02 SOL got an amber "setup can't run yet" warning and
 *  then watched setup run perfectly. One threshold, imported, cannot drift. */
export const MIN_SOL_LAMPORTS = 10_000_000; // 0.01 SOL

/** Session lifetime (seconds). The browser session key is authorized for this
 *  long; after it expires the user must rotate (one signature) to keep trading
 *  popup-less. 24h keeps a leaked key's blast radius bounded. */
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
    console.log(`%c[session ${ts}] ${step}: ${msg}`, "color:#34d399", extra);
  } else {
    console.log(`%c[session ${ts}] ${step}: ${msg}`, "color:#34d399");
  }
}

/**
 * The ONLY token-read failures that honestly mean "this wallet holds zero
 * USDC": the associated account has never been created, or something else
 * lives at that address. Every other throw is the RPC being unreachable, and
 * swallowing it turns a devnet blip into "you have no test USDC" — which is
 * what disabled the primary button for funded wallets and, in autoStart, once
 * turned "deposit everything" into "deposit nothing" while the run carried on
 * and delegated an EMPTY credit. Rethrow so the caller can say what happened.
 */
function zeroIfTokenAccountAbsent(err: unknown): bigint {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "TokenAccountNotFoundError" || name === "TokenInvalidAccountOwnerError") {
    return 0n;
  }
  throw err;
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

/**
 * Why this exists: an all-zero `SessionState` has three completely different
 * causes — we have not read the chain yet, we read it and this wallet
 * genuinely holds nothing, or we could not reach the chain at all — and
 * `refresh` used to render all three identically. Four reads each wrapped in
 * `.catch(() => null)` / `.catch(() => 0n)`, and the whole body in a bare
 * `catch` that only said "Will retry", meant one rate-limited devnet poll
 * redrew a funded, fully delegated wallet as brand new: USDC $0.00, SOL 0.0000,
 * the amber "this wallet needs a little devnet SOL" warning, and "Start
 * trading" disabled — with nothing logged and no error anywhere on the page.
 * Same shape as `MarketStatus` in use-market.ts, for the same reason.
 *
 *   loading      no read has completed for THIS owner yet; every number in
 *                `state` is a placeholder or the previously connected wallet's.
 *   live         the last read succeeded; `state` is what the chain says.
 *   stale        the last read FAILED but an earlier one for this owner
 *                succeeded; `state` is the last known-good snapshot for this
 *                wallet and may be out of date.
 *   unavailable  no read for this owner has ever succeeded; `state` cannot be
 *                trusted at all. Do not render it as money, and above all do
 *                not read it as "this wallet is empty".
 *
 * Only meaningful while a wallet is connected — `refresh` is a no-op without
 * one, so the status stays "loading" until an owner appears.
 */
export type SessionStatus = "loading" | "live" | "stale" | "unavailable";

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
 * Read everything the wallet panel and the order form need, in TWO round trips.
 *
 * Throws on any transport failure, and that is the whole point. Every read in
 * here used to carry its own `.catch(() => null)` / `.catch(() => 0n)`, so a
 * rate-limited RPC came back as "no accounts, no USDC, no SOL". A genuinely
 * missing account already resolves to null (or, for a missing ATA, to the
 * narrowly-caught TokenAccountNotFoundError) WITHOUT throwing — so those
 * catches never distinguished anything real, they only hid the failures that
 * matter. The caller decides what a throw means for what is already on screen.
 */
async function readSessionState(
  connection: Connection,
  publicKey: PublicKey,
  marketIndex: number
): Promise<SessionState> {
  const [userPda] = findUserAccountPda(publicKey, PROGRAM_ID);
  const [pda] = findTradingCreditPda(publicKey, marketIndex, PROGRAM_ID);
  // ONE base-layer request for all four accounts, not four. They were four
  // independent promises in a Promise.all: four JSON-RPC envelopes through the
  // proxy, four separate chances of drawing the 429 — and, because they failed
  // independently, a rate-limited getBalance could report 0 SOL next to a
  // perfectly good USDC balance, which is what the panel uses to decide whether
  // to tell the user they cannot afford setup.
  const ata = USDC_MINT ? await getAssociatedTokenAddress(USDC_MINT, publicKey) : null;
  const [uInfo, info, walletInfo, ataInfo] = await connection.getMultipleAccountsInfo(
    ata ? [userPda, pda, publicKey, ata] : [userPda, pda, publicKey]
  );

  const solBalance = BigInt(walletInfo?.lamports ?? 0);
  let usdcBalance = 0n;
  if (ata) {
    try {
      usdcBalance = unpackAccount(ata, ataInfo ?? null).amount;
    } catch (err) {
      usdcBalance = zeroIfTokenAccountAbsent(err);
    }
  }

  let freeCollateral = 0n;
  let userInitialized = false;
  if (uInfo && uInfo.data[0] === DISC_USER_ACCOUNT) {
    userInitialized = true;
    freeCollateral = decodeUserAccount(uInfo.data as Buffer).freeCollateral;
  }

  const stored = loadStoredSession(publicKey, marketIndex);
  const sessionPublicKey = stored ? stored.keypair.publicKey.toBase58() : null;

  // COMPLETE state objects, every branch. The two "this wallet has no usable
  // credit" exits used to be `setState(s => ({ ...s, … }))` partial spreads
  // that left delegated/credit/committed/available/activeOrders untouched — so
  // switching from a delegated wallet holding $1,000 to a fresh one showed the
  // fresh wallet "Available $1,000.00", the trading-session card and "Withdraw
  // all to wallet", and NO "Start trading" button, because `delegated` was
  // still the previous wallet's. It never self-corrected; only a reload did.
  const noCredit: SessionState = {
    initialized: false,
    delegated: false,
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
    legacyCredit: false,
    legacyDelegated: false,
  };
  if (!info || info.data[0] !== DISC_TRADING_CREDIT) return noCredit;

  const isDelegated = info.owner.toBase58() === DELEGATION_PROGRAM;
  const data = info.data;

  // When delegated, the authoritative credit — with the live session fields and
  // balances the orders actually execute against — lives on the ER; the base
  // layer holds the snapshot taken at delegation time. Read the ER copy ONCE.
  // This used to be two sequential getAccountInfo calls on the SAME account:
  // the first purely to measure `data.length` for the legacy probe below and
  // then thrown away, the second to decode. Same bytes, twice, every 5s.
  let erInfo: AccountInfo<Buffer> | null = null;
  if (isDelegated) {
    try {
      erInfo = await erConnection.getAccountInfo(pda);
    } catch {
      // An unreachable ER is NOT an unreachable chain: the base-layer snapshot
      // is still a real credit, just possibly behind. Fall back to it rather
      // than failing the whole read and blanking the panel.
    }
  }

  // Detect a pre-upgrade credit (e.g. legacy 56-byte) that the current 96-byte
  // decoder cannot read. It must be migrated before the new flow works:
  //   - program-owned (not delegated): the user can close + re-init in place.
  //   - delegated: cannot be closed/re-init'd at this PDA (undelegate is a
  //     dead-end) — migration requires a fresh wallet.
  const liveLen = erInfo ? erInfo.data.length : data.length;
  if (liveLen < TRADING_CREDIT_SIZE) {
    return {
      ...noCredit,
      initialized: true,
      delegated: isDelegated,
      legacyCredit: true,
      legacyDelegated: isDelegated,
    };
  }

  const authoritative =
    erInfo && erInfo.data[0] === DISC_TRADING_CREDIT ? erInfo.data : data;
  const credit = decodeTradingCredit(authoritative as Buffer);

  // The on-chain session matches our local key only if the authority equals
  // the stored session pubkey AND it is not expired.
  const localMatches =
    sessionPublicKey !== null &&
    credit.sessionAuthority.toBase58() === sessionPublicKey;

  return {
    ...noCredit,
    initialized: true,
    delegated: isDelegated,
    credit: credit.credit,
    committed: credit.committed,
    available: credit.available,
    activeOrders: credit.activeOrders,
    sessionActive: localMatches && isSessionActive(credit),
    sessionExpiry: credit.sessionExpiry,
  };
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
  // Whether the numbers in `state` above can be believed — see SessionStatus.
  // Stored WITH the owner whose read produced it, and compared on every render:
  // a wallet switch has to invalidate `state` immediately, and deriving that
  // here catches the very first render after the switch, which a reset inside
  // the poll effect would miss by one render (and would be a cascading
  // setState-in-effect besides).
  const owner = publicKey?.toBase58() ?? null;
  const [read, setRead] = useState<{ owner: string | null; status: SessionStatus }>({
    owner: null,
    status: "loading",
  });
  const status: SessionStatus = read.owner === owner ? read.status : "loading";
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

  // Request sequence. `refresh` is the only writer of `state`/`read`, but it has
  // twelve call sites and no ordering guarantee between them: startPoll only
  // serialises its OWN loop, so a stalled 5s tick (this file documents 10-30s
  // devnet 429 windows) and a hand-triggered refresh run concurrently and can
  // resolve out of order. The damaging run: the tick stalls, the user clicks
  // Start trading, autoStart's refresh returns first with the post-setup state
  // and flips the panel to "trading" — then the OLDER read lands and overwrites
  // it with the pre-setup snapshot, still marked "live", so a wallet that IS set
  // up renders as not set up (and $0.00 as a real figure) until the next tick.
  // Every run tags itself here and drops its result unless it is still newest.
  // Bumped BEFORE the publicKey guard on purpose: a disconnect re-runs the poll
  // effect, and that no-op call has to invalidate the previous wallet's in-flight
  // read too, or it lands afterwards and rewrites read.owner.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    if (!publicKey) return;
    const who = publicKey.toBase58();
    try {
      const next = await readSessionState(connection, publicKey, marketIndex);
      if (my !== seq.current) return;
      setState(next);
      setRead({ owner: who, status: "live" });
    } catch (err) {
      // A throw here is the chain being unreachable, NOT an empty wallet — the
      // read distinguishes the two now (see readSessionState). Leave `state`
      // exactly as it was and SAY that it is unverified, instead of the old
      // silent `// Will retry`, which let four swallowed reads redraw a funded,
      // delegated wallet as brand new and logged nothing at all.
      //
      // Deliberately NOT setError: this polls every 5s, so it would need a
      // clear-on-success, and that would wipe an autoStart or withdraw error
      // off the panel within one tick of the user causing it.
      slog("refresh", `read failed, keeping last known state: ${humanizeError(err)}`, err);
      // Same supersede rule as the success path: a superseded failure must not
      // downgrade a newer read's "live" to "stale", nor claim read.owner.
      if (my !== seq.current) return;
      setRead((r) =>
        r.owner === who && (r.status === "live" || r.status === "stale")
          ? { owner: who, status: "stale" }
          : { owner: who, status: "unavailable" }
      );
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
            ? getAccount(connection, ata)
                .then((a) => a.amount)
                // An unreachable RPC used to read as `bal = 0n` here, which the
                // check below reports as "You have no test USDC" to a wallet
                // that is holding plenty. Only a genuinely absent ATA is zero.
                .catch(zeroIfTokenAccountAbsent)
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
      // Three outcomes, three sentences — the route already reports all three
      // (see its header comment) and this collapsed the last two into "You can
      // start trading now", which is exactly what an operator out of devnet SOL
      // makes false: the USDC landed, the SOL top-up threw, and Start trading
      // then dies at the MIN_SOL_LAMPORTS gate with no hint of why.
      setNotice(
        body.sol
          ? `Received ${body.amount} test USDC and ${body.sol} SOL for fees. You're ready to start.`
          : body.solError
            ? `Received ${body.amount} test USDC, but the SOL top-up failed — the faucet may be out of devnet SOL. You need about ${(MIN_SOL_LAMPORTS / 1e9).toFixed(3)} SOL for fees and rent before Start trading will work.`
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

  // oneShotSetup — the whole of onboarding in ONE transaction, ONE signature.
  //
  // It used to be three transactions, and almost every onboarding defect found
  // in this codebase lived in the gaps between them:
  //   - three separate blockhashes, each able to expire while the user reads a
  //     wallet popup, and confirmSignature carries no lastValidBlockHeight so a
  //     post-send expiry is indistinguishable from a slow node;
  //   - a half-done state after every leg, with only ONE resumability check
  //     (is the credit delegated?) covering all three — which is why a credit
  //     that was delegated but empty short-circuited to "nothing to do";
  //   - the session key persisted only after the third confirm, so a timeout on
  //     a transaction that actually landed left the credit delegated to a
  //     keypair that existed nowhere, and every order fell back to a popup.
  //
  // Solana executes instructions in a transaction sequentially against the same
  // account state, so the ordering is real: deposit_collateral credits
  // free_collateral, and fund_trading_credit two instructions later reads that
  // updated value. Nothing here needs a separate confirmation.
  //
  // Size: 15 distinct keys and six instructions measure ~700 bytes against the
  // 1232-byte limit, with the session-key transfer on top. The instruction set
  // is fixed, so there is no input that can grow it — but the check below is
  // cheap and turns a silent oversize into a legible refusal.
  const oneShotSetup = useCallback(
    async (depositUsdc: number): Promise<boolean> => {
      if (!publicKey || !USDC_MINT || !USDC_VAULT) return false;

      const depositAmount = BigInt(Math.round(depositUsdc * PRICE_SCALE));
      const [userPda] = findUserAccountPda(publicKey, PROGRAM_ID);
      const [creditPda] = findTradingCreditPda(publicKey, marketIndex, PROGRAM_ID);
      const [positionPda] = findPositionPda(publicKey, marketIndex, PROGRAM_ID);
      const ata = await getAssociatedTokenAddress(USDC_MINT, publicKey);

      const [uInfo, cInfo, pInfo, lamports] = await Promise.all([
        connection.getAccountInfo(userPda),
        connection.getAccountInfo(creditPda),
        connection.getAccountInfo(positionPda),
        // Costs no extra round trip alongside the three above, and it is what
        // the rent/fee refusal below needs.
        connection.getBalance(publicKey).catch(() => null),
      ]);

      const ixs = [];
      if (!(uInfo && uInfo.data[0] === DISC_USER_ACCOUNT)) {
        ixs.push(createInitializeUserInstruction(publicKey, PROGRAM_ID));
      }
      if (depositAmount > 0n) {
        ixs.push(
          createDepositCollateralInstruction(publicKey, ata, USDC_VAULT, depositAmount, PROGRAM_ID)
        );
      }
      if (!(cInfo && cInfo.data[0] === DISC_TRADING_CREDIT)) {
        ixs.push(createInitializeTradingCreditInstruction(publicKey, marketIndex, PROGRAM_ID));
      }
      if (!pInfo) {
        ixs.push(createInitializePositionInstruction(publicKey, marketIndex, PROGRAM_ID));
      }

      // Collateral already sitting in the UserAccount from an earlier partial
      // run counts too — that is the state the old three-leg flow could strand.
      const existingFree =
        uInfo && uInfo.data[0] === DISC_USER_ACCOUNT
          ? decodeUserAccount(uInfo.data as Buffer).freeCollateral
          : 0n;
      const fundAmount = existingFree + depositAmount;
      // Money already sitting IN the trading credit counts as well. A withdraw
      // whose first leg (undelegate) landed and whose second (release) did not
      // leaves exactly this shape: credit > 0, free collateral 0, wallet USDC 0.
      // The old refusal below then fired and told the user to "Get test USDC",
      // which is both false and unreachable advice — their money was on-chain,
      // visible in the panel, and the only path back to it (Withdraw) is behind
      // the delegated state this run is what restores. There is nothing to fund
      // in that case, so skip the fund leg and just re-delegate what is there.
      const existingCredit =
        cInfo &&
        cInfo.data[0] === DISC_TRADING_CREDIT &&
        cInfo.data.length >= TRADING_CREDIT_SIZE
          ? decodeTradingCredit(cInfo.data as Buffer).credit
          : 0n;
      if (fundAmount === 0n && existingCredit === 0n) {
        setError(
          "There is nothing to move into the market. Use \u201CGet test USDC\u201D first, then press Start trading."
        );
        return false;
      }
      // fund_trading_credit rejects amount == 0 outright (fund_trading_credit.rs:44),
      // so this instruction is only added when there is something to move.
      if (fundAmount > 0n) {
        ixs.push(createFundTradingCreditInstruction(publicKey, marketIndex, fundAmount, PROGRAM_ID));
      }

      const sessionKp = Keypair.generate();
      const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECS;
      ixs.push(
        createDelegateTradingCreditInstruction(
          publicKey,
          marketIndex,
          sessionKp.publicKey,
          BigInt(expiry),
          PROGRAM_ID
        )
      );
      if (SESSION_FUND_SOL > 0) {
        ixs.push(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: sessionKp.publicKey,
            lamports: Math.floor(SESSION_FUND_SOL * 1e9),
          })
        );
      }

      const tx = new Transaction().add(...ixs);
      slog("oneshot", `built ${ixs.length} instruction(s), fund $${Number(fundAmount) / PRICE_SCALE}`);

      // The rent/fee preflight initialize() runs never ran on THIS path, which
      // is the one the Start button actually uses — so a wallet with USDC and
      // 0.004 SOL got a Phantom prompt for a six-instruction transaction that
      // could not succeed, and only learned why after approving it. Same six
      // accounts, so the same threshold and the same wording. A null lamports
      // is an unreachable RPC, which stays non-fatal here exactly as it is in
      // initialize().
      if (lamports !== null && lamports < MIN_SOL_LAMPORTS) {
        setError(
          `Your wallet needs about ${(MIN_SOL_LAMPORTS / 1e9).toFixed(3)} devnet SOL for account rent and fees — ` +
            `it has ${(lamports / 1e9).toFixed(4)}. Use "Get test USDC" (it tops up SOL too) or airdrop some, then retry.`
        );
        slog("oneshot", `BLOCKED: only ${(lamports / 1e9).toFixed(4)} SOL for rent and fees`);
        return false;
      }

      setStep("Awaiting wallet signature\u2026");
      const sig = await sendTransaction(tx, connection);
      slog("oneshot", `submitted: ${sig}`);
      setStep("Confirming on Solana\u2026");
      try {
        await confirmSignature(connection, sig, { timeoutMs: 60_000 });
      } catch (err) {
        // A confirm timeout does NOT mean the transaction failed. Before giving
        // up, check whether the credit is now delegated to THIS session key — if
        // it is, the transaction landed and the only thing at risk is the
        // secret, which must be persisted or the user silently loses their
        // session and every order falls back to a wallet popup.
        const after = await connection.getAccountInfo(creditPda).catch(() => null);
        const landed = after?.owner.toBase58() === DELEGATION_PROGRAM;
        if (!landed) throw err;
        slog("oneshot", "confirm timed out but the delegation landed — keeping the session key");
      }
      storeSession(publicKey, marketIndex, sessionKp, expiry);
      slog("oneshot", `CONFIRMED: ${sig}`);
      return true;
    },
    [publicKey, sendTransaction, connection, marketIndex]
  );

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
                // ONLY "the ATA does not exist" means zero — see
                // zeroIfTokenAccountAbsent, which is now the one place that
                // decides this for all three reads in this file.
                .catch(zeroIfTokenAccountAbsent),
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

        slog("autostart", `starting one-click setup (deposit $${deposit})`);
        // ONE transaction, ONE signature. Everything below this is the legacy
        // three-leg path, kept only for the case where the single transaction
        // is rejected for a reason that a smaller one might survive.
        if (await oneShotSetup(deposit)) {
          slog("autostart", "setup complete (single transaction)");
          setNotice("You're ready to trade — orders sign instantly, no wallet popups.");
          void refresh();
          return true;
        }
        // oneShotSetup already surfaced its own error if it refused for a
        // reason the user must act on (nothing to deposit). A false return with
        // no error set means it threw, and the outer catch reports that.
        return false;

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
    // oneShotSetup is the only leg autoStart still calls — the legacy
    // initialize/fund/delegate trio was removed from the body, and leaving them
    // here while omitting oneShotSetup pinned autoStart to the FIRST
    // oneShotSetup closure. That one captured the wallet adapter's original
    // `sendTransaction`, so a setup click after a wallet switch would sign
    // through the previous adapter.
    [publicKey, connection, marketIndex, oneShotSetup, refresh]
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
    status,
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
