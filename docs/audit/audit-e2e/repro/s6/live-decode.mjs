// S6 audit scratch. READ-ONLY devnet check: fetch the live Market account and
// decode it with the exact byte offsets the vendored TS decoders use, so the
// layout table is validated against real on-chain bytes and not only against the
// Rust source. Also reports which Pyth account the market is actually pinned to
// versus the `PYTH_SOL_USD_DEVNET` constant both SDK copies export.
//
//   node docs/audit/audit-e2e/repro/s6/live-decode.mjs
//
// No signer, no transaction, no mutation - two getAccountInfo calls.

const RPC = "https://api.devnet.solana.com";
const MARKET = "ECUp8pXzVLzxjVs8mtKBJma3mdcHf8zSC4cqPeBy8MPy"; // deploy.json `market`
const SDK_CONST_FEED = "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"; // PYTH_SOL_USD_DEVNET

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}

async function acct(pubkey) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getAccountInfo",
      params: [pubkey, { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  const j = await r.json();
  const v = j.result?.value;
  return v ? { owner: v.owner, data: Buffer.from(v.data[0], "base64") } : null;
}

const iso = (s) => new Date(Number(s) * 1000).toISOString();

const m = await acct(MARKET);
if (!m) throw new Error("market account not found");
console.log(`fetched-at            ${new Date().toISOString()}`);
console.log(`market                ${MARKET}`);
console.log(`owner                 ${m.owner}`);
console.log(`data.length           ${m.data.length}   (size_of::<Market>() = 2064)`);
console.log(`--- decoded at the exact offsets client/src/accounts.ts decodeMarket() uses ---`);
console.log(`  @0    discriminator ${m.data.readUInt8(0)}   (DISC_MARKET = 2)`);
console.log(`  @2    market_index  ${m.data.readUInt16LE(2)}`);
console.log(`  @4    max_leverage  ${m.data.readUInt8(4)}   (deploy.json maxLeverage = 20)`);
console.log(`  @6    taker_fee_bps ${m.data.readUInt16LE(6)}`);
console.log(`  @8    maker_reb_bps ${m.data.readUInt16LE(8)}`);
console.log(`  @12   twap_count    ${m.data.readUInt16LE(12)}`);
console.log(`  @80   pyth_feed     ${b58(m.data.subarray(80, 112))}`);
console.log(`  @112  quote_vault   ${b58(m.data.subarray(112, 144))}   (deploy.json usdcVault = BTWVG5oDmomaMkpdX4xYgfjr1gpEGodW5oPe3k5P71qr)`);
console.log(`  @144  tick_size     ${m.data.readBigUInt64LE(144)}   (deploy.json tickSize = 1000)`);
console.log(`  @152  lot_size      ${m.data.readBigUInt64LE(152)}   (deploy.json lotSize = 100000000)`);
console.log(`  @168  last_funding  ${m.data.readBigInt64LE(168)}  ${iso(m.data.readBigInt64LE(168))}`);
console.log(`  @200  last_mark     ${m.data.readBigUInt64LE(200)}  = $${Number(m.data.readBigUInt64LE(200)) / 1e6}`);
console.log(`  @2024 switchboard   ${b58(m.data.subarray(2024, 2056))}`);
console.log(`  @2056 restricted    ${m.data.readUInt8(2056)}`);
console.log(`  @2057 agreement_str ${m.data.readUInt8(2057)}   <- decoded by NEITHER TS copy`);
console.log(`  @2058 last_settled  ${m.data.readUInt32LE(2058)}   (u32 aliased into _padding2)`);
console.log(`--- SDK constant vs the feed the market is pinned to ---`);
console.log(`  PYTH_SOL_USD_DEVNET (client/src/constants.ts:23, frontend .../constants.ts:37)`);
console.log(`    ${SDK_CONST_FEED}`);
const pinned = b58(m.data.subarray(80, 112));
console.log(`  market.pyth_feed @80  ${pinned}`);
console.log(`  MATCH? ${SDK_CONST_FEED === pinned}`);
const legacy = await acct(SDK_CONST_FEED);
console.log(`  legacy feed account: ${legacy ? `owner=${legacy.owner} len=${legacy.data.length}` : "MISSING"}`);
if (legacy && legacy.data.length >= 248) {
  // Legacy Pyth V2 PriceAccountV2, per programs/slipstream/src/oracle.rs parse_pyth.
  const expo = legacy.data.readInt32LE(20);
  const px = legacy.data.readBigInt64LE(208);
  const ts = legacy.data.readBigInt64LE(96);
  console.log(`    price=${px} expo=${expo} -> $${Number(px) * 10 ** expo}`);
  console.log(`    publish_ts=${ts}  ${iso(ts)}   (age ${(Date.now() / 1000 - Number(ts)) / 86400 | 0} days)`);
}
const live = await acct(pinned);
console.log(`  market's own feed:   ${live ? `owner=${live.owner} len=${live.data.length}` : "MISSING"}`);
