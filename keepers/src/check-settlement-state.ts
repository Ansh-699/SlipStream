import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";
import { getBaseConnection, getErConnection } from "./shared/connection";
import { getKeeperAddresses } from "./shared/manifest";
import { decodeOrderBookHeader } from "../../client/src/accounts";

const DISC_POSITION = 4; // Position account discriminator (client/src/constants.ts)

async function main() {
  const base = getBaseConnection();
  const er = getErConnection();
  const { orderBook, programId, market } = getKeeperAddresses();

  // Orderbook headers on both layers.
  const erInfo = await er.getAccountInfo(orderBook);
  const l1Info = await base.getAccountInfo(orderBook);
  if (erInfo) {
    const h = decodeOrderBookHeader(erInfo.data as Buffer);
    console.log("ER  orderbook: fillEventCount=%d fillEventHead=%d nextFillSeq=%s dataLen=%d owner=%s",
      h.fillEventCount, h.fillEventHead, h.nextFillSequence.toString(), erInfo.data.length, erInfo.owner.toBase58());
  } else console.log("ER orderbook MISSING");
  if (l1Info) {
    const h = decodeOrderBookHeader(l1Info.data as Buffer);
    console.log("L1  orderbook: fillEventCount=%d fillEventHead=%d nextFillSeq=%s dataLen=%d owner=%s",
      h.fillEventCount, h.fillEventHead, h.nextFillSequence.toString(), l1Info.data.length, l1Info.owner.toBase58());
  } else console.log("L1 orderbook MISSING");

  // Count existing L1 Position accounts for this program (proves settlement ever ran).
  const accounts = await base.getProgramAccounts(programId, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from([DISC_POSITION])) } }],
  });
  console.log("L1 Position accounts (disc %d): %d", DISC_POSITION, accounts.length);
  let nonEmpty = 0;
  for (const { pubkey, account } of accounts) {
    // size is i64 at offset 40 in Position layout
    const size = account.data.readBigInt64LE(40);
    if (size !== 0n) {
      nonEmpty++;
      console.log("  position %s size=%s", pubkey.toBase58(), size.toString());
    }
  }
  console.log("non-empty positions: %d", nonEmpty);
}

main().catch((e) => { console.error(e); process.exit(1); });
