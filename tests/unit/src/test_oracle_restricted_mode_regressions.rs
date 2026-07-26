//! Mollusk regression test for the dual-oracle restricted_mode persistence fix.
//!
//! Before this fix, `apply_dual_oracle` mutated `Market.restricted_mode` /
//! `agreement_streak` and then returned `Err(OracleDisagreement)` /
//! `Err(RestrictedMode)` in the SAME call. Solana rolls back every account
//! write made by an instruction that returns an error, so those mutations
//! never actually landed on-chain: the dual-oracle circuit breaker could
//! never engage, no matter how badly the two oracles diverged.
#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::state::*;

const PRICE_SCALE: u64 = 1_000_000;
const NOW: i64 = 1_700_000_000;

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

/// Legacy Pyth V2 aggregate account (see oracle::parse_pyth).
fn pyth_account(price: i64, publish_time: i64) -> Account {
    let mut data = vec![0u8; 248];
    data[20..24].copy_from_slice(&(-6i32).to_le_bytes()); // exponent
    data[96..104].copy_from_slice(&publish_time.to_le_bytes());
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

/// Switchboard On-Demand PullFeedAccountData (see oracle::parse_switchboard).
fn switchboard_account(price_6dp: u64, publish_ts: i64) -> Account {
    let mut data = vec![0u8; 104];
    let value: i128 = (price_6dp as i128) * 1_000_000_000_000i128; // 18-decimal
    let lo = value as u64;
    let hi = (value >> 64) as i64;
    data[80..88].copy_from_slice(&lo.to_le_bytes());
    data[88..96].copy_from_slice(&hi.to_le_bytes());
    data[96..104].copy_from_slice(&publish_ts.to_le_bytes());
    Account {
        lamports: 10_000_000,
        data,
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

/// Pyth and Switchboard disagree by far more than MAX_DIVERGENCE_BPS (2%):
/// compute_funding must still SUCCEED (not revert), must persist
/// `restricted_mode = 1`, and must NOT accrue any funding this call.
#[test]
fn test_oracle_disagreement_persists_restricted_mode_instead_of_reverting() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);

    let (market_pk, _) =
        Pubkey::find_program_address(&[SEED_MARKET, &0u16.to_le_bytes()], &program_id);
    let pyth_pk = Pubkey::new_unique();
    let sb_pk = Pubkey::new_unique();

    let old_funding_ts = NOW - 1000;
    let mut mkt = Market::zeroed();
    mkt.discriminator = DISC_MARKET;
    mkt.market_index = 0;
    mkt.pyth_feed = pyth_pk.to_bytes();
    mkt.switchboard_feed = sb_pk.to_bytes();
    mkt.funding_interval_secs = 1;
    mkt.last_funding_ts = old_funding_ts;
    mkt.twap_count = 1;
    mkt.twap_prices[0] = 150 * PRICE_SCALE;
    mkt.restricted_mode = 0;
    mkt.agreement_streak = 0;

    // 150 vs 200 diverges by ~33% >> the 2% (200 bps) tolerance.
    let pyth_acc = pyth_account((150 * PRICE_SCALE) as i64, NOW);
    let sb_acc = switchboard_account(200 * PRICE_SCALE, NOW);

    let accounts = vec![
        (market_pk, program_account(&program_id, bytemuck::bytes_of(&mkt))),
        (pyth_pk, pyth_acc),
        (sb_pk, sb_acc),
    ];

    let ix = compute_funding_ix(&program_id, market_pk, pyth_pk, sb_pk);
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "compute_funding must succeed (skip, not revert) on oracle disagreement so the \
         restricted_mode flag it just set actually commits: {:?}",
        res.program_result
    );

    let updated: &Market = bytemuck::from_bytes(&res.resulting_accounts[0].1.data[..Market::LEN]);
    assert_eq!(
        updated.restricted_mode, 1,
        "restricted_mode must persist on-chain after a genuine oracle disagreement"
    );
    assert_eq!(
        updated.last_funding_ts, old_funding_ts,
        "funding must NOT be accrued using a disagreeing price"
    );
    assert_eq!(
        updated.get_cumulative_funding_index(),
        0,
        "cumulative funding index must be untouched when the call skips accrual"
    );
}
