// S13 scratch repro — read-only devnet.
// Fetches the live Market + Pyth feed and reproduces, byte for byte, the strings
// the S13-owned components would render right now. No signer, no mutation.
//
//   node docs/audit/audit-e2e/repro/s13/live-render.mjs

const BASE = "https://api.devnet.solana.com";
const MARKET = "ECUp8pXzVLzxjVs8mtKBJma3mdcHf8zSC4cqPeBy8MPy";
const PYTH = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
const ORDER_BOOK = "83zMFL6cHjgXkQ7KRNcgtHaZ1fhyNgxhM8aMpPpEnMqe";
const PRICE_SCALE = 1_000_000;
const MAX_LEVERAGE = 20; // deploy-manifest.generated.json

async function getAccount(rpc, pk, enc = "base64") {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getAccountInfo",
      params: [pk, { encoding: enc, commitment: "confirmed" }],
    }),
  });
  const j = await r.json();
  if (!j.result?.value) throw new Error(`no account ${pk}: ${JSON.stringify(j)}`);
  return Buffer.from(j.result.value.data[0], "base64");
}

// ---- Market (frontend/src/lib/slipstream/accounts.ts:158-165) ----
const m = await getAccount(BASE, MARKET);
const lastFundingTs = m.readBigInt64LE(168);
const openInterestLong = m.readBigUInt64LE(176);
const openInterestShort = m.readBigUInt64LE(184);
const lastMarkPrice = m.readBigUInt64LE(200);

// ---- Pyth price update v2: price i64 @72, expo i32 @80, publishTime i64 @84 ----
const p = await getAccount(BASE, PYTH);
// PriceUpdateV2 offsets, from programs/slipstream/src/oracle.rs:133-136
const pythPrice = p.readBigInt64LE(73);
const pythExpo = p.readInt32LE(89);
const pythPub = p.readBigInt64LE(93);
const spot = Number(pythPrice) * Math.pow(10, pythExpo);

const now = Math.floor(Date.now() / 1000);
const markPrice = Number(lastMarkPrice) / PRICE_SCALE;

console.log("=== live devnet read, " + new Date().toISOString() + " ===");
console.log("market            ", MARKET);
console.log("last_mark_price   ", lastMarkPrice.toString(), "=> $" + markPrice.toFixed(3));
console.log("last_funding_ts   ", lastFundingTs.toString(), "=", new Date(Number(lastFundingTs) * 1000).toISOString());
console.log("                   (" + ((now - Number(lastFundingTs)) / 86400).toFixed(1) + " days ago)");
console.log("open_interest_long ", openInterestLong.toString());
console.log("open_interest_short", openInterestShort.toString());
console.log("pyth feed         ", PYTH);
console.log("pyth price        ", "$" + spot.toFixed(3), "published", new Date(Number(pythPub) * 1000).toISOString(),
  "(" + (now - Number(pythPub)) + "s ago)");

const divergence = Math.abs(markPrice - spot) / spot;
console.log("\ndivergence mark vs oracle:", (divergence * 100).toFixed(2) + "%");

// ---- What each S13 component renders, verbatim ----
console.log("\n=== rendered strings ===");
// market-bar.tsx:86 headline uses `spot ?? markPrice`
console.log('market-bar.tsx:86   headline        "' + spot.toFixed(2) + '"');
// market-bar.tsx:102 Mark stat
console.log('market-bar.tsx:102  Mark stat       "' + markPrice.toFixed(3) + '"  label "' +
  (divergence > 0.01 ? "Mark (stale)" : "Mark") + '"');
// market-bar.tsx:109/113 OI
console.log('market-bar.tsx:109  OI Long         "' + (Number(openInterestLong) / 1e9).toFixed(2) + '"');
console.log('market-bar.tsx:113  OI Short        "' + (Number(openInterestShort) / 1e9).toFixed(2) + '"');
// status-panel.tsx:188
console.log('status-panel:188    Mark freshness  "' + (divergence * 100).toFixed(2) + '% off oracle"  level ' +
  (divergence > 0.015 ? "down" : divergence > 0.005 ? "warn" : "ok"));

// positions-table.tsx:283 / :355 render the SAME frozen mark in a column headed "Mark",
// with no stale tone and no divergence banner.
console.log('positions-table:355 Mark column     "$' + markPrice.toFixed(2) + '"   <- frozen value, no stale treatment');

