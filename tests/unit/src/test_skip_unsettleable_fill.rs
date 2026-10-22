//! Round 11 — `skip_unsettleable_fill` (remediate review F3).
//!
//! `settle_from_log` stops — without advancing the cursor — on a fill whose
//! maker or taker has no L1 account, and reverts on a fill that breaks the
//! margin bound. Either one blocks every fill behind it. These tests pin that
//! the authority can move the cursor past exactly that fill, only when the
//! program can prove it unsettleable, and never past a settleable one.
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

const IX_SETTLE_FROM_LOG: u8 = 0x21;
const IX_SKIP_UNSETTLEABLE_FILL: u8 = 0x2B;
const MARKET_INDEX: u16 = 0;
const EPOCH: u32 = 1;
const PRICE: u64 = 100_000_000;
const QTY: u64 = 100_000_000;
const MARGIN: u64 = QTY / 20;

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

fn custom(e: SlipstreamError) -> MolluskResult {
    MolluskResult::Failure(ProgramError::Custom(e as u32))
}

fn fill(sequence: u64, maker: &Pubkey, taker: &Pubkey, filled_margin: u64) -> FillEvent {
    let mut f = FillEvent::zeroed();
    f.sequence = sequence;
    f.maker = maker.to_bytes();
    f.taker = taker.to_bytes();
    f.price = PRICE;
    f.quantity = QTY;
    f.filled_margin = filled_margin;
    f.maker_side = SIDE_BID;
    f
}

fn fill_log(fills: &[FillEvent]) -> Vec<u8> {
    let mut d = vec![0u8; fill_log_account_size(FILL_LOG_CAPACITY)];
    {
        let h: &mut FillLogHeader = bytemuck::from_bytes_mut(&mut d[..FillLogHeader::LEN]);
        h.discriminator = DISC_FILL_LOG;
        h.bump = 255;
        h.market_index = MARKET_INDEX;
        h.epoch = EPOCH;
        h.capacity = FILL_LOG_CAPACITY;
        h.count = fills.len() as u16;
    }
    for (i, f) in fills.iter().enumerate() {
        let off = FillLogHeader::LEN + i * FillEvent::LEN;
        d[off..off + FillEvent::LEN].copy_from_slice(bytemuck::bytes_of(f));
    }
    d
}

struct Parties {
    program_id: Pubkey,
    authority: Pubkey,
    /// Has a UserAccount and a Position.
    live: Pubkey,
    /// Has neither: an old bot key that will never sign `initialize_user`.
    orphan: Pubkey,
}

impl Parties {
    fn new() -> Self {
        Self {
            program_id: Pubkey::new_unique(),
            authority: Pubkey::new_unique(),
            live: Pubkey::new_unique(),
            orphan: Pubkey::new_unique(),
        }
    }

    fn pda(&self, seeds: &[&[u8]]) -> Pubkey {
        Pubkey::find_program_address(seeds, &self.program_id).0
    }
    fn market_pk(&self) -> Pubkey {
        self.pda(&[SEED_MARKET, &MARKET_INDEX.to_le_bytes()])
    }
    fn fl_pk(&self) -> Pubkey {
        self.pda(&[
            SEED_FILL_LOG,
            &MARKET_INDEX.to_le_bytes(),
            &EPOCH.to_le_bytes(),
        ])
    }
    fn global_pk(&self) -> Pubkey {
        self.pda(&[SEED_GLOBAL])
    }
    fn user_pk(&self, who: &Pubkey) -> Pubkey {
        self.pda(&[SEED_USER, who.as_ref()])
    }
    fn pos_pk(&self, who: &Pubkey) -> Pubkey {
        self.pda(&[SEED_POSITION, who.as_ref(), &MARKET_INDEX.to_le_bytes()])
    }

    /// Market at `cursor`, the given log, and live accounts for `self.live`
    /// only. `self.orphan`'s PDAs are present but never created.
    fn accounts(&self, cursor: u64, log: Vec<u8>, live_pending: u16) -> Vec<(Pubkey, Account)> {
        let mut mk = Market::zeroed();
        mk.discriminator = DISC_MARKET;
        mk.bump = 255;
        mk.market_index = MARKET_INDEX;
        mk.max_leverage = 20;
        mk.tick_size = 1_000;
        mk.lot_size = 100_000_000;
        mk.funding_interval_secs = 3600;
        mk.last_mark_price = PRICE;
        mk.set_last_settled_sequence(cursor);

        let mut g = GlobalState::zeroed();
        g.discriminator = DISC_GLOBAL_STATE;
        g.market_count = 1;
        g.authority = self.authority.to_bytes();

        let mut u = UserAccount::zeroed();
        u.discriminator = DISC_USER_ACCOUNT;
        u.owner = self.live.to_bytes();
        u.free_collateral = 1_000_000_000;
        u.reserved_margin = 1_000_000_000;
        u.pending_fills = live_pending;

        let mut p = Position::zeroed();
        p.discriminator = DISC_POSITION;
        p.owner = self.live.to_bytes();
        p.market_index = MARKET_INDEX;

        vec![
            (
                self.market_pk(),
                pa(&self.program_id, bytemuck::bytes_of(&mk).to_vec()),
            ),
            (self.fl_pk(), pa(&self.program_id, log)),
            (
                self.global_pk(),
                pa(&self.program_id, bytemuck::bytes_of(&g).to_vec()),
            ),
            (self.authority, Account::default()),
            (
                self.user_pk(&self.live),
                pa(&self.program_id, bytemuck::bytes_of(&u).to_vec()),
            ),
            (
                self.pos_pk(&self.live),
                pa(&self.program_id, bytemuck::bytes_of(&p).to_vec()),
            ),
            (self.user_pk(&self.orphan), Account::default()),
            (self.pos_pk(&self.orphan), Account::default()),
        ]
    }

