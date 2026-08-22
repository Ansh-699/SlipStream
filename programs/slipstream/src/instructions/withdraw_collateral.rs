use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::Pubkey,
    seeds,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};
use pinocchio_token::instructions::Transfer;

use crate::error::SlipstreamError;
use crate::state::{
    GlobalState, Market, Position, UserAccount, SEED_GLOBAL, SEED_POSITION, SEED_VAULT_AUTHORITY,
};

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // Required accounts:
    //   user_account, owner (signer), quote_vault, user_token_acc, vault_authority,
    //   token_program, market, global_state, then exactly `market_count` Position
    //   PDAs (one per market index, in order) — MANDATORY, not optional: the
    //   same-slot flash guard below must not be bypassable by simply omitting
    //   Position accounts (the exact gap close_user_account.rs also closed).
    let [
        user_account_acc,
        owner,
        quote_vault_acc,
        user_token_acc,
        vault_authority_acc,
        _token_program,
        market_acc,
        global_state_acc,
        positions @ ..
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Pin the source vault to a real, registered market vault — without this the
    // caller can name any token account it controls as `quote_vault_acc`, and as
    // long as its SPL authority also happens to be the (market-agnostic)
    // vault_authority PDA, tokens meant to back a DIFFERENT market's collateral
    // could be drained here. Mirrors deposit_collateral.rs's vault pin.
    if market_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    {
        let market = Market::from_account_info(market_acc)?;
        if quote_vault_acc.key() != &market.quote_vault {
            return Err(SlipstreamError::InvalidVault.into());
        }
    }

    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount = u64::from_le_bytes(data[..8].try_into().unwrap());
    if amount == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    if user_account_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let user = UserAccount::from_account_info(user_account_acc)?;
    if user.owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    // Gate 1: no unsettled fills
    if user.pending_fills > 0 {
        return Err(SlipstreamError::PendingFillsExist.into());
    }
    // Gate 2: no collateral parked in a trading credit. Dead until the credit
    // ledger went live; now it means "withdraw your credit first". If it refuses
    // while the user has no credit left to withdraw, the ledger is stale and
    // `seed_credit_ledger` is the repair path (spec Decision 4b).
    if user.reserved_margin > 0 {
        return Err(SlipstreamError::ReservedMarginExists.into());
    }
    // Gate 3: sufficient free
    if user.free_collateral < amount {
        return Err(SlipstreamError::InsufficientCollateral.into());
    }

    // Gate 4 (§15): same-slot guard — a user who opened a position THIS slot must
    // not also withdraw this slot. Every market's Position PDA is mandatory (not
    // scanned from optional trailing accounts): an optional scan is trivially
    // bypassed by simply not passing the account.
    if global_state_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (global_pda, _) = pinocchio::pubkey::find_program_address(&[SEED_GLOBAL], program_id);
    if global_state_acc.key() != &global_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }
    let market_count = GlobalState::from_account_info(global_state_acc)?.market_count;

    let clock = Clock::get()?;
    let now_slot = clock.slot;
    if positions.len() < market_count as usize {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    for (i, pos_acc) in positions.iter().take(market_count as usize).enumerate() {
        let market_index = i as u16;
        let (expected_pda, _) = pinocchio::pubkey::find_program_address(
            &[SEED_POSITION, owner.key().as_ref(), &market_index.to_le_bytes()],
            program_id,
        );
        if pos_acc.key() != &expected_pda {
            return Err(SlipstreamError::InvalidPda.into());
        }
        // Never created on this market — nothing to check.
        if pos_acc.data_is_empty() {
            continue;
        }
        let pos = Position::from_account_info(pos_acc)?;
        if pos.open_slot == now_slot {
            return Err(SlipstreamError::SameSlotWithdrawal.into());
        }
    }

    let (vault_auth_pda, vault_auth_bump) = pinocchio::pubkey::find_program_address(
        &[SEED_VAULT_AUTHORITY],
        program_id,
    );
    if vault_authority_acc.key() != &vault_auth_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let vault_auth_bump_bytes = [vault_auth_bump];
    let signer_seeds = seeds![SEED_VAULT_AUTHORITY, &vault_auth_bump_bytes];
    Transfer {
        from: quote_vault_acc,
        to: user_token_acc,
        authority: vault_authority_acc,
        amount,
    }
    .invoke_signed(&[Signer::from(&signer_seeds)])?;

    let user_mut = UserAccount::from_account_info_mut(user_account_acc)?;
    user_mut.free_collateral = user_mut
        .free_collateral
        .checked_sub(amount)
        .ok_or(ProgramError::from(SlipstreamError::MathUnderflow))?;

    Ok(())
}
