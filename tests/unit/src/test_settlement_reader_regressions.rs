//! R4 — settlement reader hardening (`S4-01`, `S4-06`, `S4-07`).
//!
//! Every fixture uses ONE party as both maker and taker, so a single
//! `UserAccount` + `Position` pair covers both legs of every fill. Settlement
//! has no self-trade check (that guard is in `place_order`), so this is a legal
//! input and it keeps the fixtures small enough to read.
#![cfg(test)]

use bytemuck::Zeroable;
use mollusk_svm::result::ProgramResult as MolluskResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};

use slipstream::state::*;

const IX_SETTLE_FROM_LOG: u8 = 0x21;
const MARKET_INDEX: u16 = 0;
const EPOCH: u32 = 1;
const PRICE: u64 = 100_000_000;
const QTY: u64 = 100_000_000;
const MAX_LEVERAGE: u8 = 20;

fn mollusk(program_id: &Pubkey) -> Mollusk {
    std::env::set_var(
        "SBF_OUT_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy"),
    );
    Mollusk::new(program_id, "slipstream")
}

fn pa(program_id: &Pubkey, data: Vec<u8>) -> Account {
    Account { lamports: 10_000_000, data, owner: *program_id, executable: false, rent_epoch: 0 }
}

fn market(last_settled: u32) -> Market {
    let mut mk = Market::zeroed();
    mk.discriminator = DISC_MARKET;
    mk.bump = 255;
    mk.market_index = MARKET_INDEX;
    mk.max_leverage = MAX_LEVERAGE;
    mk.tick_size = 1_000;
    mk.lot_size = 100_000_000;
    mk.funding_interval_secs = 3600;
    mk.last_mark_price = PRICE;
    mk.set_last_settled_sequence(last_settled as u64);
    mk
}

fn fill(sequence: u64, party: &Pubkey, filled_margin: u64) -> FillEvent {
    let mut f = FillEvent::zeroed();
    f.sequence = sequence;
    f.maker = party.to_bytes();
    f.taker = party.to_bytes();
    f.price = PRICE;
    f.quantity = QTY;
    f.filled_margin = filled_margin;
    f.maker_side = SIDE_BID;
    f
}

/// A committed FillLog. `count` and `capacity` are written verbatim so a test
/// can forge the `count > capacity` state an ER could author.
fn fill_log_bytes(count: u16, capacity: u16, fills: &[FillEvent]) -> Vec<u8> {
    let mut d = vec![0u8; fill_log_account_size(capacity.max(FILL_LOG_CAPACITY))];
    {
        let h: &mut FillLogHeader = bytemuck::from_bytes_mut(&mut d[..FillLogHeader::LEN]);
        h.discriminator = DISC_FILL_LOG;
        h.bump = 255;
        h.market_index = MARKET_INDEX;
        h.epoch = EPOCH;
        h.capacity = capacity;
        h.count = count;
        h.head = 0;
    }
    for (i, f) in fills.iter().enumerate() {
        let off = FillLogHeader::LEN + i * FillEvent::LEN;
        d[off..off + FillEvent::LEN].copy_from_slice(bytemuck::bytes_of(f));
    }
    d
}

struct Fixture {
    program_id: Pubkey,
    party: Pubkey,
    market_pk: Pubkey,
    fl_pk: Pubkey,
    global_pk: Pubkey,
    user_pk: Pubkey,
    pos_pk: Pubkey,
}

fn fixture(program_id: Pubkey, party: Pubkey) -> Fixture {
    let (market_pk, _) =
        Pubkey::find_program_address(&[SEED_MARKET, &MARKET_INDEX.to_le_bytes()], &program_id);
    let (fl_pk, _) = Pubkey::find_program_address(
        &[SEED_FILL_LOG, &MARKET_INDEX.to_le_bytes(), &EPOCH.to_le_bytes()],
        &program_id,
    );
    let (global_pk, _) = Pubkey::find_program_address(&[SEED_GLOBAL], &program_id);
    let (user_pk, _) =
        Pubkey::find_program_address(&[SEED_USER, party.as_ref()], &program_id);
    let (pos_pk, _) = Pubkey::find_program_address(
        &[SEED_POSITION, party.as_ref(), &MARKET_INDEX.to_le_bytes()],
        &program_id,
    );
    Fixture { program_id, party, market_pk, fl_pk, global_pk, user_pk, pos_pk }
}

