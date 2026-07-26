use pinocchio::{
    account_info::{AccountInfo, MAX_PERMITTED_DATA_INCREASE},
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::{
    GlobalState, OrderBookHeader, OrderBookView, DISC_ORDER_BOOK, SEED_GLOBAL, SEED_ORDERBOOK,
};

/// grow_orderbook instruction data: market_index: u16
const IX_DATA_LEN: usize = 2;

/// Grow an OrderBook PDA toward its full target size, one CPI-cap-sized chunk
/// (<= [`MAX_PERMITTED_DATA_INCREASE`]) per call.
///
/// `initialize_market` creates the OrderBook account pre-funded for the FULL
/// rent but only allocates an initial chunk (because Solana caps account-data
/// growth at `MAX_PERMITTED_DATA_INCREASE` bytes inside the System
/// `CreateAccount` CPI). This instruction resizes the account upward — Solana
/// zero-initializes the newly added bytes — until it reaches the full size
/// derived from the header's capacities, then runs `init_free_list()` so the
/// book becomes usable.
///
/// Idempotent: once the account is at (or beyond) its full target size this is a
/// clean no-op. Must run BEFORE the orderbook is delegated — once the delegation
/// program owns the account it can no longer be resized here (the owner guard
/// below rejects that case).
///
/// Accounts:
///   [0] order_book      (writable) — the OrderBook PDA to grow
///   [1] global_state    (read)     — authority gate
///   [2] authority       (signer)   — must equal GlobalState.authority
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [order_book_acc, global_state_acc, authority, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Authority gate — same pattern as the other admin instructions. GlobalState
    // is only ever READ here, so a forged (attacker-owned) account is not caught
    // by the runtime's write protection — pin owner + PDA first.
    if global_state_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (global_pda, _) = pinocchio::pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    if global_state_acc.key() != &global_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    let global = GlobalState::from_account_info(global_state_acc)?;
    if global.authority != *authority.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index = u16::from_le_bytes([data[0], data[1]]);

    // Validate the OrderBook PDA the same way initialize_market does.
    let market_index_bytes = market_index.to_le_bytes();
    let (orderbook_pda, _bump) = pinocchio::pubkey::find_program_address(
        &[SEED_ORDERBOOK, &market_index_bytes],
        program_id,
    );
    if order_book_acc.key() != &orderbook_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    // The account must still be owned by this program. Once delegated, the
    // delegation program owns it and it can no longer be resized here.
    if !order_book_acc.is_owned_by(program_id) {
        return Err(SlipstreamError::InvalidProgramId.into());
    }

    // Read the header (always within the initial chunk) to compute the full
    // target size and confirm this is an initialized OrderBook.
    let target_size = {
        let ob_data = unsafe { order_book_acc.borrow_data_unchecked() };
        if ob_data.len() < OrderBookHeader::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if ob_data[0] != DISC_ORDER_BOOK {
            return Err(ProgramError::InvalidAccountData);
        }
        let header: &OrderBookHeader = bytemuck::from_bytes(&ob_data[..OrderBookHeader::LEN]);
        OrderBookHeader::compute_account_size(
            header.max_order_slots,
            header.max_price_levels_per_side,
            header.max_fill_events,
        )
    };

    let current_len = order_book_acc.data_len();

    // Idempotent no-op once fully grown.
    if current_len >= target_size {
        return Ok(());
    }

    // Grow by at most one CPI-cap-sized chunk toward the target.
    let next_len = core::cmp::min(current_len + MAX_PERMITTED_DATA_INCREASE, target_size);
    order_book_acc.resize(next_len)?;

    // When the account reaches its full size, initialize the free list so the
    // book is usable. Solana zero-inits the grown bytes, so all slots/levels are
    // already cleared; init_free_list chains the free slots and sets the counters.
    if next_len >= target_size {
        let ob_data = unsafe { order_book_acc.borrow_mut_data_unchecked() };
        let mut ob_view = OrderBookView::from_account_data(ob_data)?;
        ob_view.init_free_list();
    }

    Ok(())
}
