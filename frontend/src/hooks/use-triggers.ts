"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PROGRAM_ID, MARKET_INDEX } from "@/lib/manifest";
import {
  findTriggerPda,
  decodeTriggerOrder,
  TRIGGER_KIND_STOP_LOSS,
  TRIGGER_KIND_TAKE_PROFIT,
  type TriggerOrder,
} from "@/lib/slipstream";

export interface Triggers {
  stopLoss: TriggerOrder | null;
  takeProfit: TriggerOrder | null;
}

/** The connected wallet's SL/TP triggers for the active market (5s poll). */
export function useTriggers(marketIndex: number = MARKET_INDEX) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [triggers, setTriggers] = useState<Triggers>({ stopLoss: null, takeProfit: null });

  const refresh = useCallback(async () => {
    if (!publicKey) {
      setTriggers({ stopLoss: null, takeProfit: null });
      return;
    }
    try {
      const [slPda] = findTriggerPda(publicKey, marketIndex, TRIGGER_KIND_STOP_LOSS, PROGRAM_ID);
      const [tpPda] = findTriggerPda(publicKey, marketIndex, TRIGGER_KIND_TAKE_PROFIT, PROGRAM_ID);
      const infos = await connection.getMultipleAccountsInfo([slPda, tpPda]);
      const decode = (data: Buffer | undefined | null): TriggerOrder | null => {
        if (!data) return null;
        try {
          return decodeTriggerOrder(data);
        } catch {
          return null;
        }
      };
      setTriggers({
        stopLoss: decode(infos[0]?.data as Buffer | undefined),
        takeProfit: decode(infos[1]?.data as Buffer | undefined),
      });
    } catch {
      // transient RPC error — keep last state
    }
  }, [connection, publicKey, marketIndex]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
  }, [refresh]);

  return { triggers, refresh };
}