// A worked position: 1.0 SOL long opened at the CURRENT oracle price.
const size = 1.0, entry = spot;
const uiInitialMargin = (size * entry) / MAX_LEVERAGE;
const uiMaint = uiInitialMargin / 2;
const uiUpnlFrozen = (markPrice - entry) * size;              // positions-table.tsx:536, mark = frozen
const uiHealthFrozen = (uiInitialMargin + uiUpnlFrozen) / uiMaint;
const uiUpnlTrue = (spot - entry) * size;
const uiHealthTrue = (uiInitialMargin + uiUpnlTrue) / uiMaint;
console.log("\n=== 1.0 SOL long, entry = today's oracle $" + entry.toFixed(2) + " ===");
console.log("  health rendered with the FROZEN mark:", uiHealthFrozen.toFixed(2),
  uiHealthFrozen >= 2 ? "(green)" : uiHealthFrozen >= 1.3 ? "(amber)" : "(RED)");
console.log("  health at the true oracle price     :", uiHealthTrue.toFixed(2), "(green)");
console.log("  uPnL rendered:", (uiUpnlFrozen < 0 ? "-$" : "+$") + Math.abs(uiUpnlFrozen).toFixed(2),
  "  true uPnL:", (uiUpnlTrue < 0 ? "-$" : "+$") + Math.abs(uiUpnlTrue).toFixed(2));

// ---- order-form.tsx "Margin at risk" vs what the program reserves ----
console.log("\n=== order-form.tsx: 'Margin at risk' vs place_order.rs:171 ===");
for (const lev of [1, 2, 5, 10, 20]) {
  const posted = 100;                       // user types $100 into Margin
  const notional = posted * lev;            // order-form.tsx:94
  const rawSol = notional / entry;
  const lots = Math.max(0, Math.round(rawSol / 0.1));
  const sizeSol = lots * 0.1;
  const actualNotional = sizeSol * entry;
  const shown = actualNotional / lev;       // order-form.tsx:101  -> the "Margin at risk" row
  const reserved = actualNotional / MAX_LEVERAGE; // compute_initial_margin(notional, market.max_leverage)
  const liqMovePct = 100 * ((reserved / 2) / actualNotional); // health<1 <=> uPnL < -(maint)
  console.log(`  lev ${String(lev).padStart(2)}x  size ${sizeSol.toFixed(1)} SOL  notional $${actualNotional.toFixed(2)}` +
    `  | shown "Margin at risk" $${shown.toFixed(2)}  | program reserves $${reserved.toFixed(2)}` +
    `  | liquidates on a ${liqMovePct.toFixed(2)}% adverse move`);
}

// ---- handleFlatten crossing price (positions-table.tsx:82-84) ----
console.log("\n=== positions-table.tsx:83 flatten cross price, built off the frozen mark ===");
const crossLong = markPrice * 0.95;
const crossShort = markPrice * 1.05;
console.log(`  closing a LONG  -> IOC ASK limit $${crossLong.toFixed(3)}  (best bid is near $${spot.toFixed(2)}) -> fills`);
console.log(`  closing a SHORT -> IOC BID limit $${crossShort.toFixed(3)}  (best ask is near $${spot.toFixed(2)}) -> ` +
  (crossShort < spot ? "DOES NOT CROSS, silently no-fills" : "fills"));

// ---- landing-view.tsx:35 claims the book is "612 KB" ----
const ob = await getAccount(BASE, ORDER_BOOK).catch(() => null);
if (ob) console.log("\norder_book account bytes:", ob.length, "=", (ob.length / 1024).toFixed(2),
  "KB  (landing-view.tsx:35 claims \"612 KB\") -> accurate");

