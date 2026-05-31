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
  SEED_FILL_LOG,
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
 * FillLog PDA: `[b"fill_log", u16le(marketIndex), u32le(epoch)]`. The small,
 * epoch-rotatable account the settlement pipeline commits to L1 instead of the
 * 612 KB OrderBook. A new epoch yields a fresh delegated account with its own
 * sponsored-commit budget.
 */
export function findFillLogPda(
  marketIndex: number,
  epoch: number,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  const epochBuf = Buffer.alloc(4);
  epochBuf.writeUInt32LE(epoch);
  return PublicKey.findProgramAddressSync(
    [SEED_FILL_LOG, u16leBuf(marketIndex), epochBuf],
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
