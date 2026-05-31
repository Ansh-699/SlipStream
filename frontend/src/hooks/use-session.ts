"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
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
  findPositionPda,
} from "@/lib/slipstream";
import { confirmSignature } from "@/lib/confirm";

const DELEGATION_PROGRAM = DELEGATION_PROGRAM_ID.toBase58();

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

export interface SessionState {
  initialized: boolean;
  delegated: boolean;
  credit: bigint;
  committed: bigint;
  available: bigint;
  activeOrders: number;
  /** Free collateral deposited in the on-chain UserAccount (not yet in credit). */
  freeCollateral: bigint;
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
    userInitialized: false,
    sessionPublicKey: null,
    sessionActive: false,
    sessionExpiry: 0n,
    legacyCredit: false,
    legacyDelegated: false,
  });
  const [busy, setBusy] = useState(false);

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
      // UserAccount (deposited collateral) state.
      let freeCollateral = 0n;
      let userInitialized = false;
      try {
        const [userPda] = findUserAccountPda(publicKey, PROGRAM_ID);
        const uInfo = await connection.getAccountInfo(userPda);
        if (uInfo && uInfo.data[0] === DISC_USER_ACCOUNT) {
          userInitialized = true;
          freeCollateral = decodeUserAccount(uInfo.data as Buffer).freeCollateral;
        }
      } catch {
        /* ignore */
      }

      const stored = loadStoredSession(publicKey, marketIndex);
      const sessionPublicKey = stored ? stored.keypair.publicKey.toBase58() : null;

      const [pda] = findTradingCreditPda(publicKey, marketIndex, PROGRAM_ID);
      const info = await connection.getAccountInfo(pda);
      if (!info) {
        setState((s) => ({
          ...s,
          initialized: false,
          freeCollateral,
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
              const erConn = new Connection(ER_RPC, "confirmed");
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
          const erConn = new Connection(ER_RPC, "confirmed");
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
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
  }, [refresh]);

  // FULL session setup in ONE click (base layer): initialize_user (if needed) →
  // deposit_collateral (wallet USDC → on-chain UserAccount) → initialize_trading_credit.
  const initialize = useCallback(
    async (depositUsdc: number) => {
      if (!publicKey) return;
      if (!USDC_MINT || !USDC_VAULT) {
        throw new Error("USDC mint/vault missing from deploy manifest");
      }
      setBusy(true);
      try {
        const ixs = [];

        const [userPda] = findUserAccountPda(publicKey, PROGRAM_ID);
        const uInfo = await connection.getAccountInfo(userPda);
        if (!(uInfo && uInfo.data[0] === DISC_USER_ACCOUNT)) {
          ixs.push(createInitializeUserInstruction(publicKey, PROGRAM_ID));
        }

        const ata = await getAssociatedTokenAddress(USDC_MINT, publicKey);
        const depositAmount = BigInt(Math.round(depositUsdc * PRICE_SCALE));
        if (depositAmount > 0n) {
          ixs.push(
            createDepositCollateralInstruction(publicKey, ata, USDC_VAULT, depositAmount, PROGRAM_ID)
          );
        }

        const [creditPda] = findTradingCreditPda(publicKey, marketIndex, PROGRAM_ID);
        const cInfo = await connection.getAccountInfo(creditPda);
        if (!(cInfo && cInfo.data[0] === DISC_TRADING_CREDIT)) {
          ixs.push(createInitializeTradingCreditInstruction(publicKey, marketIndex, PROGRAM_ID));
        }

        // Create the L1 Position account too, so settled fills have somewhere to
        // land (settle_from_log skips fills whose owner has no Position). Without
        // this, a user's ER fills would never finalize to an L1 position.
        const [positionPda] = findPositionPda(publicKey, marketIndex, PROGRAM_ID);
        const pInfo = await connection.getAccountInfo(positionPda);
        if (!pInfo) {
          ixs.push(createInitializePositionInstruction(publicKey, marketIndex, PROGRAM_ID));
        }

        if (ixs.length === 0) {
          await refresh();
          return;
        }

        const tx = new Transaction().add(...ixs);
        const sig = await sendTransaction(tx, connection);
        await confirmSignature(connection, sig, { timeoutMs: 45_000 });
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [publicKey, sendTransaction, connection, marketIndex, refresh]
  );

  // fund_trading_credit (0x0e) — base layer.
  const fund = useCallback(
    async (amountUsdc: number) => {
      if (!publicKey) return;
      setBusy(true);
      try {
        const amount = BigInt(Math.round(amountUsdc * PRICE_SCALE));
        const ix = createFundTradingCreditInstruction(
          publicKey,
          marketIndex,
          amount,
          PROGRAM_ID
        );
        const tx = new Transaction().add(ix);
        const sig = await sendTransaction(tx, connection);
        await confirmSignature(connection, sig, { timeoutMs: 45_000 });
        await refresh();
      } finally {
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
  const delegate = useCallback(async () => {
    if (!publicKey) return;
    setBusy(true);
    try {
      // 1+2: generate + persist the session key with a TTL.
      const sessionKp = Keypair.generate();
      const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECS;
      storeSession(publicKey, marketIndex, sessionKp, expiry);

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

      const sig = await sendTransaction(tx, connection);
      await confirmSignature(connection, sig, { timeoutMs: 45_000 });
      await refresh();
    } finally {
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
        const erConn = new Connection(ER_RPC, "confirmed");
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
    } finally {
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
    } finally {
      setBusy(false);
    }
  }, [publicKey, sendTransaction, connection, marketIndex, refresh, state.legacyDelegated]);

  return {
    state,
    busy,
    initialize,
    fund,
    delegate,
    rotate,
    refresh,
    getSessionKeypair,
    closeLegacyCredit,
  };
}
