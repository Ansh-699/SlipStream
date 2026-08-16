"use client";

/**
 * Drop-in replacements for `@solana/wallet-adapter-react`'s `useWallet()` and
 * `useConnection()`, backed by the Phantom Connect embedded wallet.
 *
 * Why a shim rather than calling the Phantom SDK directly at each call site:
 * this app submits owner-signed transactions to TWO different clusters — the
 * Solana base layer AND the MagicBlock Ephemeral Rollup. Phantom's
 * `signAndSendTransaction` submits via Phantom's own infrastructure, and its
 * `switchNetwork` only accepts "mainnet" | "devnet", so it can never reach the
 * ER endpoint. We therefore sign with `signTransaction` and submit the raw
 * bytes ourselves through whichever `Connection` the caller passes — which is
 * exactly the `sendTransaction(tx, connection)` contract wallet-adapter
 * already had, so existing call sites keep working unchanged.
 */

import { useCallback, useEffect, useMemo } from "react";
import { useAccounts, useSolana, usePhantom } from "@phantom/react-sdk";
import { AddressType } from "@phantom/browser-sdk";
import {
  Connection,
  PublicKey,
  type SendOptions,
  type Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";
import { RPC_URL } from "@/lib/manifest";

/** Lazily-created, process-wide base-layer connection (RPC_URL is a constant). */
let baseConnection: Connection | null = null;

export function useConnection(): { connection: Connection } {
  return useMemo(() => {
    if (!baseConnection) {
      baseConnection = new Connection(RPC_URL, "confirmed");
    }
    return { connection: baseConnection };
  }, []);
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
}

export function useWallet(): WalletCompat {
  const addresses = useAccounts();
  const { solana, isAvailable } = useSolana();
  const { isConnected, isConnecting } = usePhantom();

  const publicKey = useMemo(() => {
    if (!addresses || addresses.length === 0) return null;
    const solEntry =
      addresses.find((a) => a.addressType === AddressType.solana) ?? addresses[0];
    if (!solEntry?.address) return null;
    try {
      return new PublicKey(solEntry.address);
    } catch {
      return null;
    }
  }, [addresses]);

  // Keep the wallet's signing context on devnet. Harmless no-op if the provider
  // is already there; injected wallets may reject it, which must not be fatal.
  useEffect(() => {
    if (!isAvailable || !isConnected) return;
    void solana.switchNetwork("devnet").catch(() => {
      /* provider doesn't support switching — signing still works */
    });
  }, [isAvailable, isConnected, solana]);

  const sendTransaction = useCallback(
    async (
      transaction: Transaction,
      connection: Connection,
      options?: SendOptions
    ): Promise<string> => {
      if (!isAvailable) throw new Error("Wallet is not available.");
      if (!publicKey) throw new Error("Wallet is not connected.");

      if (!transaction.feePayer) transaction.feePayer = publicKey;
      if (!transaction.recentBlockhash) {
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
      }

      const signed = (await solana.signTransaction(transaction)) as
        | Transaction
        | VersionedTransaction;
      return connection.sendRawTransaction(signed.serialize(), options);
    },
    [isAvailable, publicKey, solana]
  );

  return {
    publicKey,
    connected: isConnected,
    connecting: isConnecting,
    sendTransaction,
  };
}
