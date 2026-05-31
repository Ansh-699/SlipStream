import { Connection } from "@solana/web3.js";
import { getKeeperAddresses } from "./shared/manifest";
import { fetchOrderBook } from "./shared/accounts";

const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";

async function main() {
  const er = new Connection(ER_RPC, "confirmed");
  const addrs = getKeeperAddresses();
  const ob = await fetchOrderBook(er, addrs.marketIndex);
  if (!ob) {
    console.log("order book not found on ER");
    return;
  }
  const active = ob.orderSlots.filter((s) => s.active);
  const bids = active.filter((s) => s.side === 0).length;
  const asks = active.filter((s) => s.side === 1).length;
  console.log(`ER order book ${addrs.orderBook.toBase58()}`);
  console.log(`  active orders=${active.length} (bids=${bids} asks=${asks})`);
  console.log(`  bid levels=${ob.header.bidLevelCount} ask levels=${ob.header.askLevelCount}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
