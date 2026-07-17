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
use crate::state::{
    GlobalState, Market, OrderBookHeader, OrderBookView,
    DISC_MARKET, DISC_ORDER_BOOK,
    SEED_MARKET, SEED_ORDERBOOK,
    DEFAULT_MAX_ORDER_SLOTS, DEFAULT_MAX_PRICE_LEVELS, DEFAULT_MAX_FILL_EVENTS,
    DEFAULT_ORDERS_PER_USER,
};

const IX_DATA_LEN: usize = 2 + 8 + 8 + 1 + 2 + 2 + 8 + 2 + 2 + 2;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [
        global_state_acc,
        market_acc,
        order_book_acc,
        quote_vault_acc,
        pyth_feed_acc,
        switchboard_feed_acc,
        authority,
        system_program,
        _remaining @ ..
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system_program.key() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let global = GlobalState::from_account_info(global_state_acc)?;
    if global.authority != *authority.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index = u16::from_le_bytes([data[0], data[1]]);
    let tick_size = u64::from_le_bytes(data[2..10].try_into().unwrap());
    let lot_size = u64::from_le_bytes(data[10..18].try_into().unwrap());
    let max_leverage = data[18];
    let taker_fee_bps = u16::from_le_bytes([data[19], data[20]]);
    let maker_rebate_bps = u16::from_le_bytes([data[21], data[22]]);
    let funding_interval = u64::from_le_bytes(data[23..31].try_into().unwrap());
    let max_order_slots_raw = u16::from_le_bytes([data[31], data[32]]);
    let max_price_levels_raw = u16::from_le_bytes([data[33], data[34]]);
    let max_fill_events_raw = u16::from_le_bytes([data[35], data[36]]);

    let max_order_slots = if max_order_slots_raw == 0 { DEFAULT_MAX_ORDER_SLOTS } else { max_order_slots_raw };
    let max_price_levels = if max_price_levels_raw == 0 { DEFAULT_MAX_PRICE_LEVELS } else { max_price_levels_raw };
    let max_fill_events = if max_fill_events_raw == 0 { DEFAULT_MAX_FILL_EVENTS } else { max_fill_events_raw };

    if tick_size == 0 || lot_size == 0 || max_leverage == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let market_index_bytes = market_index.to_le_bytes();
    let (market_pda, market_bump) = pinocchio::pubkey::find_program_address(
        &[SEED_MARKET, &market_index_bytes],
        program_id,
    );
    if market_acc.key() != &market_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let (orderbook_pda, orderbook_bump) = pinocchio::pubkey::find_program_address(
        &[SEED_ORDERBOOK, &market_index_bytes],
        program_id,
    );
    if order_book_acc.key() != &orderbook_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    if !market_acc.data_is_empty() {
        return Err(SlipstreamError::AccountAlreadyInitialized.into());
    }
    if !order_book_acc.data_is_empty() {
        return Err(SlipstreamError::AccountAlreadyInitialized.into());
    }

    let rent = Rent::get()?;

    let market_bump_bytes = [market_bump];
    let market_seeds = seeds![SEED_MARKET, &market_index_bytes, &market_bump_bytes];
    let market_lamports = rent.minimum_balance(Market::LEN);
    CreateAccount {
        from: authority,
        to: market_acc,
        lamports: market_lamports,
        space: Market::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&market_seeds)])?;

    let orderbook_size = OrderBookHeader::compute_account_size(
        max_order_slots,
        max_price_levels,
        max_fill_events,
    );
    // Solana caps account-data growth inside a CPI (System CreateAccount runs as an
    // inner instruction) at MAX_PERMITTED_DATA_INCREASE bytes. When the full book
    // exceeds that cap, create the account at an initial chunk (<= cap) but PRE-FUND
    // the full rent up front, so the later `grow_orderbook` reallocs need no extra
    // lamport transfers. When the full size already fits the cap (the small
    // capacities the unit tests use), keep the original one-shot behavior.
    let initial_space = core::cmp::min(orderbook_size, MAX_PERMITTED_DATA_INCREASE);
    let orderbook_bump_bytes = [orderbook_bump];
    let ob_seeds = seeds![SEED_ORDERBOOK, &market_index_bytes, &orderbook_bump_bytes];
    let orderbook_lamports = rent.minimum_balance(orderbook_size);
    CreateAccount {
        from: authority,
        to: order_book_acc,
        lamports: orderbook_lamports,
        space: initial_space as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&ob_seeds)])?;

    let market = Market::from_account_info_mut(market_acc)?;
    market.discriminator = DISC_MARKET;
    market.bump = market_bump;
    market.market_index = market_index;
    market.max_leverage = max_leverage;
    market.circuit_breaker_active = 0;
    market.taker_fee_bps = taker_fee_bps;
    market.maker_rebate_bps = maker_rebate_bps;
    market.twap_write_index = 0;
    market.twap_count = 0;
    market.base_mint = [0u8; 32];
    market.quote_mint = [0u8; 32];
    market.pyth_feed = *pyth_feed_acc.key();
    market.quote_vault = *quote_vault_acc.key();
    market.tick_size = tick_size;
    market.lot_size = lot_size;
    market.funding_interval_secs = funding_interval;
    market.last_funding_ts = 0;
    market.open_interest_long = 0;
    market.open_interest_short = 0;
    market.insurance_fund_balance = 0;
    market.last_mark_price = 0;
    // Holds the mark-price freshness stamp (see Market::mark_price_minute);
    // 0 = never stamped, consistent with last_mark_price = 0.
    market._padding1 = [0u8; 2];
    market.set_cumulative_funding_index(0);
    market.switchboard_feed = *switchboard_feed_acc.key();
    market.restricted_mode = 0;
    market.agreement_streak = 0;
    market._padding2 = [0u8; 6];

    let ob_data = unsafe { order_book_acc.borrow_mut_data_unchecked() };
    let ob_header: &mut OrderBookHeader = bytemuck::from_bytes_mut(&mut ob_data[..OrderBookHeader::LEN]);
    ob_header.discriminator = DISC_ORDER_BOOK;
    ob_header.bump = orderbook_bump;
    ob_header.market_index = market_index;
    ob_header.orders_per_user = DEFAULT_ORDERS_PER_USER;
    ob_header.max_order_slots = max_order_slots;
    ob_header.max_price_levels_per_side = max_price_levels;
    ob_header.max_fill_events = max_fill_events;
    ob_header.active_order_count = 0;
    ob_header.bid_level_count = 0;
    ob_header.ask_level_count = 0;
    ob_header.fill_event_head = 0;
    ob_header.fill_event_tail = 0;
    ob_header.fill_event_count = 0;
    ob_header.free_list_head = 0;
    ob_header.free_slot_count = max_order_slots;
    ob_header.next_order_id = 1;
    ob_header.next_fill_sequence = 1;

    // Only build the OrderBookView + init the free list when the account is already
    // at its full size. `OrderBookView::from_account_data` requires
    // `data.len() >= compute_account_size(..)`, so on the chunked path we DEFER both
    // until `grow_orderbook` finishes resizing the account to the full target.
    if orderbook_size <= initial_space {
        let mut ob_view = OrderBookView::from_account_data(ob_data)?;
        ob_view.init_free_list();
    }

    let global_mut = GlobalState::from_account_info_mut(global_state_acc)?;
    global_mut.market_count = global_mut
        .market_count
        .checked_add(1)
        .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;

    Ok(())
}