impl Fixture {
    fn accounts(
        &self,
        mk: Market,
        log: Vec<u8>,
        free_collateral: u64,
        reserved_margin: u64,
        pending_fills: u16,
    ) -> Vec<(Pubkey, Account)> {
        let mut g = GlobalState::zeroed();
        g.discriminator = DISC_GLOBAL_STATE;
        g.market_count = 1;

        let mut u = UserAccount::zeroed();
        u.discriminator = DISC_USER_ACCOUNT;
        u.owner = self.party.to_bytes();
        u.free_collateral = free_collateral;
        u.pending_fills = pending_fills;
        // POST-FIX FIELD NAME (pre-fix: `reserved_margin`).
        u.reserved_margin = reserved_margin;

        let mut p = Position::zeroed();
        p.discriminator = DISC_POSITION;
        p.owner = self.party.to_bytes();
        p.market_index = MARKET_INDEX;

        vec![
            (self.market_pk, pa(&self.program_id, bytemuck::bytes_of(&mk).to_vec())),
            (self.fl_pk, pa(&self.program_id, log)),
            (self.global_pk, pa(&self.program_id, bytemuck::bytes_of(&g).to_vec())),
            (self.user_pk, pa(&self.program_id, bytemuck::bytes_of(&u).to_vec())),
            (self.pos_pk, pa(&self.program_id, bytemuck::bytes_of(&p).to_vec())),
        ]
    }

    fn ix(&self, num_fills: u16) -> Instruction {
        let mut data = vec![IX_SETTLE_FROM_LOG];
        data.extend_from_slice(&MARKET_INDEX.to_le_bytes());
        data.extend_from_slice(&EPOCH.to_le_bytes());
        data.extend_from_slice(&num_fills.to_le_bytes());
        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(self.market_pk, false),
                AccountMeta::new_readonly(self.fl_pk, false),
                AccountMeta::new_readonly(self.global_pk, false),
                AccountMeta::new(self.user_pk, false),
                AccountMeta::new(self.pos_pk, false),
            ],
            data,
        }
    }
}

fn cursor_of(acc: &Account) -> u64 {
    let mk: &Market = bytemuck::from_bytes(&acc.data[..Market::LEN]);
    mk.last_settled_sequence()
}

/// `S4-01`. A log holding sequences {1, 2, 5} with `last_settled = 0` must
/// leave the cursor at 2 — the end of the contiguous prefix — not jump to 5 and
/// orphan 3 and 4 forever.
#[test]
fn test_settle_from_log_stops_at_sequence_gap() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let party = Pubkey::new_unique();
    let f = fixture(program_id, party);

    let margin = QTY / MAX_LEVERAGE as u64;
    let fills = [fill(1, &party, margin), fill(2, &party, margin), fill(5, &party, margin)];
    let log = fill_log_bytes(3, FILL_LOG_CAPACITY, &fills);

    let accounts = f.accounts(market(0), log, 1_000_000_000, 1_000_000_000, 3);
    let res = m.process_instruction(&f.ix(10), &accounts);
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);

    assert_eq!(
        cursor_of(&res.resulting_accounts[0].1),
        2,
        "the cursor must stop at the end of the contiguous run; jumping to 5 orphans 3 and 4 forever"
    );
}

/// `S4-07`. A committed header with `capacity = 2` and `count = 100` replays the
/// two stored fills fifty times, minting `Position.collateral` each pass.
#[test]
fn test_settle_from_log_rejects_count_above_capacity() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let party = Pubkey::new_unique();
    let f = fixture(program_id, party);

    let margin = QTY / MAX_LEVERAGE as u64;
    let fills = [fill(1, &party, margin), fill(2, &party, margin)];
    let log = fill_log_bytes(100, 2, &fills);

    let accounts = f.accounts(market(0), log, 1_000_000_000, 1_000_000_000, 2);
    let res = m.process_instruction(&f.ix(100), &accounts);

    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "settle_from_log accepted count(100) > capacity(2) — S4-07's replay: {:?}",
        res.program_result
    );
    let pos: &Position = bytemuck::from_bytes(&res.resulting_accounts[4].1.data[..Position::LEN]);
    assert_eq!(pos.collateral, 0, "no collateral may be minted by a replayed batch");
}

