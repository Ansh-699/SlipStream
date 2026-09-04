"use client";

import { baseConnection } from "@/lib/connections";

/**
 * Drop-in replacements for `@solana/wallet-adapter-react`'s `useWallet()` and
 * `useConnection()`, backed by Privy (embedded wallet, or an external wallet
 * through Privy's connectors).
 *
 * Why a shim rather than calling Privy directly at each call site: this app
 * submits owner-signed transactions to TWO different clusters — the Solana base
 * layer AND the MagicBlock Ephemeral Rollup. Any vendor `signAndSendTransaction`
 * submits through the vendor's own RPC and can never reach the ER endpoint.
 * We therefore sign to raw bytes with `signTransaction` and submit them
 * ourselves through whichever `Connection` the caller passes — which is
 * exactly the `sendTransaction(tx, connection)` contract wallet-adapter already
 * had, so the seventeen existing call sites keep working unchanged.
 *
 * Two Privy facts this file exists to pin, because each one silently breaks the
 * ER path if "simplified" away:
 *
 *   1. `signTransaction` DEFAULTS `chain` TO "solana:mainnet" when it is omitted
 *      (dist/esm/solana.mjs: `chain: s.chain || "solana:mainnet"`). Always pass
 *      "solana:devnet". This replaces Phantom's `switchNetwork("devnet")`.
 *
 *   2. The embedded-wallet confirmation modal SIMULATES the transaction against
 *      `config.solana.rpcs["solana:devnet"]` — the base layer — and throws
 *      "Simulation failed" when it does not succeed. An ER-bound transaction
 *      (undelegate, ER-side authorize, the no-session-key place/cancel/flatten
 *      fallbacks) can never simulate on L1. So ER sends skip the modal via
 *      `showWalletUIs: false`. None of those ops moves tokens, every one still
 *      carries the owner's signature, and L1 money ops keep the modal.
 *
 * Session keys are untouched by all of this: they are plain web3.js Keypairs
 * (use-session.ts) keyed by whatever `publicKey` resolves to here.
 */

import { useCallback, useMemo } from "react";
import { usePrivy } from "@privy-io/react-auth";
import {
  useWallets,
  useSignTransaction,
  useExportWallet,
} from "@privy-io/react-auth/solana";
import {
  Connection,
  PublicKey,
  type SendOptions,
  type Transaction,
} from "@solana/web3.js";

/** Re-exported from lib/connections so the whole app shares ONE base-layer
 *  Connection. Constructing one is not free: each spawns a WebSocket client
 *  that reconnects forever against a ws:// URL the HTTP proxy cannot serve. */

export function useConnection(): { connection: Connection } {
  return useMemo(() => ({ connection: baseConnection }), []);
}

export interface WalletCompat {
  publicKey: PublicKey | null;
  connected: boolean;
  connecting: boolean;
  /**
   * Sign with the connected wallet and submit through `connection`. Mirrors
   * wallet-adapter's signature, including auto-filling `feePayer` and
   * `recentBlockhash` when the caller left them unset.
   */
  sendTransaction: (
    transaction: Transaction,
    connection: Connection,
    options?: SendOptions
  ) => Promise<string>;
  /**
   * Open sign-in (Google or an external wallet). If the user is already
   * authenticated but has no wallet connected, opens the connect-wallet modal
   * instead — `login()` throws when called while logged in.
   */
  connect: () => void;
  /** Sign out of Privy; also disconnects an external wallet. */
  disconnect: () => Promise<void>;
  /** Privy access token for server routes (the faucet). null when signed out. */
  getAuthToken: () => Promise<string | null>;
  /**
   * Opens Privy's export-key iframe. Present only when the active wallet is the
   * embedded one; an external wallet already owns its key.
   */
  exportWallet: (() => Promise<void>) | null;
}

const EMBEDDED_WALLET_NAME = "Privy";

export function useWallet(): WalletCompat {
  const { ready, authenticated, login, logout, connectWallet, getAccessToken } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { exportWallet } = useExportWallet();

  // Active wallet: the embedded one when present, else the first connected
  // external. ponytail: no switcher. With createOnLogin "users-without-wallets"
  // a user has BOTH only if a Google user later connects an extension, which
  // this UI offers no path to. Add a <select> in WalletIdentity keyed on
  // wallets[] if that ever becomes reachable.
  const active = useMemo(
    () => wallets.find((w) => w.standardWallet.name === EMBEDDED_WALLET_NAME) ?? wallets[0] ?? null,
    [wallets]
  );
  const address = active?.address ?? null;
  const isEmbedded = active?.standardWallet.name === EMBEDDED_WALLET_NAME;

  const publicKey = useMemo(() => {
    if (!address) return null;
    try {
      return new PublicKey(address);
    } catch {
      return null;
    }
  }, [address]);

  const sendTransaction = useCallback(
    async (
      transaction: Transaction,
      connection: Connection,
      options?: SendOptions
    ): Promise<string> => {
      if (!active || !publicKey) throw new Error("Wallet is not connected.");

      // Fill from the CALLER's cluster, only when unset. The ER call sites
      // already pin both from erConnection before reaching here, so this
      // never fetches a blockhash from the wrong layer for them.
      if (!transaction.feePayer) transaction.feePayer = publicKey;
      if (!transaction.recentBlockhash) {
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
      }

      const onEr = connection !== baseConnection;
      const { signedTransaction } = await signTransaction({
        transaction: transaction.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }),
        wallet: active,
        chain: "solana:devnet",
        options: onEr ? { uiOptions: { showWalletUIs: false } } : undefined,
      });

      // Deliberately loud: the cluster each signature goes to is the single
      // most important fact in this file, and the manual verification script
      // reads it off the console. An undelegate that lands on L1 instead of the
      // ER strands the credit unrecoverably.
      console.log(`%c[wallet] signed → ${connection.rpcEndpoint}`, "color:#34d399");

      return connection.sendRawTransaction(signedTransaction, options);
    },
    [active, publicKey, signTransaction]
  );

  const connect = useCallback(() => {
    if (!ready) return;
    if (authenticated) connectWallet({ walletChainType: "solana-only" });
    else login();
  }, [ready, authenticated, login, connectWallet]);

  const exportActive = useMemo(
    () => (isEmbedded && address ? () => exportWallet({ address }) : null),
    [isEmbedded, address, exportWallet]
  );

  return {
    publicKey,
    connected: publicKey !== null,
    connecting: !ready || (authenticated && !walletsReady),
    sendTransaction,
    connect,
    disconnect: logout,
    getAuthToken: getAccessToken,
    exportWallet: exportActive,
  };
}
