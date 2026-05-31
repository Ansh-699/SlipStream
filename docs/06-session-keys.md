# 6 · Session Keys

> "Instead of a session, there's a key signing all my transactions — isn't that
> wrong?" No — that key *is* the session. This doc explains the sign-once-trade-
> many model, exactly how it's scoped and bounded, and why it's safe.

---

## 6.1 The problem session keys solve

Trading in the ER means signing **a lot** of transactions — every order, every
cancel, a market maker quoting ~once a second. If each one popped a wallet
approval dialog, high-frequency trading from a browser would be unusable. And
pasting your *main* wallet's private key into a webpage to auto-sign would be
reckless: that key controls all your funds.

**Session keys** square this circle: you approve **once**, which authorizes a
fresh, disposable key to sign trading actions **on your behalf**, but only within
strict limits. This is the standard "sign-once-trade-many" pattern.

---

## 6.2 How it works in Slipstream

The mechanism lives on the **`TradingCredit`** account (`state/trading_credit.rs`).
Two fields implement it:

```rust
pub session_authority: [u8; 32],  // the authorized session pubkey (all-zero = none)
pub session_expiry:    i64,       // unix secs; key rejected once now >= this
```

The lifecycle:

1. **Authorize (one signature).** The owner calls `authorize_session` (`0x1B`),
   signing **once** with their real wallet. This stamps a `session_authority`
   pubkey (a fresh keypair generated in the browser) and a `session_expiry`
   timestamp onto their `TradingCredit`.
2. **Trade (many, no prompts).** The browser's session key signs `place_order`
   and `cancel_order` directly against the ER — no wallet dialog per action. The
   program checks authorization via `is_authorized_signer`.
3. **Expire / revoke.** Once `now >= session_expiry`, the key is automatically
   rejected. The owner can also overwrite or clear it.

The authorization check (`TradingCredit::is_authorized_signer`):

```rust
fn is_authorized_signer(&self, signer, now) -> bool {
    if signer == &self.owner { return true; }            // owner always allowed
    let active = self.session_authority != [0u8;32]      // a session exists
                 && now < self.session_expiry;           // and hasn't expired
    active && signer == &self.session_authority           // and it's THE session key
}
```

---

## 6.3 Why it's safe (the three bounds)

The session key is powerful enough to trade and nothing more. Three independent
limits contain it:

1. **Scoped to one TradingCredit.** The key is authorized on a *specific*
   `TradingCredit` for a *specific market*. A `TradingCredit` holds only the
   margin you allocated to that market — **not** your `free_collateral`, not your
   positions, not the vault. Worst case, a leaked session key can only churn
   orders within that one credit's already-committed margin.

2. **Expiring.** `session_expiry` is a hard wall. After it passes the key is dead;
   no cleanup required for it to stop working.

3. **Signer-only, never owner.** This is the subtle, important part, and it
   directly answers *"isn't that key just acting as me?"* — **No.** The session
   key may *sign*, but **order and position attribution always stays with
   `owner`.** `place_order`, `cancel_order`, and `reconcile_credit` all attribute
   to `credit.owner`, never to the signer. The session key cannot create
   positions owned by itself, cannot redirect funds to itself, cannot withdraw.
   It is an authorized *signer*, not a co-owner.

> The comments in `trading_credit.rs` state this explicitly: *"authorization is
> about who may SIGN — the order/position is always attributed to `owner`, never
> to the session key."*

So the answer to the user's question — *"there's a key signing all my
transactions, isn't that instead of a session?"* — is that **this is exactly what
a session key is**: a temporary, scoped, expiring signer that acts for you within
walls, so you don't sign every trade by hand and never expose your real wallet.

---

## 6.4 What a leaked session key can and can't do

| Action | Possible with a leaked session key? |
|---|---|
| Place/cancel orders within the scoped TradingCredit | Yes (until expiry) |
| Move funds to the attacker | **No** — actions attribute to `owner`; no withdraw authority |
| Touch your `free_collateral` | **No** — that's L1, never in scope |
| Touch your open `Position`s | **No** — positions are owner-attributed L1 state |
| Drain another market's credit | **No** — scoped to one TradingCredit |
| Act after expiry | **No** — rejected once `now >= session_expiry` |

The blast radius is "annoying order churn inside one market's pre-committed
margin," bounded in time. Compare that to handing over your main wallet key
(total loss). That gap is the whole value of the pattern.

---

## 6.5 Frontend integration

The browser generates the session keypair, prompts the wallet **once** to sign
`authorize_session`, then keeps the session key in memory to auto-sign ER orders.
Confirmation uses HTTP polling of signature status (`lib/confirm.ts`,
`confirmSignature`) rather than a websocket subscription — the order-placement
flow and `use-session` hook were switched to this because the web3.js
`confirmTransaction` websocket path hung against the RPC proxy.

---

## 6.6 Takeaways

- A **session key** = approve once, then a disposable browser key auto-signs
  trades — no per-order wallet prompts, no exposing your real key.
- Implemented as `session_authority` + `session_expiry` on `TradingCredit`,
  authorized by `authorize_session` (`0x1B`), checked by `is_authorized_signer`.
- Safe because it's **scoped** (one credit/market, only committed margin),
  **expiring**, and **signer-only** (everything attributes to `owner`, never the
  key).
- The key *is* the session — it isn't a replacement for one.
