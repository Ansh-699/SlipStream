import { PUBLIC_FALLBACKS, rpcPost } from "@/lib/rpc-failover";

const BASE_UPSTREAM = process.env.BASE_RPC_UPSTREAM || PUBLIC_FALLBACKS.base;
const ER_UPSTREAM = process.env.ER_RPC_UPSTREAM || PUBLIC_FALLBACKS.er;

/** One order-book account as one endpoint reports it. `size` is the full
 *  account length, which the envelope gives independently of the dataSlice. */
export interface BookRead {
  owner: string;
  nextFill: number;
  activeOrders: number;
  size: number | null;
  lamports: number | null;
}

/** The deployed bytecode advances the settlement cursor to a batch maximum,
 *  not across a contiguous prefix, so it can step over destroyed fills and zero
 *  the subtraction while the loss stands. Zero is therefore two facts. */
export type UnrecoverableState =
  | { kind: "measured"; fills: number; from: number; to: number }
  | { kind: "ring-not-full" }
  | { kind: "cursor-past-gap" };

export interface ChainSnapshot {
  /** market@2058 u32le, L1. */
  settled: number;
  /** book@40 u64le, ER. */
  nextFill: number;
  ringCount: number;
  ringMax: number;
  ringHead: number;
  ringTail: number;
  /** nextFill − ringCount. */
  oldestSurviving: number;
  unrecoverable: UnrecoverableState;
  l1Book: BookRead | null;
  erBook: BookRead;
  /** SOL: market@176 / @184 u64le over BASE_SCALE 1e9. */
  oiLong: number;
  oiShort: number;
  maxLeverage: number;
  /** Unix seconds, from the L1 feed the program gates on. */
  pythPublishTime: number | null;
  /** ER slot. The two layers count slots separately, hence two fields. */
  slot: number;
  l1Slot: number;
}

interface Envelope {
  data?: [string, string];
  owner?: string;
  lamports?: number;
  space?: number;
}

function buf(env: Envelope | null | undefined): Buffer | null {
  const b64 = env?.data?.[0];
  return typeof b64 === "string" ? Buffer.from(b64, "base64") : null;
}

/** Mirrors oracle.rs::parse_pyth, length dispatch included: under
 *  VerificationLevel::Partial (byte 40 ≠ 1) every later field shifts. */
function pythPublishTime(b: Buffer): number | null {
  if (b.length >= 248) return Number(b.readBigInt64LE(96));
  if (b.length >= 101 && b[40] === 1) return Number(b.readBigInt64LE(93));
  return null;
}

export async function readChain(): Promise<ChainSnapshot | null> {
  try {
    // @/lib/manifest throws at evaluation when deploy.json is absent.
    const { MARKET, ORDER_BOOK } = await import("@/lib/manifest");
    const { decodeMarket, decodeOrderBookHeader } = await import("@/lib/slipstream/accounts");
    // manifest.ts resolves three addresses; the feed is only in the raw JSON,
    // and the CI fallback omits it.
    const generated = await import("@/lib/deploy-manifest.generated.json");
    const pythFeed = (generated.default as { pythFeed?: string }).pythFeed;

    const book = ORDER_BOOK.toBase58();
    const [l1, er] = await Promise.all([
      rpcPost(BASE_UPSTREAM, PUBLIC_FALLBACKS.base, {
        jsonrpc: "2.0",
        id: 1,
        method: "getMultipleAccounts",
        params: [
          [MARKET.toBase58(), book, ...(pythFeed ? [pythFeed] : [])],
          { encoding: "base64", dataSlice: { offset: 0, length: 2064 } },
        ],
      }),
      // The book is delegated, so L1 holds a stale pre-delegation snapshot;
      // live ring state comes from the ER. The L1 copy above is a figure subject.
      rpcPost(ER_UPSTREAM, PUBLIC_FALLBACKS.er, {
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [book, { encoding: "base64", dataSlice: { offset: 0, length: 48 } }],
      }),
    ]);

    const l1Res = (
      l1?.json as { result?: { context?: { slot?: number }; value?: (Envelope | null)[] } }
    )?.result;
    const erRes = (
      er?.json as { result?: { context?: { slot?: number }; value?: Envelope | null } }
    )?.result;
    if (!l1Res || !erRes) return null;

    const l1Slot = l1Res.context?.slot;
    const slot = erRes.context?.slot;
    if (!Number.isFinite(l1Slot) || !Number.isFinite(slot)) return null;

    const marketBuf = buf(l1Res.value?.[0]);
    const erEnv = erRes.value;
    const erBuf = buf(erEnv);
    if (!marketBuf || marketBuf.length < 2062) return null;
    if (!erEnv?.owner || !erBuf || erBuf.length < 48) return null;

    const market = decodeMarket(marketBuf);
    const header = decodeOrderBookHeader(erBuf);

    const settled = market.lastSettledSequence;
    const nextFill = Number(header.nextFillSequence);
    if (!Number.isFinite(nextFill) || nextFill < settled) return null;

    const oldestSurviving = nextFill - header.fillEventCount;
    const gap = oldestSurviving - 1 - settled;
    const ringFull =
      header.fillEventCount === header.maxFillEvents && header.fillEventHead === header.fillEventTail;
    const unrecoverable: UnrecoverableState = !ringFull
      ? { kind: "ring-not-full" }
      : gap > 0
        ? { kind: "measured", fills: gap, from: settled + 1, to: oldestSurviving - 1 }
        : { kind: "cursor-past-gap" };

    let l1Book: BookRead | null = null;
    const l1BookEnv = l1Res.value?.[1];
    const l1BookBuf = buf(l1BookEnv);
    if (l1BookEnv?.owner && l1BookBuf) {
      try {
        const h = decodeOrderBookHeader(l1BookBuf);
        l1Book = {
          owner: l1BookEnv.owner,
          nextFill: Number(h.nextFillSequence),
          activeOrders: h.activeOrderCount,
          size: l1BookEnv.space ?? null,
          lamports: l1BookEnv.lamports ?? null,
        };
      } catch {
        l1Book = null;
      }
    }

    const pythBuf = buf(l1Res.value?.[2]);

    return {
      settled,
      nextFill,
      ringCount: header.fillEventCount,
      ringMax: header.maxFillEvents,
      ringHead: header.fillEventHead,
      ringTail: header.fillEventTail,
      oldestSurviving,
      unrecoverable,
      l1Book,
      erBook: {
        owner: erEnv.owner,
        nextFill,
        activeOrders: header.activeOrderCount,
        size: erEnv.space ?? null,
        lamports: erEnv.lamports ?? null,
      },
      oiLong: Number(market.openInterestLong) / 1e9,
      oiShort: Number(market.openInterestShort) / 1e9,
      maxLeverage: market.maxLeverage,
      // Only the feed the program gates on may be labelled PYTH.
      pythPublishTime:
        pythBuf && pythFeed === market.pythFeed.toBase58() ? pythPublishTime(pythBuf) : null,
      slot: slot as number,
      l1Slot: l1Slot as number,
    };
  } catch {
    return null;
  }
}
