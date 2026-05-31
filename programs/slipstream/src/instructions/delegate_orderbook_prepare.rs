use pinocchio::{
    account_info::{AccountInfo, MAX_PERMITTED_DATA_INCREASE},
    instruction::Signer,
    program_error::ProgramError,
    pubkey::Pubkey,
    seeds,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::error::SlipstreamError;
use crate::state::{GlobalState, OrderBookHeader, DISC_ORDER_BOOK, SEED_DELEGATE_BUFFER, SEED_ORDERBOOK};

/// delegate_orderbook_prepare instruction data: market_index: u16
const IX_DATA_LEN: usize = 2;

/// Stage the OrderBook's data into the MagicBlock delegation **buffer** PDA, one
/// CPI-cap-sized chunk (<= [`MAX_PERMITTED_DATA_INCREASE`]) per call.
///
/// ## Why this exists
///
/// MagicBlock delegation moves the delegated account through a temporary buffer
/// PDA: the owner program copies the account data into the buffer, zeroes and
/// reassigns the account to the delegation program, then the delegation program
/// copies the buffer back into the (now-delegation-owned) account via a
/// length-matched `copy_from_slice`. The SDK's one-shot `delegate_account`
/// creates that buffer at the FULL account size in a single System `CreateAccount`
/// CPI.
///
/// The OrderBook is ~612 KB, and Solana caps account-data growth inside an inner
/// instruction (CPI) at [`MAX_PERMITTED_DATA_INCREASE`] = 10,240 bytes — the same
/// limit that forced `initialize_market` + `grow_orderbook` to allocate the book
/// in chunks. A one-shot full-size buffer `CreateAccount` therefore fails on real
/// chain. This instruction builds the buffer incrementally instead:
///
///   - First call: create the buffer PDA (`[b"buffer", order_book]` under THIS
///     program — matching the delegation program's expected derivation) pre-funded
///     for the FULL buffer rent, with an initial chunk (<= cap) of space, and copy
///     the matching OrderBook slice into it.
///   - Subsequent calls: resize the buffer up by one chunk and copy the next
///     OrderBook slice into the freshly grown region.
///
/// Idempotent: once the buffer equals the OrderBook size and is fully populated,
/// this is a clean no-op. MUST run to completion BEFORE `delegate_orderbook`,
/// which consumes the buffer and reassigns the OrderBook to the delegation program.
///
/// Accounts:
///   [0] payer          (signer, writable) — funds the buffer rent; must equal GlobalState.authority
///   [1] order_book     (read)             — the OrderBook PDA whose data is staged
///   [2] delegate_buffer(writable)         — `[b"buffer", order_book]` under this program
///   [3] global_state   (read)             — authority gate
///   [4] system_program (read)
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [payer, order_book_acc, buffer_acc, global_state_acc, system_program, _remaining @ ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system_program.key() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Authority gate — same pattern as the other admin instructions.
    let global = GlobalState::from_account_info(global_state_acc)?;
    if global.authority != *payer.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index = u16::from_le_bytes([data[0], data[1]]);
    let market_index_bytes = market_index.to_le_bytes();

    // Validate the OrderBook PDA the same way initialize_market does.
    let (orderbook_pda, _ob_bump) =
        pinocchio::pubkey::find_program_address(&[SEED_ORDERBOOK, &market_index_bytes], program_id);
    if order_book_acc.key() != &orderbook_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    // The OrderBook must still be owned by this program (i.e. not yet delegated)
    // and at its full target size (grow_orderbook already ran).
    if !order_book_acc.is_owned_by(program_id) {
        return Err(SlipstreamError::InvalidProgramId.into());
    }

    let ob_len = order_book_acc.data_len();
    {
        let ob_data = unsafe { order_book_acc.borrow_data_unchecked() };
        if ob_data.len() < OrderBookHeader::LEN || ob_data[0] != DISC_ORDER_BOOK {
            return Err(ProgramError::InvalidAccountData);
        }
        let header: &OrderBookHeader = bytemuck::from_bytes(&ob_data[..OrderBookHeader::LEN]);
        let target = OrderBookHeader::compute_account_size(
            header.max_order_slots,
            header.max_price_levels_per_side,
            header.max_fill_events,
        );
        // The buffer must be exactly the OrderBook's data length (the delegation
        // program does a length-matched copy back), so require the book to be at
        // its full size before staging begins.
        if ob_len != target {
            return Err(ProgramError::InvalidAccountData);
        }
    }

    // Derive + validate the delegate buffer PDA under THIS program.
    let (buffer_pda, buffer_bump) = pinocchio::pubkey::find_program_address(
        &[SEED_DELEGATE_BUFFER, order_book_acc.key().as_ref()],
        program_id,
    );
    if buffer_acc.key() != &buffer_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let rent = Rent::get()?;
    let buffer_bump_bytes = [buffer_bump];
    let buffer_seeds = seeds![
        SEED_DELEGATE_BUFFER,
        order_book_acc.key().as_ref(),
        &buffer_bump_bytes
    ];

    // Determine the buffer's current length, creating it on first call.
    let current_len = if buffer_acc.data_is_empty() && buffer_acc.lamports() == 0 {
        // Create the buffer PDA: pre-fund the FULL rent up front (so later resizes
        // need no extra lamport transfers), but allocate only an initial chunk
        // (<= the CPI growth cap).
        let initial_space = core::cmp::min(ob_len, MAX_PERMITTED_DATA_INCREASE);
        let buffer_lamports = rent.minimum_balance(ob_len);
        CreateAccount {
            from: payer,
            to: buffer_acc,
            lamports: buffer_lamports,
            space: initial_space as u64,
            owner: program_id,
        }
        .invoke_signed(&[Signer::from(&buffer_seeds)])?;
        initial_space
    } else {
        // Already exists (a prior prepare call). It must be owned by this program.
        if !buffer_acc.is_owned_by(program_id) {
            return Err(SlipstreamError::InvalidProgramId.into());
        }
        let len = buffer_acc.data_len();
        // Grow by one chunk toward the full OrderBook size if not yet full.
        if len < ob_len {
            let next_len = core::cmp::min(len + MAX_PERMITTED_DATA_INCREASE, ob_len);
            buffer_acc.resize(next_len)?;
            next_len
        } else {
            len
        }
    };

    // Copy the OrderBook bytes [0, current_len) into the buffer. We re-copy the
    // whole populated prefix each call (cheap relative to the resize), which keeps
    // the buffer an exact mirror of the OrderBook regardless of call ordering and
    // makes the step fully idempotent.
    {
        let ob_data = unsafe { order_book_acc.borrow_data_unchecked() };
        let buf_data = unsafe { buffer_acc.borrow_mut_data_unchecked() };
        let n = core::cmp::min(current_len, buf_data.len());
        buf_data[..n].copy_from_slice(&ob_data[..n]);
    }

    Ok(())
}
