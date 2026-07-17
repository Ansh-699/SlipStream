// ---------------------------------------------------------------------------
// Vendored from @slipstream/client (slipstream/client/src/pda.ts).
//
// CANONICAL PDA derivations — copied into the frontend instead of imported from
// ../client because Next/Turbopack will not bundle modules from outside the
// project root. Keep in sync with the client SDK. `Buffer` is imported from the
// `buffer` npm package so the full polyfill is used in the browser.
// ---------------------------------------------------------------------------

import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID,
  SEED_GLOBAL,
  SEED_MARKET,
  SEED_USER,
  SEED_POSITION,
  SEED_ORDERBOOK,
  SEED_VAULT_AUTHORITY,
  SEED_CREDIT,
  SEED_LIQ_INTENT,
  SEED_TRIGGER,
  SEED_DELEGATE_BUFFER,
  SEED_DELEGATION_RECORD,
  SEED_DELEGATION_METADATA,
  DELEGATION_PROGRAM_ID,
} from "./constants";

function u16leBuf(n: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n);
  return buf;
}

export function findGlobalStatePda(
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_GLOBAL], programId);
}

export function findMarketPda(
  marketIndex: number,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_MARKET, u16leBuf(marketIndex)],
    programId
  );
}

export function findUserAccountPda(
  owner: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_USER, owner.toBuffer()],
    programId
  );
}

export function findPositionPda(
  owner: PublicKey,
  marketIndex: number,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_POSITION, owner.toBuffer(), u16leBuf(marketIndex)],
    programId
  );
}

export function findOrderBookPda(
  marketIndex: number,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_ORDERBOOK, u16leBuf(marketIndex)],
    programId
  );
}

export function findVaultAuthorityPda(
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_VAULT_AUTHORITY], programId);
}

export function findTradingCreditPda(
  owner: PublicKey,
  marketIndex: number,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_CREDIT, owner.toBuffer(), u16leBuf(marketIndex)],
    programId
  );
}

/** TriggerOrder PDA: `[b"trigger", owner, u16le(marketIndex), [kind]]` —
 *  one stop-loss (kind 0) and one take-profit (kind 1) per owner+market. */
export function findTriggerPda(
  owner: PublicKey,
  marketIndex: number,
  kind: number,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_TRIGGER, owner.toBuffer(), u16leBuf(marketIndex), Buffer.from([kind])],
    programId
  );
}

export function findLiquidationIntentPda(
  position: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_LIQ_INTENT, position.toBuffer()],
    programId
  );
}

/**
 * MagicBlock delegate **buffer** PDA: `[b"buffer", delegatedAccount]` derived
 * under the OWNER program (this program). Used to stage the account's data
 * across the delegation owner change.
 */
export function findDelegateBufferPda(
  delegatedAccount: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_DELEGATE_BUFFER, delegatedAccount.toBuffer()],
    programId
  );
}

/**
 * MagicBlock delegation **record** PDA: `[b"delegation", delegatedAccount]`
 * derived under the delegation program.
 */
export function findDelegationRecordPda(
  delegatedAccount: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_DELEGATION_RECORD, delegatedAccount.toBuffer()],
    DELEGATION_PROGRAM_ID
  );
}

/**
 * MagicBlock delegation **metadata** PDA:
 * `[b"delegation-metadata", delegatedAccount]` derived under the delegation program.
 */
export function findDelegationMetadataPda(
  delegatedAccount: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_DELEGATION_METADATA, delegatedAccount.toBuffer()],
    DELEGATION_PROGRAM_ID
  );
}