    fn skip_ix(
        &self,
        signer: &Pubkey,
        sequence: u64,
        maker: &Pubkey,
        taker: &Pubkey,
    ) -> Instruction {
        let mut data = vec![IX_SKIP_UNSETTLEABLE_FILL];
        data.extend_from_slice(&MARKET_INDEX.to_le_bytes());
        data.extend_from_slice(&EPOCH.to_le_bytes());
        data.extend_from_slice(&sequence.to_le_bytes());
        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(self.market_pk(), false),
                AccountMeta::new_readonly(self.fl_pk(), false),
                AccountMeta::new_readonly(self.global_pk(), false),
                AccountMeta::new_readonly(*signer, true),
                AccountMeta::new(self.user_pk(maker), false),
                AccountMeta::new(self.user_pk(taker), false),
                AccountMeta::new_readonly(self.pos_pk(maker), false),
                AccountMeta::new_readonly(self.pos_pk(taker), false),
            ],
            data,
        }
    }

    /// settle_from_log with every account that exists supplied.
    fn settle_ix(&self) -> Instruction {
        let mut data = vec![IX_SETTLE_FROM_LOG];
        data.extend_from_slice(&MARKET_INDEX.to_le_bytes());
        data.extend_from_slice(&EPOCH.to_le_bytes());
        data.extend_from_slice(&10u16.to_le_bytes());
        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(self.market_pk(), false),
                AccountMeta::new_readonly(self.fl_pk(), false),
                AccountMeta::new_readonly(self.global_pk(), false),
                AccountMeta::new(self.user_pk(&self.live), false),
                AccountMeta::new(self.pos_pk(&self.live), false),
            ],
            data,
        }
    }
}

fn find<'a>(accounts: &'a [(Pubkey, Account)], key: &Pubkey) -> &'a Account {
    &accounts.iter().find(|(k, _)| k == key).unwrap().1
}

fn cursor(accounts: &[(Pubkey, Account)], p: &Parties) -> u64 {
    let mk: &Market = bytemuck::from_bytes(&find(accounts, &p.market_pk()).data[..Market::LEN]);
    mk.last_settled_sequence()
}

fn pending(accounts: &[(Pubkey, Account)], p: &Parties) -> u16 {
    let u: &UserAccount =
        bytemuck::from_bytes(&find(accounts, &p.user_pk(&p.live)).data[..UserAccount::LEN]);
    u.pending_fills
}

/// The before-state, run against the same build: an orphan at `cursor + 1`
/// blocks a perfectly settleable fill behind it, and settlement cannot move.
#[test]
fn test_orphan_fill_blocks_settlement() {
    let p = Parties::new();
    let m = mollusk(&p.program_id);
    let log = fill_log(&[
        fill(1, &p.orphan, &p.live, MARGIN),
        fill(2, &p.live, &p.live, MARGIN),
    ]);
    let accounts = p.accounts(0, log, 3);
    let res = m.process_instruction(&p.settle_ix(), &accounts);
    assert_eq!(res.program_result, custom(SlipstreamError::FillQueueEmpty));
    assert_eq!(
        cursor(&res.resulting_accounts, &p),
        0,
        "settlement is stuck behind the orphan"
    );
}

/// The fix: the authority skips the orphan, and settlement then applies the
/// settleable fill behind it.
#[test]
fn test_authority_skips_orphan_and_settlement_resumes() {
    let p = Parties::new();
    let m = mollusk(&p.program_id);
    let log = fill_log(&[
        fill(1, &p.orphan, &p.live, MARGIN),
        fill(2, &p.live, &p.live, MARGIN),
    ]);
    // `live` carries one bump for fill 1 (taker side) and two for fill 2.
    let accounts = p.accounts(0, log, 3);

    let res = m.process_instruction(&p.skip_ix(&p.authority, 1, &p.orphan, &p.live), &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "{:?}",
        res.program_result
    );
    assert_eq!(
        cursor(&res.resulting_accounts, &p),
        1,
        "the cursor moves past exactly one fill"
    );
    assert_eq!(res.return_data.len(), 9);
    assert_eq!(
        res.return_data[0], 1,
        "reason 1: a required account does not exist"
    );
    assert_eq!(
        u64::from_le_bytes(res.return_data[1..9].try_into().unwrap()),
        1
    );
    assert_eq!(
        pending(&res.resulting_accounts, &p),
        2,
        "the live leg's pending-fill bump for the skipped fill must be released"
    );

    let res = m.process_instruction(&p.settle_ix(), &res.resulting_accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "{:?}",
        res.program_result
    );
    assert_eq!(
        cursor(&res.resulting_accounts, &p),
        2,
        "settlement resumes behind the skip"
    );
    assert_eq!(pending(&res.resulting_accounts, &p), 0);
}

