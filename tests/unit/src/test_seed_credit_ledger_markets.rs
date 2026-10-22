//! Round 11 — `seed_credit_ledger` across markets (remediate review F4).
//!
//! The credit ledger is one number per user, raised by `fund_trading_credit` on
//! every market; a TradingCredit is per (user, market). Seeding the ledger from
//! one market's credit overwrote every other market's share. These tests pin
//! that the seed is the sum over every market, each bounded by the authority's
//! stated amount, and that no market can be left out.
#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;

use slipstream::error::SlipstreamError;
use slipstream::state::*;

const IX_SEED_CREDIT_LEDGER: u8 = 0x28;

fn mollusk(program_id: &Pubkey) -> Mollusk {
    std::env::set_var(
        "SBF_OUT_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy"),
    );
    Mollusk::new(program_id, "slipstream")
}

fn pa(program_id: &Pubkey, data: Vec<u8>) -> Account {
    Account {
        lamports: 10_000_000,
        data,
        owner: *program_id,
        executable: false,
        rent_epoch: 0,
    }
}

struct Fx {
    program_id: Pubkey,
    authority: Pubkey,
    owner: Pubkey,
    global_pk: Pubkey,
    user_pk: Pubkey,
}

impl Fx {
    fn new() -> Self {
        let program_id = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        Self {
            global_pk: Pubkey::find_program_address(&[SEED_GLOBAL], &program_id).0,
            user_pk: Pubkey::find_program_address(&[SEED_USER, owner.as_ref()], &program_id).0,
            program_id,
            authority: Pubkey::new_unique(),
            owner,
        }
    }

    fn credit_pk(&self, market: u16) -> Pubkey {
        Pubkey::find_program_address(
            &[SEED_CREDIT, self.owner.as_ref(), &market.to_le_bytes()],
            &self.program_id,
        )
        .0
    }

    fn credit(&self, market: u16, amount: u64) -> Account {
        let mut c = TradingCredit::zeroed();
        c.discriminator = DISC_TRADING_CREDIT;
        c.owner = self.owner.to_bytes();
        c.market_index = market;
        c.credit = amount;
        pa(&self.program_id, bytemuck::bytes_of(&c).to_vec())
    }

    /// GlobalState with `market_count`, the user with `ledger`, and the given
    /// credit accounts (in market order) at their canonical PDAs.
    fn accounts(
        &self,
        market_count: u16,
        ledger: u64,
        credits: Vec<Account>,
    ) -> Vec<(Pubkey, Account)> {
        let mut g = GlobalState::zeroed();
        g.discriminator = DISC_GLOBAL_STATE;
        g.market_count = market_count;
        g.authority = self.authority.to_bytes();

        let mut u = UserAccount::zeroed();
        u.discriminator = DISC_USER_ACCOUNT;
        u.owner = self.owner.to_bytes();
        u.reserved_margin = ledger;

        let mut out = vec![
            (
                self.global_pk,
                pa(&self.program_id, bytemuck::bytes_of(&g).to_vec()),
            ),
            (
                self.user_pk,
                pa(&self.program_id, bytemuck::bytes_of(&u).to_vec()),
            ),
            (self.authority, Account::default()),
        ];
        for (i, c) in credits.into_iter().enumerate() {
            out.push((self.credit_pk(i as u16), c));
        }
        out
    }

    /// Market 0's credit at [2], authority at [3], markets 1.. after it.
    fn ix(&self, credit_keys: &[Pubkey], amounts: &[u64]) -> Instruction {
        let mut data = vec![IX_SEED_CREDIT_LEDGER];
        for a in amounts {
            data.extend_from_slice(&a.to_le_bytes());
        }
        let mut metas = vec![
            AccountMeta::new_readonly(self.global_pk, false),
            AccountMeta::new(self.user_pk, false),
            AccountMeta::new_readonly(credit_keys[0], false),
            AccountMeta::new_readonly(self.authority, true),
        ];
        metas.extend(
            credit_keys[1..]
                .iter()
                .map(|k| AccountMeta::new_readonly(*k, false)),
        );
        Instruction {
            program_id: self.program_id,
            accounts: metas,
            data,
        }
    }
}

fn ledger(accounts: &[(Pubkey, Account)], fx: &Fx) -> u64 {
    let acc = &accounts.iter().find(|(k, _)| *k == fx.user_pk).unwrap().1;
    let u: &UserAccount = bytemuck::from_bytes(&acc.data[..UserAccount::LEN]);
    u.reserved_margin
}

