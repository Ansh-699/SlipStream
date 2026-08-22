import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, DELEGATION_PROGRAM_ID, DISC_USER_ACCOUNT, DISC_TRADING_CREDIT } from "../../client/src/constants";
import { findTradingCreditPda, findUserAccountPda, findPositionPda } from "../../client/src/pda";
import { decodeTradingCredit, decodeUserAccount } from "../../client/src/accounts";

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const MARKET_INDEX = Number(process.env.MARKET_INDEX || "0");
const USER = new PublicKey(process.env.USER_PUBKEY || "anshxnbjGiUpsZpnx3c6LrK2vt8zt54vLMvY3C7Locm");

async function main() {
  const base = new Connection(BASE_RPC, "confirmed");
  const er = new Connection(ER_RPC, "confirmed");

  const sol = (await base.getBalance(USER)) / 1e9;
  console.log(`user ${USER.toBase58()} SOL=${sol.toFixed(4)}`);

  const [userPda] = findUserAccountPda(USER);
  const uInfo = await base.getAccountInfo(userPda);
  if (uInfo && uInfo.data[0] === DISC_USER_ACCOUNT) {
    const u = decodeUserAccount(uInfo.data as Buffer);
    console.log(`UserAccount ${userPda.toBase58()} free=${u.freeCollateral} creditOutstanding=${u.creditOutstanding} pendingFills=${u.pendingFills}`);
  } else {
    console.log(`UserAccount ${userPda.toBase58()} ABSENT`);
  }

  const [creditPda] = findTradingCreditPda(USER, MARKET_INDEX);
  const cInfo = await base.getAccountInfo(creditPda);
  if (!cInfo) {
    console.log(`credit ${creditPda.toBase58()} ABSENT`);
  } else {
    const delegated = cInfo.owner.equals(DELEGATION_PROGRAM_ID);
    console.log(`credit ${creditPda.toBase58()} base-len=${cInfo.data.length} owner=${delegated ? "DELEGATED" : cInfo.owner.toBase58()}`);
    let data = cInfo.data;
    if (delegated) {
      const erInfo = await er.getAccountInfo(creditPda);
      if (erInfo) { data = erInfo.data; console.log(`  ER-len=${erInfo.data.length}`); }
    }
    if (data.length >= 56 && data[0] === DISC_TRADING_CREDIT) {
      try {
        const tc = decodeTradingCredit(data as Buffer);
        console.log(`  credit=${tc.credit} committed=${tc.committed} active=${tc.activeOrders} session=${tc.sessionAuthority.toBase58()} exp=${tc.sessionExpiry}`);
      } catch (e: any) { console.log(`  decode (96B) failed: ${e?.message ?? e} (likely legacy 56-byte)`); }
    }
  }

  const [posPda] = findPositionPda(USER, MARKET_INDEX);
  const pInfo = await base.getAccountInfo(posPda);
  console.log(`position ${posPda.toBase58()} ${pInfo ? `present len=${pInfo.data.length}` : "ABSENT"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
