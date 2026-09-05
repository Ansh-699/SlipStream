# 0 · Architecture Diagrams

> The whole system in pictures. Mermaid diagrams render live in the
> [web docs](https://slipstream.ansht.tech/docs); on GitHub they render too.
> Read [doc 1](./01-architecture-overview.md) for the prose walkthrough.

---

## 0.1 The layer cake — what lives where

The single most important idea: **hot, non-financial state runs fast on the
Ephemeral Rollup (ER); all value-bearing state stays safe on Solana L1.** Only
the OrderBook (and a scoped TradingCredit during a session) is ever delegated.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  CLIENT LAYER                                                              │
│  Next.js frontend · wallet · session key · live Pyth chart                │
│      │ orders/cancels → /api/rpc/er          │ positions/$ → /api/rpc/base │
└──────┼──────────────────────────────────────┼──────────────────────────────┘
       │                                       │
┌──────▼───────────────────────────┐   ┌───────▼───────────────────────────────┐
│  EPHEMERAL ROLLUP (MagicBlock)    │   │  SOLANA L1 (base layer)                │
│  ~10 ms blocks · sponsored fees   │   │  ~400 ms blocks · real fees · secure   │
│                                   │   │                                        │
│  DELEGATED, mutated here:         │   │  NEVER delegated — only L1 moves these:│
│   • OrderBook (~612 KB)           │   │   • UserAccount  (free_collateral)     │
│       slots · price levels        │   │   • Position     (size/entry/PnL)      │
│       fill-event ring             │   │   • Market       (funding/TWAP/OI)     │
│   • TradingCredit (per session)   │   │   • Quote vault  (everyone's USDC)     │
│       margin allowance + session  │   │   • GlobalState  (pause/authority)     │
│                                   │   │   • FillLog (small) ← committed here   │
│  place_order · cancel_order       │   │  deposit · settle_from_log · funding   │
│  mirror_fills · commit_fill_log   │   │  liquidate · close · withdraw          │
└───────────────┬───────────────────┘   └───────────────▲────────────────────────┘
                │   commit small FillLog (ER → L1)        │
                └─────────────────────────────────────────┘
                         keepers crank the bridge
```

> **Safety boundary, one line:** delegation is capped, not unlimited — the
> OrderBook (non-financial) and a scoped, user-capped TradingCredit allowance
> are the only things ever delegated. A misbehaving ER can at worst scramble
> order *ordering* or misuse a session's capped credit — it can never touch
> the vault or a user's un-delegated balance.

---

## 0.2 System context (Mermaid)

```mermaid
flowchart TB
  subgraph CLIENT["Client Layer · Next.js"]
    UI["Trading UI<br/>order form · chart · positions"]
    WAL["Wallet + Session Key"]
    PROXY["/api/rpc proxy<br/>base · er + /api/faucet + /api/pyth"]
  end

  subgraph ER["MagicBlock Ephemeral Rollup · ~10ms"]
    OB["OrderBook PDA ~612KB<br/>slots · levels · fill ring"]
    TC["TradingCredit<br/>(delegated during session)"]
    FLG["FillLog ~8KB<br/>(delegated, epoch-rotated)"]
  end

  subgraph L1["Solana L1 · ~400ms · custody"]
    UA["UserAccount<br/>free_collateral"]
    POS["Position<br/>size · entry · PnL"]
    MKT["Market<br/>funding · TWAP · OI · cursor"]
    VAULT["Quote Vault<br/>USDC custody"]
    GS["GlobalState"]
  end

  subgraph KEEP["Keepers · pm2 bots"]
    KSET["fill-log<br/>mirror→commit→settle"]
    KFUND["funding"]
    KLIQ["liquidation"]
    KTWAP["twap"]
  end

  ORACLE["Pyth SOL/USD<br/>Hermes + Benchmarks"]

  UI --> WAL --> PROXY
  PROXY -->|orders, cancels| OB
  PROXY -->|positions, deposits| L1
  UI -->|live price| ORACLE

  KSET -->|mirror_fills| OB
  OB -->|fills| FLG
  KSET -->|commit_fill_log| FLG
  FLG -->|commit ER→L1| KSET
  KSET -->|settle_from_log| POS
  KFUND --> MKT
  KLIQ --> POS
  KTWAP --> MKT
  ORACLE -.-> KFUND
  ORACLE -.-> KLIQ
  ORACLE -.-> KTWAP

  TC -. delegated copy .- UA
  VAULT --- UA
```

---

## 0.3 The four software layers (Mermaid)

```mermaid
flowchart LR
  subgraph L4["Layer 4 — Frontend"]
    F["Next.js 16<br/>React · Tailwind · Privy"]
  end
  subgraph L3["Layer 3 — Keepers"]
    K["TypeScript bots<br/>settlement · funding · liq · twap"]
  end
  subgraph L2["Layer 2 — Client SDK"]
    S["PDAs · decoders · ix builders"]
  end
  subgraph L1p["Layer 1 — On-chain Program"]
    P["Pinocchio (Rust)<br/>zero-copy · 40 instructions"]
  end

  F --> S
  K --> S
  S --> P
  P -->|runs on| ER2["ER (delegated)"]
  P -->|runs on| L1b["Solana L1"]
```

---

## 0.4 Order lifecycle — click to settled position (Mermaid sequence)

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant W as Wallet / Session Key
  participant ER as Ephemeral Rollup
  participant K as Fill-Log Keeper
  participant L1 as Solana L1

  U->>W: Start trading (one action, chained below)
  W->>L1: deposit_collateral + init_user/credit/position
  W->>L1: fund_trading_credit (capped allowance)
  W->>L1: delegate_trading_credit + authorize_session
  L1-->>ER: TradingCredit now delegated

  U->>W: Place order (margin × leverage)
  W->>ER: place_order (signed by session key, no popup)
  ER->>ER: match · reserve margin · push FillEvent
  ER-->>U: position shows instantly (pending)

  K->>ER: mirror_fills (OrderBook → FillLog)
  K->>ER: commit_fill_log (snapshot to L1)
  ER-->>L1: FillLog committed
  K->>L1: settle_from_log → write Position
  L1-->>U: real settled position (PnL · health · liq)
```

---

## 0.5 Settlement & the Fill-Log pipeline (Mermaid)

The 612 KB OrderBook **can never be committed** (size cap + 10-commit-per-account
cap). A tiny ~8 KB FillLog carries fills to L1 instead; epoch rotation gives
unbounded settlement.

```mermaid
flowchart LR
  OB["OrderBook ~612KB<br/>fill-event ring<br/>(delegated forever,<br/>NEVER committed)"]
  FL["FillLog ~8KB<br/>ring of 80 fills<br/>epoch-rotatable PDA"]
  L1["L1 Positions"]

  OB -->|"1 · mirror_fills (ER)<br/>copy seq &gt; last_mirrored"| FL
  FL -->|"2 · commit_fill_log (ER→L1)<br/>cheap · own 10-commit budget"| FL
  FL -->|"3 · settle_from_log (L1)<br/>read-only · skip orphans"| L1

  FL -.->|"budget near 10?<br/>bump epoch → fresh PDA"| FL2["FillLog epoch+1<br/>fresh budget of 10"]
```

Two independent progress cursors prevent double-processing:

```mermaid
flowchart TB
  A["OrderBook fill.sequence"] --> B["FillLog.last_mirrored_sequence<br/>(how far MIRRORING got · ER)"]
  A --> C["Market.last_settled_sequence<br/>(how far SETTLEMENT got · L1)<br/>stored in spare padding as u32"]
```

---

## 0.6 Delegation state machine (Mermaid)

```mermaid
stateDiagram-v2
  [*] --> L1Owned: account created on L1
  L1Owned --> Delegated: delegate (authority → ER)
  Delegated --> Delegated: commit (snapshot to L1,<br/>stays delegated · max 10×/account)
  Delegated --> L1Owned: undelegate (authority → L1)

  note right of Delegated
    OrderBook: delegated ONCE, forever.
    Never committed, never undelegated
    (612KB ≫ 10,240B CPI growth cap).
    FillLog: committed up to 10×, then
    a fresh epoch PDA is minted.
  end note
```

---

## 0.7 Margin flow — one dollar's journey (Mermaid)

```mermaid
flowchart LR
  WAL["Wallet USDC"] -->|deposit| FC["UserAccount.free_collateral<br/>(L1)"]
  FC -->|fund_trading_credit| CR["TradingCredit.credit<br/>(delegated)"]
  CR -->|place_order reserves| CM["committed<br/>(slot.margin_reserved)"]
  CM -->|fill drains margin| FM["FillEvent.filled_margin"]
  FM -->|settle_from_log| PC["Position.collateral<br/>(L1)"]
  PC -->|close / realize PnL| FC
  FC -->|withdraw| WAL
```

`available = credit − committed`. Makers' stale `committed` is repaired by
`reconcile_credit` on their next action.

---

## 0.8 On-chain state map (Mermaid ER diagram)

```mermaid
erDiagram
  GLOBALSTATE ||--o{ MARKET : governs
  MARKET ||--|| ORDERBOOK : "1:1 per market"
  MARKET ||--o{ POSITION : tracks
  USERACCOUNT ||--o{ TRADINGCREDIT : "per market"
  USERACCOUNT ||--o{ POSITION : owns
  ORDERBOOK ||--o{ FILLEVENT : emits
  MARKET ||--o{ FILLLOG : "epoch-keyed"

  MARKET {
    u8  max_leverage
    u64 funding_interval_secs
    i128 cumulative_funding_index
    u64 open_interest_long
    u64 open_interest_short
    u64[225] twap_prices
    u32 last_settled_sequence
  }
  ORDERBOOK {
    u16 max_order_slots_2048
    u16 max_price_levels_512
    u16 max_fill_events_4096
    ring fill_event_queue
  }
  TRADINGCREDIT {
    u64 credit
    u64 committed
    pubkey session_authority
    i64 session_expiry
  }
  POSITION {
    i64 size
    u64 entry_price
    u64 collateral
    i64 realized_pnl
  }
  FILLLOG {
    u32 epoch
    u16 capacity_80
    u64 last_mirrored_sequence
  }
```

---

## 0.9 Instruction map (0x00–0x27)

```mermaid
flowchart TB
  subgraph ADMIN["Admin / lifecycle (L1)"]
    A0["0x00 initialize_market"]
    A1["0x0C initialize_global"]
    A2["0x17 grow_orderbook"]
    A3["0x18 delegate_orderbook_prepare"]
    A4["0x09 delegate_orderbook"]
    A5["0x25 set_market_oracle"]
    A6["0x26 propose_authority · 0x27 accept_authority<br/>(two-step GlobalState.authority rotation)"]
  end
  subgraph USER["User lifecycle (L1)"]
    U0["0x01 initialize_user"]
    U1["0x02 deposit_collateral"]
    U2["0x19 initialize_position"]
    U3["0x0D init_trading_credit"]
    U4["0x0E fund_trading_credit"]
    U5["0x0F delegate_trading_credit"]
    U6["0x1B authorize_session"]
    U7["0x03 withdraw · 0x08 close"]
  end
  subgraph TRADE["Trading (ER)"]
    T0["0x10 place_order"]
    T1["0x11 cancel_order"]
  end
  subgraph TRIGGERS["SL/TP triggers"]
    G0["0x22 place_trigger (L1)"]
    G1["0x23 cancel_trigger (L1)"]
    G2["0x24 execute_trigger (L1, keeper-cranked)"]
  end
  subgraph SETTLE["Settlement / cranks"]
    S0["0x1F mirror_fills (ER)"]
    S1["0x20 commit_fill_log (ER)"]
    S2["0x21 settle_from_log (L1)"]
    S3["0x06 compute_funding (L1)"]
    S4["0x05 liquidate_position (L1)"]
    S5["0x0B crank_twap (L1)"]
  end

  ADMIN --> USER --> TRADE --> TRIGGERS --> SETTLE
```

---

## 0.10 Deployment topology (Mermaid)

```mermaid
flowchart TB
  subgraph CF["Cloudflare"]
    DNS["slipstream.ansht.tech<br/>HTTPS edge"]
  end
  subgraph EC2["AWS EC2 (Amazon Linux 2023)"]
    NG["nginx :80<br/>reverse proxy"]
    subgraph PM2["pm2"]
      FE["Next.js :3000"]
      KP["keepers: fill-log · funding<br/>liquidation · twap · expiry"]
    end
    KEY["operator key<br/>~/.config/solana/id.json"]
  end
  subgraph CHAIN["Solana devnet"]
    PROG["Program 7qujf…bVwz"]
    MB["MagicBlock ER<br/>devnet.magicblock.app"]
  end
  HELIUS["Helius devnet RPC"]

  DNS --> NG --> FE
  FE -->|/api/rpc/base| HELIUS --> PROG
  FE -->|/api/rpc/er| MB
  FE -->|/api/faucet uses| KEY
  KP --> HELIUS
  KP --> MB
  KP -. signs with .-> KEY
```

---

## 0.11 Where to go next

- Prose walkthrough → [doc 1](./01-architecture-overview.md)
- How the 612 KB PDA works → [doc 2](./02-orderbook-and-pda-storage.md)
- ER / delegation / commit cap → [doc 3](./03-ephemeral-rollups-and-delegation.md)
- The fill-log pipeline in depth → [doc 4](./04-settlement-and-the-fill-log.md)
