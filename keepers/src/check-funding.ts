import { getBaseConnection } from "./shared/connection";
import { getKeeperAddresses } from "./shared/manifest";
import { fetchMarket } from "./shared/accounts";
async function main() {
  const conn = getBaseConnection();
  const { marketIndex } = getKeeperAddresses();
  const m = await fetchMarket(conn, marketIndex);
  if (!m) { console.log("no market"); return; }
  const now = Math.floor(Date.now()/1000);
  console.log("lastFundingTs=", Number(m.lastFundingTs), "now=", now, "elapsed=", now - Number(m.lastFundingTs), "s");
  console.log("fundingIntervalSecs=", Number(m.fundingIntervalSecs));
  console.log("cumulativeFundingIndex=", m.cumulativeFundingIndex.toString());
  console.log("twapCount=", m.twapCount, "twap=", m.twapPrices ? "present" : "?");
}
main().catch(e=>{console.error(e?.message??e);process.exit(1)});
