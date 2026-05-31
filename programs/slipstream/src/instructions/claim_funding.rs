use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::SlipstreamError;
use crate::math::funding::compute_funding_payment;
use crate::state::{Market, Position, UserAccount};

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [
        market_acc,
        position_acc,
        user_account_acc,
        owner,
        _remaining @ ..
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if market_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    let market = Market::from_account_info(market_acc)?;
    let pos = Position::from_account_info(position_acc)?;

    if pos.owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }
    if pos.is_empty() {
        return Err(SlipstreamError::PositionNotFound.into());
    }

    // Compute funding payment since last snapshot
    let payment = compute_funding_payment(
        pos.size,
        market.get_cumulative_funding_index(),
        pos.get_funding_index_snapshot(),
    )?;

    // Update position snapshot
    let pos_mut = Position::from_account_info_mut(position_acc)?;
    pos_mut.set_funding_index_snapshot(market.get_cumulative_funding_index());

    // Apply funding to user's collateral
    let user = UserAccount::from_account_info(user_account_acc)?;
    if user.owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    let user_mut = UserAccount::from_account_info_mut(user_account_acc)?;
    if payment >= 0 {
        user_mut.free_collateral = user_mut
            .free_collateral
            .checked_add(payment as u64)
            .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
    } else {
        let abs_payment = (-payment) as u64;
        if user_mut.free_collateral >= abs_payment {
            user_mut.free_collateral -= abs_payment;
        } else {
            // Deduct from position collateral if free is insufficient
            let shortfall = abs_payment - user_mut.free_collateral;
            user_mut.free_collateral = 0;
            let pos_mut2 = Position::from_account_info_mut(position_acc)?;
            pos_mut2.collateral = pos_mut2.collateral.saturating_sub(shortfall);
        }
    }

    Ok(())
}
