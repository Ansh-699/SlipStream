//! Mollusk regression test proving the funding sign fix in close_position/do_close:
//! a LONG position, with the cumulative funding index having risen since its
//! snapshot (the ordinary state — the interest-rate floor alone guarantees this),
//! must LOSE collateral on close, not gain it.
//!
//! Before the fix, close_position ADDED funding_payment to the amount paid out to
//! the closer; compute_funding_payment's documented convention is that a positive
//! payment means the position PAYS, so a long paying funding was actually being
//! credited it — the inverse of the intended economics, and directly farmable
//! (pick whichever side the inverted rate currently pays, hold it, collect).
#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::state::*;

const PRICE_SCALE: u64 = 1_000_000;
const SOL: i64 = 1_000_000_000;
// Matches math::funding::INTEREST_RATE_PER_INTERVAL (1 bps in 18-dp fixed point).
// The interest-rate floor alone guarantees the cumulative index only ever rises,
// so this is the ordinary state of the world, not a contrived one.
const ONE_BPS_18DP: i128 = 100_000_000_000_000;

fn mollusk(program_id: &Pubkey) -> Mollusk {
    std::env::set_var(
        "SBF_OUT_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy"),
    );
    Mollusk::new(program_id, "slipstream")
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

#[test]
fn test_long_position_loses_collateral_when_funding_index_rises() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let owner = Pubkey::new_unique();

    let (market_pk, _) =
        Pubkey::find_program_address(&[SEED_MARKET, &0u16.to_le_bytes()], &program_id);
    let position_pk = Pubkey::new_unique();
    let user_pk = Pubkey::new_unique();

    let mark = 150 * PRICE_SCALE;

    let mut mkt = Market::zeroed();
    mkt.discriminator = DISC_MARKET;
    mkt.last_mark_price = mark;
    mkt.open_interest_long = SOL as u64;
    mkt.insurance_fund_balance = 1_000 * PRICE_SCALE;
    mkt.set_cumulative_funding_index(ONE_BPS_18DP); // index has risen since any snapshot of 0

    let mut pos = Position::zeroed();
    pos.discriminator = DISC_POSITION;
    pos.owner = owner.to_bytes();
    pos.size = SOL; // long 1 SOL
    pos.entry_price = mark; // entry == mark -> zero unrealized PnL, isolates funding
    pos.collateral = 1_000_000; // $1.00
                                 // funding_index_snapshot left at 0 (Position::zeroed() default)

    let mut usr = UserAccount::zeroed();
    usr.discriminator = DISC_USER_ACCOUNT;
    usr.owner = owner.to_bytes();
    usr.free_collateral = 0;

    let accounts = vec![
        (market_pk, program_account(&program_id, bytemuck::bytes_of(&mkt))),
        (position_pk, program_account(&program_id, bytemuck::bytes_of(&pos))),
        (user_pk, program_account(&program_id, bytemuck::bytes_of(&usr))),
        (owner, Account::default()),
    ];

    // close_position (0x08), full close (empty tail data).
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(market_pk, false),
            AccountMeta::new(position_pk, false),
            AccountMeta::new(user_pk, false),
            AccountMeta::new_readonly(owner, true),
        ],
        data: vec![0x08u8],
    };
    let res = m.process_instruction(&ix, &accounts);
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);

    let user: &UserAccount =
        bytemuck::from_bytes(&res.resulting_accounts[2].1.data[..UserAccount::LEN]);

    // notional = 1 SOL * $150 = $150 = 150_000_000 (6dp). payment = notional * 1bps
    // = 15_000. A long PAYS when the rate is positive, so the closer must receive
    // LESS than their full collateral, not more.
    let expected_funding_payment = 15_000u64;
    assert_eq!(
        user.free_collateral,
        1_000_000 - expected_funding_payment,
        "a long position must LOSE collateral to funding when the index rises, not gain it"
    );
}