/// Not even the authority can discard a fill settlement can still apply.
#[test]
fn test_skip_refuses_a_settleable_fill() {
    let p = Parties::new();
    let m = mollusk(&p.program_id);
    let log = fill_log(&[fill(1, &p.live, &p.live, MARGIN)]);
    let accounts = p.accounts(0, log, 2);

    let res = m.process_instruction(&p.skip_ix(&p.authority, 1, &p.live, &p.live), &accounts);
    assert_eq!(res.program_result, custom(SlipstreamError::FillSettleable));
    assert_eq!(cursor(&res.resulting_accounts, &p), 0);
    assert_eq!(pending(&res.resulting_accounts, &p), 2);
}

/// A fill settlement reverts on (margin above its own notional) is skippable
/// even when every account exists.
#[test]
fn test_skip_accepts_a_fill_that_breaks_the_margin_bound() {
    let p = Parties::new();
    let m = mollusk(&p.program_id);
    let notional = QTY * PRICE / 1_000_000_000;
    let log = fill_log(&[fill(1, &p.live, &p.live, notional + 1)]);
    let accounts = p.accounts(0, log, 2);

    let res = m.process_instruction(&p.settle_ix(), &accounts);
    assert_eq!(
        res.program_result,
        custom(SlipstreamError::FillMarginExceeded),
        "the before-state"
    );

    let res = m.process_instruction(&p.skip_ix(&p.authority, 1, &p.live, &p.live), &accounts);
    assert!(
        matches!(res.program_result, MolluskResult::Success),
        "{:?}",
        res.program_result
    );
    assert_eq!(
        res.return_data[0], 2,
        "reason 2: the fill itself is invalid"
    );
    assert_eq!(cursor(&res.resulting_accounts, &p), 1);
    assert_eq!(
        pending(&res.resulting_accounts, &p),
        0,
        "both legs land on the one account"
    );
}

#[test]
fn test_skip_refuses_non_authority() {
    let p = Parties::new();
    let m = mollusk(&p.program_id);
    let stranger = Pubkey::new_unique();
    let log = fill_log(&[fill(1, &p.orphan, &p.live, MARGIN)]);
    let mut accounts = p.accounts(0, log, 1);
    accounts.push((stranger, Account::default()));

    let res = m.process_instruction(&p.skip_ix(&stranger, 1, &p.orphan, &p.live), &accounts);
    assert_eq!(
        res.program_result,
        custom(SlipstreamError::InvalidAuthority)
    );
    assert_eq!(cursor(&res.resulting_accounts, &p), 0);
}

/// The caller must name the blocking sequence, and a gap is not skippable: a
/// missing sequence may still arrive in another epoch's log.
#[test]
fn test_skip_refuses_wrong_sequence_and_gaps() {
    let p = Parties::new();
    let m = mollusk(&p.program_id);

    let log = fill_log(&[
        fill(1, &p.orphan, &p.live, MARGIN),
        fill(2, &p.orphan, &p.live, MARGIN),
    ]);
    let accounts = p.accounts(0, log, 2);
    let res = m.process_instruction(&p.skip_ix(&p.authority, 2, &p.orphan, &p.live), &accounts);
    assert_eq!(
        res.program_result,
        custom(SlipstreamError::InvalidFillSequence),
        "skipping ahead"
    );

    let log = fill_log(&[fill(3, &p.orphan, &p.live, MARGIN)]);
    let accounts = p.accounts(1, log, 1);
    let res = m.process_instruction(&p.skip_ix(&p.authority, 2, &p.orphan, &p.live), &accounts);
    assert_eq!(
        res.program_result,
        custom(SlipstreamError::InvalidFillSequence),
        "a gap at 2"
    );
    assert_eq!(cursor(&res.resulting_accounts, &p), 1);
}

/// "Missing" is only provable at the canonical PDA. Passing some other empty
/// account in place of a real user's UserAccount must not prove it absent.
#[test]
fn test_skip_refuses_non_canonical_accounts() {
    let p = Parties::new();
    let m = mollusk(&p.program_id);
    let decoy = Pubkey::new_unique();
    let log = fill_log(&[fill(1, &p.live, &p.live, MARGIN)]);
    let mut accounts = p.accounts(0, log, 2);
    accounts.push((decoy, Account::default()));

    let mut ix = p.skip_ix(&p.authority, 1, &p.live, &p.live);
    ix.accounts[4] = AccountMeta::new(decoy, false);
    let res = m.process_instruction(&ix, &accounts);
    assert_eq!(res.program_result, custom(SlipstreamError::InvalidPda));
    assert_eq!(cursor(&res.resulting_accounts, &p), 0);
}