/// THE F4 CASE. 100 USDC parked on market 0 and 50 on market 1: the ledger
/// must seed to 150. Seeding from market 0 alone wrote 100 and wiped market 1's
/// share, locking it behind withdraw_trading_credit's ceiling.
#[test]
fn test_seed_sums_every_market() {
    let fx = Fx::new();
    let m = mollusk(&fx.program_id);
    let accounts = fx.accounts(
        2,
        0,
        vec![fx.credit(0, 100_000_000), fx.credit(1, 50_000_000)],
    );

    let ix = fx.ix(
        &[fx.credit_pk(0), fx.credit_pk(1)],
        &[100_000_000, 50_000_000],
    );
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "{:?}",
        res.program_result
    );
    assert_eq!(ledger(&res.resulting_accounts, &fx), 150_000_000);
}

/// Each market stays bounded by the authority's amount AND by the credit.
#[test]
fn test_seed_bounds_each_market_separately() {
    let fx = Fx::new();
    let m = mollusk(&fx.program_id);
    const ER_CLAIM: u64 = 7_017_392_213_830_636_841;
    let accounts = fx.accounts(2, 0, vec![fx.credit(0, ER_CLAIM), fx.credit(1, 20_000_000)]);

    let ix = fx.ix(
        &[fx.credit_pk(0), fx.credit_pk(1)],
        &[500_000_000, 999_000_000],
    );
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "{:?}",
        res.program_result
    );
    assert_eq!(
        ledger(&res.resulting_accounts, &fx),
        500_000_000 + 20_000_000
    );
}

/// A market where the user never created a credit contributes zero — at its
/// canonical PDA, so it is accounted for rather than skipped.
#[test]
fn test_seed_counts_a_never_created_credit_as_zero() {
    let fx = Fx::new();
    let m = mollusk(&fx.program_id);
    let accounts = fx.accounts(2, 0, vec![fx.credit(0, 40_000_000), Account::default()]);

    let ix = fx.ix(
        &[fx.credit_pk(0), fx.credit_pk(1)],
        &[40_000_000, 10_000_000],
    );
    let res = m.process_instruction(&ix, &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "{:?}",
        res.program_result
    );
    assert_eq!(ledger(&res.resulting_accounts, &fx), 40_000_000);
}

/// Every market must be accounted for: the one-market form is refused once a
/// second market exists, and nothing is written.
#[test]
fn test_seed_refuses_to_leave_a_market_out() {
    let fx = Fx::new();
    let m = mollusk(&fx.program_id);
    let accounts = fx.accounts(
        2,
        7,
        vec![fx.credit(0, 100_000_000), fx.credit(1, 50_000_000)],
    );

    let res = m.process_instruction(&fx.ix(&[fx.credit_pk(0)], &[100_000_000]), &accounts);
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(ProgramError::InvalidInstructionData),
        "one amount for two markets"
    );
    assert_eq!(ledger(&res.resulting_accounts, &fx), 7);

    let res = m.process_instruction(
        &fx.ix(&[fx.credit_pk(0)], &[100_000_000, 50_000_000]),
        &accounts,
    );
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(ProgramError::NotEnoughAccountKeys),
        "two amounts, one credit"
    );
    assert_eq!(ledger(&res.resulting_accounts, &fx), 7);
}

/// A credit must be read at its canonical PDA, and a delegated one is refused.
#[test]
fn test_seed_refuses_non_canonical_and_delegated_credits() {
    let fx = Fx::new();
    let m = mollusk(&fx.program_id);

    let decoy = Pubkey::new_unique();
    let mut accounts = fx.accounts(2, 0, vec![fx.credit(0, 1), fx.credit(1, 1)]);
    let mut forged = fx.credit(1, 1);
    forged.data[2..4].copy_from_slice(&1u16.to_le_bytes());
    accounts.push((decoy, forged));
    let res = m.process_instruction(&fx.ix(&[fx.credit_pk(0), decoy], &[1, 1]), &accounts);
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(ProgramError::Custom(SlipstreamError::InvalidPda as u32))
    );

    let mut delegated = fx.credit(1, 1);
    delegated.owner = Pubkey::new_unique(); // the delegation program, say
    let accounts = fx.accounts(2, 0, vec![fx.credit(0, 1), delegated]);
    let res = m.process_instruction(
        &fx.ix(&[fx.credit_pk(0), fx.credit_pk(1)], &[1, 1]),
        &accounts,
    );
    assert_eq!(
        res.program_result,
        MolluskResult::Failure(ProgramError::Custom(
            SlipstreamError::CreditStillActive as u32
        ))
    );
}