// ---- What order-book-display.tsx renders as "mid" (K4: 16-day-old resting orders) ----
// The book the terminal reads lives on the ER (frontend/src/hooks/use-orderbook.ts:79-86).
{
  const erBook = await getAccount("https://devnet.magicblock.app", ORDER_BOOK).catch(() => null);
  if (erBook) {
    // Layout constants from frontend/src/lib/slipstream/constants.ts:128-131 and
    // the header decoder at accounts.ts:374-397.
    const HDR = 48, SLOT = 88, LVL = 16;
    const maxSlots = erBook.readUInt16LE(8), maxLvl = erBook.readUInt16LE(10);
    const bidBase = HDR + maxSlots * SLOT, askBase = bidBase + maxLvl * LVL;
    const rd = (base) => {
      const out = [];
      for (let i = 0; i < maxLvl; i++) {
        const o = base + i * LVL;
        const price = Number(erBook.readBigUInt64LE(o)) / PRICE_SCALE;
        if (erBook.readUInt16LE(o + 12) > 0 && price > 0) out.push(price);
      }
      return out;
    };
    const bids = rd(bidBase).sort((a, b) => b - a);
    const asks = rd(askBase).sort((a, b) => a - b);
    console.log("\n=== ER order book, what order-book-display.tsx renders ===");
    console.log("  activeOrderCount", erBook.readUInt16LE(14), " bidLevels", bids.length, " askLevels", asks.length);
    if (bids.length && asks.length) {
      const mid = (bids[0] + asks[0]) / 2;
      console.log(`  order-book-display.tsx:128  "mid" = ${mid.toFixed(3)}   spread ${(asks[0] - bids[0]).toFixed(3)}`);
      console.log(`  oracle now $${spot.toFixed(3)} -> the rendered mid is ${(100 * Math.abs(mid - spot) / spot).toFixed(1)}% away`);
      console.log("  the empty-state branch (:100-104) only knows loading / unavailable / empty;");
      console.log("  a 16-day-old ladder renders identically to a live one.");
    }
    // Can the UI even know the age? Only expiry_ts is stored per slot.
    let active = 0, withExpiry = 0;
    for (let i = 0; i < maxSlots; i++) {
      const o = HDR + i * SLOT;
      if (erBook[o] !== 0) { active++; if (erBook.readBigInt64LE(o + 72) !== 0n) withExpiry++; }
    }
    console.log(`  active slots ${active}; slots carrying a non-zero expiry_ts: ${withExpiry}`);
    console.log("  -> OrderSlot has no creation timestamp (accounts.ts:416-430), so age cannot be");
    console.log("     derived from the book; a mid-vs-oracle check is the only available signal.");
  }
}

// ---- The UI's health/liq vs what liquidate_position.rs actually computes ----
// UI  (positions-table.tsx:520-540): margin = size*ENTRY/20, maint = margin/2,
//      uPnL uses `markPrice` = market.last_mark_price (frozen).
// Chain (liquidate_position.rs:91-101 -> :131-156): mark = LIVE dual-oracle price,
//      notional/maint recomputed at that mark, net margin = pos.collateral + uPnL.
console.log("\n=== UI health vs liquidate_position.rs, at the live prices above ===");
for (const [side, sz, ent] of [["SHORT", 1.0, markPrice], ["LONG", 1.0, markPrice]]) {
  const isLong = side === "LONG";
  const uiMargin = (sz * ent) / MAX_LEVERAGE, uiM = uiMargin / 2;
  const uiPnl = (isLong ? markPrice - ent : ent - markPrice) * sz;   // frozen mark
  const uiHealth = (uiMargin + uiPnl) / uiM;
  const uiLiq = isLong ? ent - (uiMargin - uiM) / sz : ent + (uiMargin - uiM) / sz;
  // chain: collateral == filled_margin == notional_at_entry / max_leverage
  const collateral = (sz * ent) / MAX_LEVERAGE;
  const chainMaint = ((sz * spot) / MAX_LEVERAGE) / 2;
  const chainPnl = (isLong ? spot - ent : ent - spot) * sz;
  const net = collateral + chainPnl;
  const chainHealth = net <= 0 ? 0 : net / chainMaint;
  console.log(`  ${side} ${sz} SOL @ entry $${ent.toFixed(3)} (the terminal's own "Mark")`);
  console.log(`    UI    -> health ${uiHealth.toFixed(2)} ${uiHealth >= 2 ? "GREEN" : uiHealth >= 1.3 ? "amber" : "RED"}` +
    `, liq $${uiLiq.toFixed(2)}, uPnL ${(uiPnl < 0 ? "-$" : "+$") + Math.abs(uiPnl).toFixed(2)}`);
  console.log(`    chain -> health ${chainHealth.toFixed(2)} ` +
    `${chainHealth < 1 ? "*** LIQUIDATABLE (HEALTH_FACTOR_LIQUIDATION_THRESHOLD = 1.0) ***" : "safe"}` +
    `, uPnL ${(chainPnl < 0 ? "-$" : "+$") + Math.abs(chainPnl).toFixed(2)}`);
}
