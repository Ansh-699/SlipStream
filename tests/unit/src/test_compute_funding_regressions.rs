//! Mollusk regression test for compute_funding's interval-scaling fix.
//!
//! Before this fix, compute_funding always credited exactly ONE interval's
//! funding_rate no matter how much time had actually elapsed since
//! last_funding_ts, and reset the timestamp to `now`. A keeper outage (or
//! simply nobody calling it for a while, since it's permissionless) meant
//! every interval beyond the first was silently never accrued.
#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::math::funding::INTEREST_RATE_PER_INTERVAL;
use slipstream::state::*;

const PRICE_SCALE: u64 = 1_000_000;
const NOW: i64 = 1_700_000_000;
const INTERVAL_SECS: i64 = 3_600;

fn mollusk(program_id: &Pubkey) -> Mollusk {
    std::env::set_var(
        "SBF_OUT_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy"),
    );
    let mut m = Mollusk::new(program_id, "slipstream");
    m.sysvars.clock.unix_timestamp = NOW;
    m
}

fn program_account(program_id: &Pubkey, data: &[u8]) -> Account {
    Account {
        lamports: 10_000_000,
        data: data.to_vec(),
        owner: *program_id,
        executable: false,
        rent_epoch: 0,
    }
}

/// Legacy Pyth V2 aggregate account (see oracle::parse_pyth), fresh at NOW.
fn pyth_account(price: i64) -> Account {
    let mut data = vec![0u8; 248];
    data[20..24].copy_from_slice(&(-6i32).to_le_bytes()); // exponent
    data[96..104].copy_from_slice(&NOW.to_le_bytes());
    data[208..216].copy_from_slice(&price.to_le_bytes());
    data[224..228].copy_from_slice(&1u32.to_le_bytes()); // status = Trading
    Account {
        lamports: 10_000_000,
        data,
        owner: Pubkey::new_unique(),
        executable: false,
        rent_epoch: 0,
    }
}

/// Too short to parse as Switchboard => "unavailable", triggering the
/// documented DEVNET Pyth-only fallback (agreement=true, single_oracle=true).
fn unavailable_switchboard_account() -> Account {
    Account {
        lamports: 10_000_000,
        data: vec![0u8; 8],
        owner: Pubkey::new_unique(),
        executable: false,
        rent_epoch: 0,
    }
}

fn compute_funding_ix(program_id: &Pubkey, market: Pubkey, pyth: Pubkey, sb: Pubkey) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(market, false),
            AccountMeta::new_readonly(pyth, false),
            AccountMeta::new_readonly(sb, false),
        ],
        data: vec![0x06u8],
    }
}

/// 3 whole intervals have elapsed since last_funding_ts. With mark == index
/// (zero premium), each interval accrues exactly INTEREST_RATE_PER_INTERVAL;
/// the fix must credit 3x that, and advance last_funding_ts by 3 whole
/// intervals (not reset to `now`, and not silently stay at 1x).
#[test]
fn test_compute_funding_accrues_all_missed_intervals() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);

    let (market_pk, _) =
        Pubkey::find_program_address(&[SEED_MARKET, &0u16.to_le_bytes()], &program_id);
    let pyth_pk = Pubkey::new_unique();
    let sb_pk = Pubkey::new_unique();

    let price = 150 * PRICE_SCALE;
    let last_funding_ts = NOW - 3 * INTERVAL_SECS;

    let mut mkt = Market::zeroed();
    mkt.discriminator = DISC_MARKET;
    mkt.market_index = 0;
    mkt.pyth_feed = pyth_pk.to_bytes();
    mkt.switchboard_feed = sb_pk.to_bytes();
    mkt.funding_interval_secs = INTERVAL_SECS as u64;
    mkt.last_funding_ts = last_funding_ts;
    mkt.twap_count = 1;
    mkt.twap_prices[0] = price; // mark == index -> zero premium, isolates interval scaling

    let accounts = vec![
        (market_pk, program_account(&program_id, bytemuck::bytes_of(&mkt))),
        (pyth_pk, pyth_account(price as i64)),
        (sb_pk, unavailable_switchboard_account()),
    ];

    let ix = compute_funding_ix(&program_id, market_pk, pyth_pk, sb_pk);
    let res = m.process_instruction(&ix, &accounts);
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);

    let updated: &Market = bytemuck::from_bytes(&res.resulting_accounts[0].1.data[..Market::LEN]);
    assert_eq!(
        updated.get_cumulative_funding_index(),
        3 * INTEREST_RATE_PER_INTERVAL,
        "all 3 missed intervals must be credited, not just 1"
    );
    assert_eq!(
        updated.last_funding_ts, NOW,
        "last_funding_ts must advance by whole intervals (3 * INTERVAL_SECS from its start)"
    );
}
