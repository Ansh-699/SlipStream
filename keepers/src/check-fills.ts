import { Connection } from "@solana/web3.js";
import { getErConnection } from "./shared/connection";
import { getKeeperAddresses } from "./shared/manifest";
import { decodeOrderBookHeader } from "../../client/src/accounts";
async function main() {
  const er = getErConnection();
  const { orderBook } = getKeeperAddresses();
  const info = await er.getAccountInfo(orderBook);
  if (!info) { console.log("no ER book"); return; }
  const h = decodeOrderBookHeader(info.data as Buffer);
  console.log("fillEventCount=", h.fillEventCount, "head=", h.fillEventHead, "tail=", h.fillEventTail, "max=", h.maxFillEvents, "nextFillSeq=", h.nextFillSequence);
}
main().catch(e=>{console.error(e);process.exit(1)});