/// `S4-06`. A forged `filled_margin` far above the leverage bound for the
/// fill's own quantity and price must be rejected, not credited verbatim.
#[test]
fn test_settle_rejects_filled_margin_above_leverage_bound() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let party = Pubkey::new_unique();
    let f = fixture(program_id, party);

    // The honest bound is notional / max_leverage. Forge 1000x that.
    let honest = QTY / MAX_LEVERAGE as u64;
    let forged = honest.saturating_mul(1_000);
    let fills = [fill(1, &party, forged)];
    let log = fill_log_bytes(1, FILL_LOG_CAPACITY, &fills);

    let accounts = f.accounts(market(0), log, 1_000_000_000, 1_000_000_000, 1);
    let res = m.process_instruction(&f.ix(1), &accounts);

    assert!(
        !matches!(res.program_result, MolluskResult::Success),
        "settle_from_log applied an ER-forged filled_margin verbatim: {:?}",
        res.program_result
    );
    let pos: &Position = bytemuck::from_bytes(&res.resulting_accounts[4].1.data[..Position::LEN]);
    assert!(
        pos.collateral < forged,
        "Position.collateral was credited with value nothing debited: {}",
        pos.collateral
    );
}

/// Decision 3's third transition. Settling an honest fill must lower the credit
/// ledger by the margin it applied — without this the ceiling degrades from
/// exact conservation to "each user may extract their own realised losses".
#[test]
fn test_settlement_debits_reserved_margin() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let party = Pubkey::new_unique();
    let f = fixture(program_id, party);

    let margin = QTY / MAX_LEVERAGE as u64;
    const LEDGER: u64 = 1_000_000_000;
    let fills = [fill(1, &party, margin)];
    let log = fill_log_bytes(1, FILL_LOG_CAPACITY, &fills);

    let accounts = f.accounts(market(0), log, 1_000_000_000, LEDGER, 1);
    let res = m.process_instruction(&f.ix(1), &accounts);
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);

    let u: &UserAccount =
        bytemuck::from_bytes(&res.resulting_accounts[3].1.data[..UserAccount::LEN]);
    // Both legs are the same party, so both legs debit: 2 * margin.
    assert_eq!(
        u.reserved_margin,
        LEDGER - 2 * margin,
        "settlement must debit reserved_margin by the filled_margin it applied to each leg"
    );
}

/// The cursor is stored as a u32 (`Market::_padding2[0..4]`) while
/// `FillEvent.sequence` is a u64. A sequence above `u32::MAX` truncates on
/// write, moving the cursor BACKWARDS and re-opening the replay the contiguity
/// rule exists to close. Reject out-of-range sequences.
#[test]
fn test_settle_rejects_sequence_above_cursor_range() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let party = Pubkey::new_unique();
    let f = fixture(program_id, party);

    let margin = QTY / MAX_LEVERAGE as u64;
    // last_settled = 10; the forged sequence truncates to 11 on write.
    let forged_seq: u64 = (1u64 << 32) + 11;
    let fills = [fill(forged_seq, &party, margin)];
    let log = fill_log_bytes(1, FILL_LOG_CAPACITY, &fills);

    let accounts = f.accounts(market(10), log, 1_000_000_000, 1_000_000_000, 1);
    let res = m.process_instruction(&f.ix(1), &accounts);

    if matches!(res.program_result, MolluskResult::Success) {
        let cursor = cursor_of(&res.resulting_accounts[0].1);
        panic!(
            "settle_from_log accepted sequence {} and truncated the cursor to {} — \
             the contiguous-prefix rule is defeated by any sequence above u32::MAX",
            forged_seq, cursor
        );
    }
}

// ---------------------------------------------------------------------------
// F1 / F2 — defects introduced by the R4+R5 remediation wave.
//
// New tests only. Nothing above this line is touched: `tests/unit/src/lib.rs`
// is frozen, so a new module cannot be declared and these live beside the R4
// fixtures they reuse.
// ---------------------------------------------------------------------------

