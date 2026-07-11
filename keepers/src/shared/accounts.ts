import { Connection, GetProgramAccountsFilter, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  decodeMarket,
  decodeUserAccount,
  decodePosition,
  decodeOrderBook,
  decodeOrderBookHeader,
  Market,
  UserAccount,
  Position,
  OrderBookState,
  OrderBookHeader,
} from "../../../client/src/accounts";
import { findMarketPda, findOrderBookPda, findPositionPda, findUserAccountPda } from "../../../client/src/pda";
import { getKeeperAddresses } from "./manifest";

/**
 * Resolve the Market PDA for `marketIndex`. The manifest carries the live
 * address for its own `marketIndex` (the SOL-PERP MVP market); for any other
 * index we derive the PDA under the manifest-resolved program ID. (Req 6.1)
 */
function marketAddress(marketIndex: number): PublicKey {
  const addrs = getKeeperAddresses();
  if (marketIndex === addrs.marketIndex) return addrs.market;
  return findMarketPda(marketIndex, addrs.programId)[0];
}

/** Resolve the OrderBook PDA, preferring the manifest address. (Req 6.1) */
function orderBookAddress(marketIndex: number): PublicKey {
  const addrs = getKeeperAddresses();
  if (marketIndex === addrs.marketIndex) return addrs.orderBook;
  return findOrderBookPda(marketIndex, addrs.programId)[0];
}

export async function fetchMarket(
  connection: Connection,
  marketIndex: number
): Promise<Market | null> {
  const pda = marketAddress(marketIndex);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodeMarket(info.data as Buffer);
}

export async function fetchUserAccount(
  connection: Connection,
  owner: PublicKey
): Promise<UserAccount | null> {
  const [pda] = findUserAccountPda(owner, getKeeperAddresses().programId);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodeUserAccount(info.data as Buffer);
}

export async function fetchPosition(
  connection: Connection,
  owner: PublicKey,
  marketIndex: number
): Promise<Position | null> {
  const [pda] = findPositionPda(owner, marketIndex, getKeeperAddresses().programId);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodePosition(info.data as Buffer);
}

export async function fetchOrderBookHeader(
  connection: Connection,
  marketIndex: number
): Promise<OrderBookHeader | null> {
  const pda = orderBookAddress(marketIndex);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodeOrderBookHeader(info.data as Buffer);
}

export async function fetchOrderBook(
  connection: Connection,
  marketIndex: number
): Promise<OrderBookState | null> {
  const pda = orderBookAddress(marketIndex);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodeOrderBook(info.data as Buffer);
}

export async function fetchAllPositions(
  connection: Connection,
  marketIndex?: number
): Promise<{ pubkey: PublicKey; account: Position }[]> {
  const filters: GetProgramAccountsFilter[] = [
    { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from([4])) } },
  ];
  if (marketIndex !== undefined) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(marketIndex);
    filters.push({
      memcmp: { offset: 2, bytes: bs58.encode(buf) },
    });
  }

  const accounts = await connection.getProgramAccounts(getKeeperAddresses().programId, {
    filters,
  });

  return accounts.map((a) => ({
    pubkey: a.pubkey,
    account: decodePosition(a.account.data as Buffer),
  }));
}
