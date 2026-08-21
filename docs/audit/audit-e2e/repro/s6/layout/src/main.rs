// S6 audit scratch. Dumps the REAL #[repr(C)] size/align/field-offsets of every
// on-chain struct, straight from the program crate, as JSON. Never wired into any
// test suite; read-only over program source.
//
//   CARGO_TARGET_DIR=/tmp/s6-layout cargo run --quiet --manifest-path \
//     docs/audit/audit-e2e/repro/s6/layout/Cargo.toml > docs/audit/audit-e2e/repro/s6/rust-layout.json

use core::mem::{align_of, offset_of, size_of};
use slipstream::state::*;

macro_rules! dump {
    ($out:expr, $ty:ty, $($f:ident),+ $(,)?) => {{
        let mut fields = Vec::new();
        $( fields.push(format!("      \"{}\": {}", stringify!($f), offset_of!($ty, $f))); )+
        $out.push(format!(
            "  \"{}\": {{\n    \"size\": {},\n    \"align\": {},\n    \"fields\": {{\n{}\n    }}\n  }}",
            stringify!($ty),
            size_of::<$ty>(),
            align_of::<$ty>(),
            fields.join(",\n")
        ));
    }};
}

fn main() {
    let mut out: Vec<String> = Vec::new();

    dump!(out, GlobalState, discriminator, bump, market_count, paused, _padding1,
          authority, treasury, insurance_vault);

    dump!(out, Market, discriminator, bump, market_index, max_leverage,
          circuit_breaker_active, taker_fee_bps, maker_rebate_bps, twap_write_index,
          twap_count, _padding1, base_mint, quote_mint, pyth_feed, quote_vault,
          tick_size, lot_size, funding_interval_secs, last_funding_ts,
          open_interest_long, open_interest_short, insurance_fund_balance,
          last_mark_price, cumulative_funding_index_lo, cumulative_funding_index_hi,
          twap_prices, switchboard_feed, restricted_mode, agreement_streak, _padding2);

    dump!(out, UserAccount, discriminator, bump, pending_fills, _padding1, owner,
          free_collateral, reserved_margin);

    dump!(out, Position, discriminator, bump, market_index, _padding1, owner, size,
          entry_price, collateral, realized_pnl, open_slot,
          funding_index_snapshot_lo, funding_index_snapshot_hi);

    dump!(out, TradingCredit, discriminator, bump, market_index, active_orders,
          _padding, owner, credit, committed, session_authority, session_expiry);

    dump!(out, LiquidationIntent, discriminator, bump, _padding, position,
          created_ts, deadline_ts, initial_health_factor);

    dump!(out, TriggerOrder, discriminator, bump, kind, trigger_above, market_index,
          _padding, owner, trigger_price, created_ts);

    dump!(out, OrderBookHeader, discriminator, bump, market_index, orders_per_user,
          _pad1, max_order_slots, max_price_levels_per_side, max_fill_events,
          active_order_count, bid_level_count, ask_level_count, fill_event_head,
          fill_event_tail, fill_event_count, free_list_head, free_slot_count, _pad2,
          next_order_id, next_fill_sequence);

    dump!(out, OrderSlot, active, side, order_type, _pad1, next_at_level,
          prev_at_level, order_id, owner, price, size, remaining_size, expiry_ts,
          margin_reserved);

    dump!(out, PriceLevel, price, head_slot, tail_slot, order_count, _pad);

    dump!(out, FillEvent, sequence, maker, taker, price, quantity, filled_margin,
          taker_fee_bps_snapshot, maker_rebate_bps_snapshot, maker_side, _pad);

    dump!(out, FillLogHeader, discriminator, bump, market_index, epoch, capacity,
          count, head, _pad, last_mirrored_sequence);

    println!("{{");
    println!("{}", out.join(",\n"));
    println!(",");
    // Derived sizes the TS side also hard-codes.
    println!("  \"_derived\": {{");
    println!("    \"TWAP_BUFFER_SIZE\": {},", TWAP_BUFFER_SIZE);
    println!("    \"FILL_LOG_CAPACITY\": {},", FILL_LOG_CAPACITY);
    println!("    \"SENTINEL\": {},", SENTINEL);
    println!("    \"fill_log_account_size(FILL_LOG_CAPACITY)\": {},",
             fill_log_account_size(FILL_LOG_CAPACITY));
    println!("    \"OrderBookHeader::default_account_size()\": {},",
             OrderBookHeader::default_account_size());
    println!("    \"DEFAULT_MAX_ORDER_SLOTS\": {},", DEFAULT_MAX_ORDER_SLOTS);
    println!("    \"DEFAULT_MAX_PRICE_LEVELS\": {},", DEFAULT_MAX_PRICE_LEVELS);
    println!("    \"DEFAULT_MAX_FILL_EVENTS\": {}", DEFAULT_MAX_FILL_EVENTS);
    println!("  }},");
    println!("  \"_disc\": {{");
    println!("    \"DISC_GLOBAL_STATE\": {},", DISC_GLOBAL_STATE);
    println!("    \"DISC_MARKET\": {},", DISC_MARKET);
    println!("    \"DISC_USER_ACCOUNT\": {},", DISC_USER_ACCOUNT);
    println!("    \"DISC_POSITION\": {},", DISC_POSITION);
    println!("    \"DISC_ORDER_BOOK\": {},", DISC_ORDER_BOOK);
    println!("    \"DISC_TRADING_CREDIT\": {},", DISC_TRADING_CREDIT);
    println!("    \"DISC_LIQUIDATION_INTENT\": {},", DISC_LIQUIDATION_INTENT);
    println!("    \"DISC_FILL_LOG\": {},", DISC_FILL_LOG);
    println!("    \"DISC_TRIGGER_ORDER\": {}", DISC_TRIGGER_ORDER);
    println!("  }},");
    println!("  \"_seeds\": {{");
    for (name, bytes) in [
        ("SEED_GLOBAL", SEED_GLOBAL),
        ("SEED_MARKET", SEED_MARKET),
        ("SEED_USER", SEED_USER),
        ("SEED_POSITION", SEED_POSITION),
        ("SEED_ORDERBOOK", SEED_ORDERBOOK),
        ("SEED_VAULT_AUTHORITY", SEED_VAULT_AUTHORITY),
        ("SEED_CREDIT", SEED_CREDIT),
        ("SEED_LIQ_INTENT", SEED_LIQ_INTENT),
        ("SEED_FILL_LOG", SEED_FILL_LOG),
        ("SEED_TRIGGER", SEED_TRIGGER),
        ("SEED_DELEGATE_BUFFER", SEED_DELEGATE_BUFFER),
    ] {
        println!("    \"{}\": \"{}\",", name, core::str::from_utf8(bytes).unwrap());
    }
    println!("    \"_end\": null");
    println!("  }}");
    println!("}}");
}