/// **F1.** The `filled_margin > fill_notional` bound R4 shipped is RELATIONAL:
/// `fill_notional = compute_notional(fill.quantity, fill.price)` is computed
/// from ER-authored quantity and price and is bounded only by `u64::MAX`. The
/// absolute bound was supposed to come from the L1 debit, but that debit is
/// `reserved_margin.saturating_sub(filled_margin)` and CANNOT FAIL — so a user
/// who funded 0.10 USDC can have a fill stamped at 10.00 USDC of margin, watch
/// the ledger saturate to zero, and end up with 200x what L1 ever recorded
/// going in. `close_position` then releases it into `free_collateral` and
/// `withdraw_collateral`'s gate 2 passes *because* the mint zeroed the ledger.
///
/// The invariant: a user's total claim on the vault after settlement can never
/// exceed what `fund_trading_credit` recorded. Both legs are the same party, so
/// this fixture holds the whole claim in three fields.
#[test]
fn test_settlement_cannot_credit_more_margin_than_the_ledger_backs() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let party = Pubkey::new_unique();
    let f = fixture(program_id, party);

    // Every atom L1 ever saw: `fund_trading_credit` is the ledger's sole raiser.
    const FUNDED: u64 = 100_000; // 0.10 USDC
    // compute_notional(QTY, PRICE) = 10_000_000, so this clears the RELATIONAL
    // bound exactly while being 100x what was funded.
    let forged: u64 = 10_000_000;

    let fills = [fill(1, &party, forged)];
    let log = fill_log_bytes(1, FILL_LOG_CAPACITY, &fills);

    // free_collateral starts at 0 so the whole post-state is attributable.
    let accounts = f.accounts(market(0), log, 0, FUNDED, 2);
    let res = m.process_instruction(&f.ix(1), &accounts);
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);

    let u: &UserAccount =
        bytemuck::from_bytes(&res.resulting_accounts[3].1.data[..UserAccount::LEN]);
    let pos: &Position = bytemuck::from_bytes(&res.resulting_accounts[4].1.data[..Position::LEN]);

    let claim = pos.collateral as u128 + u.free_collateral as u128 + u.reserved_margin as u128;
    assert!(
        claim <= FUNDED as u128,
        "settlement created value: total claim {} against a credit ledger of {} \
         (position {}, free {}, ledger {}) — the vault pays the difference",
        claim,
        FUNDED,
        pos.collateral,
        u.free_collateral,
        u.reserved_margin,
    );
}

/// **F2.** R4 made `settle_from_log` stop at the first sequence gap and write
/// only the prefix maximum, but it reports NOTHING — no log, no return data. So
/// a keeper that submits a window of 3 and settles 1 cannot tell, and R5's
/// per-(fill, side) `pending_fills` bump for the whole window leaves
/// `2 x (window - settled)` permanently outstanding on every partial settle
/// while the keeper's own cursor jumps to the window max and skips the
/// remainder forever. Settlement must publish what it actually settled.
///
/// Log {1, 2, 5} with the cursor at 0: two settle, the third does not.
#[test]
fn test_settle_from_log_reports_what_it_actually_settled() {
    let program_id = Pubkey::new_unique();
    let m = mollusk(&program_id);
    let party = Pubkey::new_unique();
    let f = fixture(program_id, party);

    let margin = QTY / MAX_LEVERAGE as u64;
    let fills = [fill(1, &party, margin), fill(2, &party, margin), fill(5, &party, margin)];
    let log = fill_log_bytes(3, FILL_LOG_CAPACITY, &fills);

    let accounts = f.accounts(market(0), log, 1_000_000_000, 1_000_000_000, 6);
    let res = m.process_instruction(&f.ix(10), &accounts);
    assert!(matches!(res.program_result, MolluskResult::Success), "{:?}", res.program_result);

    // 10 bytes: settled count (u16 LE) then the resulting cursor (u64 LE).
    assert_eq!(
        res.return_data.len(),
        10,
        "settle_from_log published no return data, so a caller that asked for 3 fills \
         cannot learn that only 2 settled: {:?}",
        res.return_data
    );
    let settled = u16::from_le_bytes([res.return_data[0], res.return_data[1]]);
    let cursor = u64::from_le_bytes(res.return_data[2..10].try_into().unwrap());
    assert_eq!(settled, 2, "the batch asked for 3 and settled 2; it must say so");
    assert_eq!(cursor, 2, "the reported cursor must be the one actually written");
    assert_eq!(cursor, cursor_of(&res.resulting_accounts[0].1), "reported cursor must match chain");
}
