use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::Pubkey,
    seeds,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::error::SlipstreamError;
use crate::state::{
    Position, TriggerOrder, DISC_TRIGGER_ORDER, SEED_TRIGGER, TRIGGER_KIND_STOP_LOSS,
    TRIGGER_KIND_TAKE_PROFIT,
};

/// place_trigger (disc 0x22): create or replace an SL/TP trigger for the
/// owner's position on a market. One trigger per (owner, market, kind); calling
/// again with the same kind updates the price/direction in place.
///
/// Accounts:
///   [0] trigger        (W, PDA ["trigger", owner, market_index_le, [kind]])
///   [1] position       (R) — must be the owner's non-empty position
///   [2] owner          (signer, payer, W)
///   [3] system_program
///
/// Instruction data:
///   market_index:  u16
///   kind:          u8   (0 = stop-loss, 1 = take-profit)
///   trigger_above: u8   (1 = fire when mark >= price, 0 = when mark <= price)
///   trigger_price: u64  (PRICE_SCALE, > 0)
const IX_DATA_LEN: usize = 2 + 1 + 1 + 8;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [trigger_acc, position_acc, owner, system_program, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index = u16::from_le_bytes([data[0], data[1]]);
    let kind = data[2];
    let trigger_above = data[3];
    let trigger_price = u64::from_le_bytes(data[4..12].try_into().unwrap());

    if kind != TRIGGER_KIND_STOP_LOSS && kind != TRIGGER_KIND_TAKE_PROFIT {
        return Err(ProgramError::InvalidInstructionData);
    }
    if trigger_above > 1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if trigger_price == 0 {
        return Err(SlipstreamError::InvalidOrderPrice.into());
    }

    // The trigger closes this position; require it to exist, belong to the
    // signer, be on the named market, and be non-empty.
    let pos = Position::from_account_info(position_acc)?;
    if pos.owner != *owner.key() {
        return Err(SlipstreamError::InvalidAuthority.into());
    }
    if pos.market_index != market_index {
        return Err(SlipstreamError::InvalidMarketIndex.into());
    }
    if pos.is_empty() {
        return Err(SlipstreamError::PositionNotFound.into());
    }

    let market_index_bytes = market_index.to_le_bytes();
    let kind_bytes = [kind];
    let (expected_pda, bump) = pinocchio::pubkey::find_program_address(
        &[SEED_TRIGGER, owner.key().as_ref(), &market_index_bytes, &kind_bytes],
        program_id,
    );
    if trigger_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let now = Clock::get()?.unix_timestamp;

    if trigger_acc.data_is_empty() {
        if system_program.key() != &pinocchio_system::ID {
            return Err(ProgramError::IncorrectProgramId);
        }
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(TriggerOrder::LEN);
        let bump_bytes = [bump];
        let signer_seeds = seeds![
            SEED_TRIGGER,
            owner.key().as_ref(),
            &market_index_bytes,
            &kind_bytes,
            &bump_bytes
        ];

        CreateAccount {
            from: owner,
            to: trigger_acc,
            lamports,
            space: TriggerOrder::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[Signer::from(&signer_seeds)])?;
    } else {
        // Updating in place: the PDA seeds bind it to (owner, market, kind), so
        // only the discriminator needs re-checking.
        let existing = TriggerOrder::from_account_info(trigger_acc)?;
        if existing.owner != *owner.key() {
            return Err(SlipstreamError::InvalidAuthority.into());
        }
    }

    let trigger = TriggerOrder::from_account_info_mut_or_init(trigger_acc)?;
    trigger.discriminator = DISC_TRIGGER_ORDER;
    trigger.bump = bump;
    trigger.kind = kind;
    trigger.trigger_above = trigger_above;
    trigger.market_index = market_index;
    trigger._padding = [0u8; 2];
    trigger.owner = *owner.key();
    trigger.trigger_price = trigger_price;
    trigger.created_ts = now;

    Ok(())
}
