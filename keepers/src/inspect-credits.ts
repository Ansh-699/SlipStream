/**
 * inspect-credits — read-only audit of the user + bot TradingCredit accounts
 * after the session-keys upgrade. Reports each PDA's owner (delegated vs
 * program-owned), data length (legacy 56 vs new 96), and decoded fields when
 * the size is current. No mutations, minimal RPC.
 *
 *   npx tsx src/inspect-credits.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, DELEGATION_PROGRAM_ID, TRADING_CREDIT_SIZE } from "../../client/src/constants";
import { findTradingCreditPda } from "../../client/src/pda";
import { decodeTradingCredit } from "../../client/src/accounts";
import { loadBotWallets, getBotCounts } from "./shared/bot-wallets";

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const MARKET_INDEX = Number(process.env.MARKET_INDEX || "0");
const USER = new PublicKey(
  process.env.USER_PUBKEY || "anshxnbjGiUpsZpnx3c6LrK2vt8zt54vLMvY3C7Locm"
);

async function describe(base: Connection, er: Connection, label: string, owner: PublicKey) {
  const [pda] = findTradingCreditPda(owner, MARKET_INDEX);
  const info = await base.getAccountInfo(pda);
  if (!info) {
    console.log(`${label.padEnd(10)} ${owner.toBase58()} credit=${pda.toBase58()} -> ABSENT (no account)`);
    return;
  }
  const delegated = info.owner.equals(DELEGATION_PROGRAM_ID);
  const ownerTag = delegated ? "DELEGATED" : info.owner.equals(PROGRAM_ID) ? "program-owned" : info.owner.toBase58();
  let extra = "";
  // Read decodable data from the layer that owns it (ER when delegated).
  let data = info.data;
  if (delegated) {
    const erInfo = await er.getAccountInfo(pda);
    if (erInfo) data = erInfo.data;
  }
  if (data.length >= TRADING_CREDIT_SIZE) {
    try {
      const tc = decodeTradingCredit(data as Buffer);
      const sess = tc.sessionAuthority.toBase58() === PublicKey.default.toBase58()
        ? "none"
        : `${tc.sessionAuthority.toBase58().slice(0, 8)}… exp=${tc.sessionExpiry}`;
      extra = ` credit=${tc.credit} committed=${tc.committed} active=${tc.activeOrders} session=${sess}`;
    } catch (e: any) {
      extra = ` (decode failed: ${e?.message ?? e})`;
    }
  }
  console.log(
    `${label.padEnd(10)} ${owner.toBase58()} credit=${pda.toBase58()} len=${data.length} owner=${ownerTag}${extra}`
  );
}

async function main() {
  const base = new Connection(BASE_RPC, "confirmed");
  const er = new Connection(ER_RPC, "confirmed");
  console.log(`TRADING_CREDIT_SIZE (current SDK) = ${TRADING_CREDIT_SIZE}`);
  console.log(`market index = ${MARKET_INDEX}\n`);

  await describe(base, er, "USER", USER);

  const wallets = loadBotWallets(getBotCounts());
  for (const w of wallets) {
    await describe(base, er, w.name, w.keypair.publicKey);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
